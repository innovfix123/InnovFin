"""Tests for Content Extraction (Milestone 2.3) — deterministic stack, OCR guarded."""

import fitz  # PyMuPDF
import pytest

from attachments.models import AttachmentType
from core.config import ConfigError
from doctype.models import DocumentType
from documents.models import DocumentMetadata, DocumentRef
from extraction import ExtractionEngine
from extraction.ocr import build_ocr_provider

_XML = b"<?xml version='1.0'?><Invoice><Irn>abc</Irn><Total>11800</Total></Invoice>"
_JSON = b'{"Irn":"a1b2","SellerDtls":{"Gstin":"27AABCU9603R1ZM"},"ValDtls":{"TotInvVal":11800}}'
_BAD_JSON = b'{not valid json'


def _digital_pdf(text="Tax Invoice INV-501 GSTIN 27AABCU9603R1ZM Total 11800"):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


class _StubProvider:
    def __init__(self):
        self._docs = {}

    def add(self, doc_id, data, filename, atype, *, is_encrypted=False):
        self._docs[doc_id] = (
            data,
            DocumentMetadata(doc_id, filename, atype, "application/octet-stream",
                             len(data), is_encrypted, atype.is_structured, "msg-1"),
        )
        return DocumentRef(doc_id, filename, atype)

    def list_documents(self):
        return [DocumentRef(k, v[1].filename, v[1].attachment_type) for k, v in self._docs.items()]

    def open(self, ref):
        return self._docs[ref.doc_id if hasattr(ref, "doc_id") else ref][0]

    def metadata(self, ref):
        return self._docs[ref.doc_id if hasattr(ref, "doc_id") else ref][1]


def _engine(tmp_path=None):
    settings = {"ocr": {"provider": "tesseract", "min_confidence": 0.6}}
    if tmp_path is not None:
        settings["audit"] = {"path": str(tmp_path / "extraction.jsonl")}
    return ExtractionEngine.from_config(settings)


def _extract(data, filename, atype, dtype, **kw):
    p = _StubProvider()
    ref = p.add("d1", data, filename, atype, **kw)
    return _engine().extract(p, ref, dtype)


# -- deterministic paths (work today, no external deps) ---------------------

def test_xml_extraction():
    r = _extract(_XML, "e.xml", AttachmentType.XML, DocumentType.XML_INVOICE)
    assert r.method == "xml" and r.needs_review is False and r.confidence == 1.0
    assert r.structured["Invoice"]["Irn"] == "abc"
    assert "11800" in r.text


def test_json_extraction():
    r = _extract(_JSON, "e.json", AttachmentType.JSON_EINVOICE, DocumentType.JSON_EINVOICE)
    assert r.method == "json" and r.needs_review is False
    assert r.structured["SellerDtls"]["Gstin"] == "27AABCU9603R1ZM"


def test_email_body_extraction():
    # A body-only invoice (no attachment) is read as text so fields can be extracted from it.
    body = b"Tax Invoice\nInvoice No: INV-9\nGSTIN: 27AABCU9603R1ZN\nGrand Total: 11800.00"
    r = _extract(body, "x.body.txt", AttachmentType.EMAIL_BODY, DocumentType.TEXT_BODY)
    assert r.method == "body" and r.needs_review is False
    assert "INV-9" in r.text


def test_bad_json_goes_to_review():
    r = _extract(_BAD_JSON, "e.json", AttachmentType.JSON_EINVOICE, DocumentType.JSON_EINVOICE)
    assert r.needs_review is True and "error" in r.notes[0].lower()


def test_digital_pdf_extraction_via_pymupdf():
    r = _extract(_digital_pdf(), "inv.pdf", AttachmentType.PDF, DocumentType.DIGITAL_PDF)
    assert r.method == "pymupdf" and r.needs_review is False
    assert "Tax Invoice" in r.text and "GSTIN" in r.text


# -- OCR path (Tesseract) — guarded when the binary is absent ---------------

def test_scanned_pdf_without_tesseract_goes_to_review():
    # In this environment the Tesseract binary is not installed -> graceful manual review.
    r = _extract(_digital_pdf(), "scan.pdf", AttachmentType.PDF, DocumentType.SCANNED_PDF)
    if r.method == "tesseract" and not r.needs_review:
        pytest.skip("Tesseract is installed in this environment; skipping the 'unavailable' path")
    assert r.needs_review is True
    assert "unavailable" in r.notes[0].lower() or "tesseract" in r.notes[0].lower()


def test_image_routes_to_ocr():
    r = _extract(b"\xff\xd8\xff\xe0fake-jpeg", "a.jpg", AttachmentType.IMAGE, DocumentType.IMAGE_JPG)
    assert r.method in ("tesseract",) or r.needs_review  # OCR path (review if binary absent)


# -- unsupported / encrypted / archive -> review ----------------------------

def test_encrypted_pdf_goes_to_review():
    r = _extract(b"%PDF-1.6\n/Encrypt", "l.pdf", AttachmentType.PDF, DocumentType.ENCRYPTED_PDF)
    assert r.needs_review is True and r.method == "none"


def test_unsupported_goes_to_review():
    r = _extract(b"hello", "n.txt", AttachmentType.OTHER, DocumentType.UNSUPPORTED)
    assert r.needs_review is True


# -- config / audit ---------------------------------------------------------

def test_unknown_ocr_provider_raises():
    with pytest.raises(ConfigError):
        build_ocr_provider({"ocr": {"provider": "some_cloud_thing"}})


def test_audit_written(tmp_path):
    p = _StubProvider()
    ref = p.add("d1", _XML, "e.xml", AttachmentType.XML)
    _engine(tmp_path).extract(p, ref, DocumentType.XML_INVOICE)
    assert (tmp_path / "extraction.jsonl").exists()
