"""End-to-end production validation harness (Part 2 readiness).

Drives the REAL pipeline components across the required scenarios and prints a pass/fail matrix:
XML invoice, JSON e-invoice, digital PDF, scanned PDF (OCR), duplicate, invalid GSTIN,
invalid arithmetic, manual-review routing, and search over the store.

Run: python scripts/production_validation.py
Exit code is non-zero if any scenario fails, so it doubles as a CI gate.
"""

from __future__ import annotations

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz
from PIL import Image, ImageDraw, ImageFont

from canonical import CanonicalBuilder
from dedup import InvoiceDeduper
from doctype.models import DocumentType
from extraction.extractors import extract_json, extract_xml
from extraction.models import ExtractedContent
from extraction.ocr import TesseractOCRProvider
from fields import FieldExtractor
from storage.invoice_store import SqliteInvoiceStore, build_invoice_store
from storage.search import SearchQuery
from validation import InvoiceValidator

GSTIN = "27AABCU9603R1ZN"          # passes the real checksum
BAD_GSTIN = "27AABCU9603R1ZZ"      # fails the checksum

_JSON_INV = {
    "Irn": "irn-json-001",
    "DocDtls": {"No": "INV-JSON-001", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": GSTIN, "LglNm": "Acme Supplies Pvt Ltd"},
    "BuyerDtls": {"Gstin": "29AAGCR1234M1Z4", "LglNm": "Innovfix"},
    "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800},
    "ItemList": [{"HsnCd": "998314"}],
}

_XML_INV = (
    "<?xml version='1.0'?><Invoice>"
    "<Irn>irn-xml-001</Irn>"
    "<DocDtls><No>INV-XML-001</No><Dt>06/07/2026</Dt></DocDtls>"
    f"<SellerDtls><Gstin>{GSTIN}</Gstin><LglNm>Acme Supplies Pvt Ltd</LglNm></SellerDtls>"
    "<ValDtls><AssVal>10000</AssVal><CgstVal>900</CgstVal><SgstVal>900</SgstVal>"
    "<TotInvVal>11800</TotInvVal></ValDtls>"
    "</Invoice>"
).encode()

_fe = FieldExtractor()
_val = InvoiceValidator()
_build = CanonicalBuilder()


def _content(doc_id, filename, dtype, text="", structured=None):
    return ExtractedContent(doc_id, filename, dtype, "x", text, structured, 1.0, False, ())


def _process(content, deduper):
    fields = _fe.extract(content)
    validation = _val.validate(fields)
    dedup = deduper.register(content.doc_id, fields)
    return _build.build(content, fields, validation, dedup)


def _digital_pdf_text() -> str:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Tax Invoice\nInvoice No: INV-PDF-001\nInvoice Date: 06/07/2026\n"
                               f"GSTIN: {GSTIN}\nHSN: 998314\nTaxable Value: 10,000.00\n"
                               "CGST: 900.00 SGST: 900.00\nGrand Total: 11,800.00\n")
    data = doc.tobytes(); doc.close()
    with fitz.open(stream=data, filetype="pdf") as d:
        return "".join(p.get_text() for p in d)


