"""Tests for deterministic invoice validation (Milestone 2.5)."""

from fields import FieldExtractor
from doctype.models import DocumentType
from extraction.models import ExtractedContent
from validation import InvoiceValidator, is_valid_gstin
from validation.engine import parse_date

# Valid GST INV-01 shape (GSTINs below pass the real checksum).
_GOOD = {
    "Irn": "a1b2c3",
    "DocDtls": {"No": "INV-2026-501", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": "27AABCU9603R1ZN", "LglNm": "Acme Supplies Pvt Ltd"},
    "BuyerDtls": {"Gstin": "29AAGCR1234M1Z4", "LglNm": "Innovfix Private Limited"},
    "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800},
    "ItemList": [{"HsnCd": "998314"}],
}


def _fields(structured=None, text=""):
    content = ExtractedContent("d1", "inv", DocumentType.JSON_EINVOICE, "x", text, structured, 1.0, False, ())
    return FieldExtractor().extract(content)


def test_gstin_checksum_examples():
    assert is_valid_gstin("27AABCU9603R1ZN")
    assert is_valid_gstin("29AAGCR1234M1Z4")
    assert not is_valid_gstin("27AABCU9603R1ZZ")   # wrong checksum
    assert not is_valid_gstin("27AABCU9603R1Z")    # too short
    assert not is_valid_gstin("")


def test_valid_invoice_passes():
    r = InvoiceValidator().validate(_fields(structured=_GOOD))
    assert r.ok
    assert not r.needs_review
    assert not r.errors
    assert r.confidence >= 0.8


def test_bad_gstin_fails_and_reviews():
    bad = {**_GOOD, "SellerDtls": {"Gstin": "27AABCU9603R1ZZ", "LglNm": "Acme"}}
    r = InvoiceValidator().validate(_fields(structured=bad))
    assert not r.ok
    assert r.needs_review
    assert any("GSTIN" in e for e in r.errors)


def test_missing_mandatory_field_reviews():
    minimal = {"SellerDtls": {"Gstin": "27AABCU9603R1ZN"}}  # no number/date/total
    r = InvoiceValidator().validate(_fields(structured=minimal))
    assert r.needs_review
    assert any("invoice_number" in e for e in r.errors)
    assert any("invoice_date" in e for e in r.errors)
    assert any("total" in e for e in r.errors)


def test_arithmetic_mismatch_flagged():
    wrong = {**_GOOD, "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 99999}}
    r = InvoiceValidator().validate(_fields(structured=wrong))
    assert not r.ok
    assert any("total" in e for e in r.errors)


def test_arithmetic_within_tolerance_passes():
    near = {**_GOOD, "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800.5}}
    r = InvoiceValidator().validate(_fields(structured=near))
    assert r.ok


def test_due_before_invoice_date_flagged():
    text = "Invoice No: INV-1\nInvoice Date: 20/07/2026\nDue Date: 06/07/2026\n"
    r = InvoiceValidator().validate(_fields(text=text))
    assert any("before invoice date" in e for e in r.errors)


def test_require_buyer_gstin_config():
    no_buyer = {**_GOOD}
    no_buyer = {k: v for k, v in _GOOD.items() if k != "BuyerDtls"}
    r = InvoiceValidator(require_buyer_gstin=True).validate(_fields(structured=no_buyer))
    assert any("buyer GSTIN" in e for e in r.errors)


def test_parse_date_formats():
    assert parse_date("06/07/2026").isoformat() == "2026-07-06"
    assert parse_date("2026-07-06").isoformat() == "2026-07-06"
    assert parse_date("6-Jul-2026").isoformat() == "2026-07-06"
    assert parse_date("nonsense") is None


def test_from_config_overrides():
    v = InvoiceValidator.from_config({"min_confidence": 0.9, "amount_tolerance": 0.0})
    assert v.min_confidence == 0.9
    assert v.amount_tolerance == 0.0
