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


class TestOidarGstin:
    """Non-resident OIDAR suppliers (Anthropic, Meta, Agora, DigitalOcean) use a second scheme.

    Nine documents in the 50-document Drive pilot failed validation as "malformed GSTIN" on
    9924USA29003OSI — a genuine, correctly-printed non-resident registration.
    """

    def test_real_oidar_gstins_are_accepted(self):
        from validation import is_oidar_gstin, is_valid_gstin
        for g in ("9924USA29003OSI", "9917USA29016OSD", "9917USA29001OS2"):
            assert is_oidar_gstin(g), g
            assert is_valid_gstin(g), g

    def test_domestic_checksum_is_not_applied_to_them(self):
        """These trailing characters are not domestic check digits; requiring one rejects real
        registrations. 9917USA29016OSD would need 'S6' to pass the base-36 algorithm."""
        from validation import gstin_checksum, is_valid_gstin
        assert gstin_checksum("9917USA29016OS") != "D"
        assert is_valid_gstin("9917USA29016OSD")

    def test_domestic_gstins_still_get_the_checksum_check(self):
        from validation import is_oidar_gstin, is_valid_gstin
        assert not is_oidar_gstin("27AABCU9603R1ZN")
        assert not is_valid_gstin("27AABCU9603R1ZZ")

    def test_near_misses_are_still_rejected(self):
        from validation import is_valid_gstin
        assert not is_valid_gstin("9924USA29003XXI")    # not an OS (online services) registration
        assert not is_valid_gstin("8824USA29003OSI")    # does not start 99
        assert not is_valid_gstin("9924US29003OSI")     # country is not 3 letters


class TestTrustedSourceValidator:
    """Documents finance already reviewed skip our queue without losing their audit trail."""

    def _incomplete(self):
        from fields.models import InvoiceFields
        f = InvoiceFields()
        f.set("invoice_number", "INV-1", 0.6, "text:invoice_number")
        return f                                  # no total, no gstin, no date

    def test_plain_validator_sends_an_incomplete_document_to_review(self):
        from validation import InvoiceValidator
        assert InvoiceValidator().validate(self._incomplete()).needs_review is True

    def test_trusted_validator_does_not(self):
        from validation import TrustedSourceValidator
        assert TrustedSourceValidator().validate(self._incomplete()).needs_review is False

    def test_but_it_still_records_every_failure(self):
        """It changes the QUEUE, not the FACTS — the errors stay attached and searchable."""
        from validation import InvoiceValidator, TrustedSourceValidator
        plain = InvoiceValidator().validate(self._incomplete())
        trusted = TrustedSourceValidator().validate(self._incomplete())
        assert trusted.errors == plain.errors
        assert trusted.checks == plain.checks
        assert trusted.confidence == plain.confidence
        assert any("total" in e for e in trusted.errors)
