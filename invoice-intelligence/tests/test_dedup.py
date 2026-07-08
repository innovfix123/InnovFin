"""Tests for semantic invoice deduplication (Milestone 2.6)."""

from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields import FieldExtractor
from dedup import InvoiceDeduper, dedup_key

_INV = {
    "Irn": "irn-abc-123",
    "DocDtls": {"No": "INV-2026-501", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": "27AABCU9603R1ZN", "LglNm": "Acme"},
    "ValDtls": {"AssVal": 10000, "TotInvVal": 11800},
}


def _fields(structured=None, text=""):
    c = ExtractedContent("d", "inv", DocumentType.JSON_EINVOICE, "x", text, structured, 1.0, False, ())
    return FieldExtractor().extract(c)


def test_key_prefers_irn():
    assert dedup_key(_fields(structured=_INV)) == "irn:IRN-ABC-123"


def test_key_falls_back_to_gstin_and_number():
    no_irn = {k: v for k, v in _INV.items() if k != "Irn"}
    assert dedup_key(_fields(structured=no_irn)) == "inv:27AABCU9603R1ZN|INV-2026-501"


def test_unkeyable_invoice_is_never_duplicate():
    f = _fields(text="just some words, no invoice identity")
    d = InvoiceDeduper()
    r = d.register("d1", f)
    assert dedup_key(f) is None
    assert not r.is_duplicate and r.key is None


def test_second_identical_invoice_is_duplicate():
    d = InvoiceDeduper()
    first = d.register("d1", _fields(structured=_INV))
    assert not first.is_duplicate
    second = d.register("d2", _fields(structured=_INV))
    assert second.is_duplicate
    assert second.canonical_id == "d1"


def test_same_invoice_different_file_deduped_by_business_key():
    # One arrives as JSON (with IRN), a re-send arrives as text (no IRN) but same GSTIN+number.
    no_irn = {k: v for k, v in _INV.items() if k != "Irn"}
    d = InvoiceDeduper()
    d.register("json1", _fields(structured=no_irn))
    txt = "GSTIN: 27AABCU9603R1ZN\nInvoice No: INV-2026-501\n"
    r = d.register("text1", _fields(text=txt))
    assert r.is_duplicate
    assert r.canonical_id == "json1"


def test_distinct_invoices_not_deduped():
    other = {**_INV, "Irn": "irn-xyz-999"}
    d = InvoiceDeduper()
    d.register("d1", _fields(structured=_INV))
    r = d.register("d2", _fields(structured=other))
    assert not r.is_duplicate


def test_check_does_not_mutate():
    d = InvoiceDeduper()
    d.check("d1", _fields(structured=_INV))
    # check() alone must not register d1, so a later register still sees it as new
    r = d.register("d1", _fields(structured=_INV))
    assert not r.is_duplicate


def test_ledger_persists(tmp_path):
    path = tmp_path / "dedup.json"
    d1 = InvoiceDeduper(path)
    d1.register("d1", _fields(structured=_INV))
    d1.save()
    d2 = InvoiceDeduper(path)
    r = d2.register("d2", _fields(structured=_INV))
    assert r.is_duplicate and r.canonical_id == "d1"