def _scanned_pdf_ocr_text() -> tuple[str, float]:
    W, H = 900, 620
    img = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(img)
    def font(sz):
        try: return ImageFont.truetype("arial.ttf", sz)
        except Exception: return ImageFont.load_default()
    for t, y in [("TAX INVOICE", 20), ("Invoice No: INV-SCAN-001", 90), ("Invoice Date: 06/07/2026", 140),
                 (f"GSTIN: {GSTIN}", 190), ("Taxable Value: 10,000.00", 260),
                 ("CGST: 900.00   SGST: 900.00", 310), ("Grand Total: 11,800.00", 370)]:
        d.text((40, y), t, fill="black", font=font(28))
    buf = io.BytesIO(); img.save(buf, format="PNG")
    prov = TesseractOCRProvider(binary_path=r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    res = prov.image_to_text(buf.getvalue())
    return res.text, res.confidence


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))

    import os

    import yaml
    cfg_path = os.path.join("config", "storage.yaml")
    cfg = yaml.safe_load(open(cfg_path, encoding="utf-8")) if os.path.exists(cfg_path) else None
    store = build_invoice_store(cfg)         # configured production backend (Postgres, else SQLite)
    if hasattr(store, "clear"):
        store.clear()                        # clean slate for a deterministic validation run
    deduper = InvoiceDeduper()

    # 1. XML invoice
    text, structured = extract_xml(_XML_INV)
    rec = _process(_content("xml1", "inv.xml", DocumentType.XML_INVOICE, text, structured), deduper)
    store.upsert(rec)
    check("XML invoice", rec.status == "accepted" and rec.fields.get("vendor_gstin") == GSTIN,
          f"status={rec.status} gstin={rec.fields.get('vendor_gstin')}")

    # 2. JSON e-invoice
    import json as _json
    text, structured = extract_json(_json.dumps(_JSON_INV).encode())
    rec = _process(_content("json1", "inv.json", DocumentType.JSON_EINVOICE, text, structured), deduper)
    store.upsert(rec)
    check("JSON e-invoice", rec.status == "accepted" and rec.fields.get("total") == 11800.0,
          f"status={rec.status} total={rec.fields.get('total')}")

    # 3. Digital PDF
    rec = _process(_content("pdf1", "inv.pdf", DocumentType.DIGITAL_PDF, _digital_pdf_text()), deduper)
    store.upsert(rec)
    check("Digital PDF", rec.status == "accepted" and rec.fields.get("invoice_number") == "INV-PDF-001",
          f"status={rec.status} no={rec.fields.get('invoice_number')}")

    # 4. Scanned PDF (OCR)
    ocr_text, ocr_conf = _scanned_pdf_ocr_text()
    rec = _process(_content("scan1", "scan.pdf", DocumentType.SCANNED_PDF, ocr_text), deduper)
    store.upsert(rec)
    check("Scanned PDF (OCR)", rec.status == "accepted" and rec.fields.get("vendor_gstin") == GSTIN,
          f"status={rec.status} ocr_conf={ocr_conf:.2f} gstin={rec.fields.get('vendor_gstin')}")

    # 5. Duplicate invoice (same IRN as JSON one)
    dup_struct = dict(_JSON_INV)
    text, structured = extract_json(_json.dumps(dup_struct).encode())
    rec = _process(_content("json1_dup", "inv_copy.json", DocumentType.JSON_EINVOICE, text, structured), deduper)
    check("Duplicate invoice", rec.status == "duplicate" and rec.canonical_id == "json1",
          f"status={rec.status} canonical={rec.canonical_id}")

    # 6. Invalid GSTIN
    bad = {**_JSON_INV, "Irn": "irn-badgstin", "SellerDtls": {"Gstin": BAD_GSTIN, "LglNm": "X"}}
    rec = _process(_content("badg", "bad.json", DocumentType.JSON_EINVOICE, "", bad), deduper)
    check("Invalid GSTIN", rec.status == "needs_review" and any("GSTIN" in e for e in rec.validation["errors"]),
          f"status={rec.status} errors={rec.validation['errors']}")

    # 7. Invalid arithmetic
    wrong = {**_JSON_INV, "Irn": "irn-badmath",
             "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 99999}}
    rec = _process(_content("badm", "badmath.json", DocumentType.JSON_EINVOICE, "", wrong), deduper)
    check("Invalid arithmetic", rec.status == "needs_review" and any("total is" in e for e in rec.validation["errors"]),
          f"status={rec.status} errors={rec.validation['errors']}")

    # 8. Manual review (missing mandatory fields)
    minimal = {"SellerDtls": {"Gstin": GSTIN}}
    rec = _process(_content("min1", "minimal.json", DocumentType.JSON_EINVOICE, "", minimal), deduper)
    check("Manual review routing", rec.status == "needs_review" and rec.validation["needs_review"],
          f"status={rec.status} errors={len(rec.validation['errors'])}")

    # 9. Search over the store
    by_gstin = store.search(SearchQuery(vendor_gstin=GSTIN))
    by_text = store.search(SearchQuery(text="acme"))
    by_range = store.search(SearchQuery(min_total=1000, date_from="2026-01-01", date_to="2026-12-31"))
    check("Search", len(by_gstin) >= 3 and len(by_text) >= 1 and len(by_range) >= 3,
          f"by_gstin={len(by_gstin)} by_text={len(by_text)} by_range={len(by_range)}")

    backend = type(store).__name__
    store.close()

    print("=" * 68)
    print(f"PRODUCTION VALIDATION  --  storage backend: {backend}")
    print("=" * 68)
    passed = 0
    for name, ok, detail in results:
        tag = "PASS" if ok else "FAIL"
        passed += ok
        print(f"  [{tag}]  {name:<24} {detail}")
    print("-" * 68)
    print(f"  {passed}/{len(results)} scenarios passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
