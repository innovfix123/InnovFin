"""Tests for deterministic field extraction (Milestone 2.4)."""

from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields import FieldExtractor

_INV01 = {
    "Irn": "a1b2c3",
    "DocDtls": {"No": "INV-2026-501", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": "27AABCU9603R1ZM", "LglNm": "Acme Supplies Pvt Ltd"},
    "BuyerDtls": {"Gstin": "29AAGCR1234M1Z5", "LglNm": "Innovfix Private Limited"},
    "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800},
    "ItemList": [{"HsnCd": "998314"}],
}

_TEXT = (
    "Tax Invoice\n"
    "Invoice No: INV-2026-777\n"
    "Invoice Date: 06/07/2026\n"
    "GSTIN: 27AABCU9603R1ZM\n"
    "HSN: 998314\n"
    "Taxable Value: 10,000.00\n"
    "CGST: 900.00  SGST: 900.00\n"
    "Grand Total: 11,800.00\n"
    "Due Date: 20/07/2026\n"
)


def _content(text="", structured=None, dtype=DocumentType.DIGITAL_PDF):
    return ExtractedContent("d1", "inv", dtype, "x", text, structured, 1.0, False, ())


def test_text_bare_date_and_no_decimal_amounts():
    # Real invoices often use a bare "Date" label and whole-number amounts (no decimals).
    f = FieldExtractor().extract(_content(
        "Tax Invoice No TEST-001 Date 07/07/2026\n"
        "GSTIN 27AABCU9603R1ZN\n"
        "Taxable 10000 CGST 900 SGST 900 Grand Total 11800"
    ))
    assert f.value("invoice_number") == "TEST-001"
    assert f.value("invoice_date") == "07/07/2026"
    assert f.value("taxable_value") == 10000.0
    assert f.value("cgst") == 900.0 and f.value("sgst") == 900.0
    assert f.value("total") == 11800.0


def test_text_month_name_date_and_date_of_issue_label():
    # Stripe/Anthropic-style: "Date of issue" label + "June 6, 2026" value on the next line.
    f = FieldExtractor().extract(_content(
        "Invoice number\n5CR0HBCL-0004\nDate of issue\nJune 6, 2026\nAmount due 100.00"
    ))
    assert f.value("invoice_number") == "5CR0HBCL-0004"
    assert f.value("invoice_date") == "June 6, 2026"
    assert f.value("total") == 100.0


def test_tax_rate_percentage_is_not_captured_as_amount():
    # "CGST 9% 900.00" must yield the amount 900, never the 9% rate.
    f = FieldExtractor().extract(_content("CGST 9% 900.00  SGST 9% 900.00  Grand Total 11800"))
    assert f.value("cgst") == 900.0
    assert f.value("sgst") == 900.0
    assert f.value("total") == 11800.0


def test_structured_json_mapping():
    f = FieldExtractor().extract(_content(structured=_INV01, dtype=DocumentType.JSON_EINVOICE))
    assert f.value("irn") == "a1b2c3"
    assert f.value("invoice_number") == "INV-2026-501"
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("buyer_gstin") == "29AAGCR1234M1Z5"
    assert f.value("total") == 11800.0
    assert f.value("cgst") == 900.0
    assert f.value("hsn_sac") == "998314"
    assert f.get("vendor_gstin").confidence >= 0.95   # structured = high confidence


def test_structured_from_wrapped_xml_shape():
    # XML extractor wraps as {"Invoice": {...}}; the deep search still finds sections.
    wrapped = {"Invoice": _INV01}
    f = FieldExtractor().extract(_content(structured=wrapped, dtype=DocumentType.XML_INVOICE))
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("total") == 11800.0


def test_text_regex_extraction():
    f = FieldExtractor().extract(_content(text=_TEXT))
    assert f.value("invoice_number") == "INV-2026-777"
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("total") == 11800.0
    assert f.value("cgst") == 900.0
    assert f.value("hsn_sac") == "998314"
    assert f.get("total").confidence < 0.9   # text = lower confidence than structured


def test_structured_beats_text_confidence():
    # both present: structured value wins (higher confidence, not overwritten by text)
    f = FieldExtractor().extract(
        _content(text="Invoice No: TEXT-1", structured=_INV01, dtype=DocumentType.JSON_EINVOICE)
    )
    assert f.value("invoice_number") == "INV-2026-501"


def test_non_inv01_xml_via_aliases():
    """A UBL/custom XML shape (not GST INV-01) still maps via tag aliases."""
    ubl = {"Invoice": {
        "InvoiceNumber": "INV-2026-777",
        "InvoiceDate": "2026-07-06",
        "SellerGSTIN": "27AABCU9603R1ZN",
        "TotalAmount": "11,800.00",
        "CGST": "900", "SGST": "900",
        "HSN": "998314",
    }}
    f = FieldExtractor().extract(_content(structured=ubl, dtype=DocumentType.XML_INVOICE))
    assert f.value("invoice_number") == "INV-2026-777"
    assert f.value("vendor_gstin") == "27AABCU9603R1ZN"
    assert f.value("total") == 11800.0
    assert f.value("cgst") == 900.0
    assert f.value("hsn_sac") == "998314"


# Real Anthropic (OIDAR) invoice text: the seller's GST reg is a non-standard "99…" that fails the
# standard GSTIN shape, so the only standard-shape GSTIN on the page is OUR OWN bill-to one.
_ANTHROPIC_OIDAR = (
    "Invoice\nInvoice number\n5CR0HBCL-0004\nDate of issue\nJune 6, 2026\nDate due\nJune 6, 2026\n"
    "VAT Registration India GST:\n9924USA29003OSI\n"
    "Anthropic, PBC\n548 Market Street\nSan Francisco, California 94104\nUnited States\n"
    "Bill to\nAyush Agarwal\nHSR Layout\nBangalore 560102\nTamil Nadu\nIndia\nmari@innovfix.in\n"
    "IN GST 29AAICI1603A1Z3\n"
    "$100.00 USD due June 6, 2026\n"
    "Total\n$100.00\nAmount due\n$100.00 USD\n"
    "[1] Tax to be paid on reverse charge basis\n"
)


def test_foreign_oidar_seller_not_captured_as_vendor():
    # The seller (Anthropic OIDAR) GSTIN fails the standard shape, so a label-less grab would take
    # our OWN bill-to GSTIN as the vendor — a self-issued invoice. It must land in buyer_gstin, and
    # vendor_gstin must be blank so the invoice (correctly) routes to needs_review.
    f = FieldExtractor().extract(_content(text=_ANTHROPIC_OIDAR))
    assert f.value("buyer_gstin") == "29AAICI1603A1Z3"
    assert f.value("vendor_gstin") is None
    assert f.value("currency") == "USD"


def test_currency_iso_code_from_text():
    f = FieldExtractor().extract(_content(text="Max plan\nAmount due 49.00 USD"))
    assert f.value("currency") == "USD"


def test_currency_symbol_fallback_when_no_iso_code():
    # No ISO token anywhere — only a symbol attached to the amount.
    f = FieldExtractor().extract(_content(text="Total: $1,299.00"))
    assert f.value("currency") == "USD"


def test_distinct_seller_and_buyer_gstins_both_survive():
    # A normal B2B invoice with DIFFERENT seller/buyer GSTINs: the self-ref drop must not fire.
    f = FieldExtractor().extract(_content(
        "Tax Invoice\nSeller GSTIN: 27AABCU9603R1ZM\n"
        "Bill to\nInnovfix Private Limited\nGSTIN 29AAGCR1234M1Z5\n"
        "Grand Total 11800\n"
    ))
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("buyer_gstin") == "29AAGCR1234M1Z5"


def test_missing_fields_absent():
    f = FieldExtractor().extract(_content(text="no invoice data here"))
    assert f.value("total") is None
    assert f.value("vendor_gstin") is None
    assert f.value("buyer_gstin") is None
    assert f.value("currency") is None


def test_provenance_recorded():
    f = FieldExtractor().extract(_content(structured=_INV01, dtype=DocumentType.JSON_EINVOICE))
    assert f.get("vendor_gstin").source.startswith("structured:")
    d = f.to_dict()
    assert d["total"]["value"] == 11800.0 and "source" in d["total"]
