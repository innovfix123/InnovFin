"""Tests for the invoice relevance gate (precision layer) and its no-silent-miss guarantee."""

from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields.models import InvoiceFields
from validation import InvoiceRelevance


def _fields(**kv) -> InvoiceFields:
    f = InvoiceFields()
    for name, value in kv.items():
        f.set(name, value, 0.9, f"test:{name}")
    return f


def _content(text="hello", needs_review=False, method="pymupdf"):
    return ExtractedContent(
        "d1", "doc.pdf", DocumentType.DIGITAL_PDF, method, text, None, 0.95, needs_review, ()
    )


# -- real invoices pass the gate --------------------------------------------

def test_full_gst_invoice_is_invoice():
    f = _fields(vendor_gstin="27AABCU9603R1ZN", invoice_number="INV-1",
               taxable_value=10000, cgst=900, sgst=900, total=11800, hsn_sac="998314")
    r = InvoiceRelevance().assess(_content(), f)
    assert r.is_invoice is True
    assert r.score >= 2.0


def test_minimal_invoice_number_plus_total_passes():
    # invoice_number (+1) + total (+1) == 2 -> just clears the default threshold.
    r = InvoiceRelevance().assess(_content(), _fields(invoice_number="A1", total=500))
    assert r.is_invoice is True


def test_einvoice_with_irn_passes_even_without_much_else():
    r = InvoiceRelevance().assess(_content(), _fields(irn="irn-abc-123"))
    assert r.is_invoice is True and r.score >= 3.0


def test_zero_rated_tax_amount_still_counts():
    # A 0.00 tax value is falsy but still a real signal — must be counted.
    r = InvoiceRelevance().assess(_content(), _fields(invoice_number="A1", cgst=0, sgst=0))
    assert r.is_invoice is True


# -- noise is separated out --------------------------------------------------

def test_newsletter_with_no_fields_is_not_invoice():
    r = InvoiceRelevance().assess(_content(text="Weekly newsletter, big sale!"), _fields())
    assert r.is_invoice is False
    assert r.score == 0.0
    assert r.reasons  # explains why


def test_single_weak_signal_below_threshold_is_not_invoice():
    # A lone total with nothing else (score 1) does not clear the default threshold of 2.
    r = InvoiceRelevance().assess(_content(), _fields(total=500))
    assert r.is_invoice is False


# -- no silent miss: unreadable documents are never called junk --------------

def test_unreadable_document_is_kept_even_with_no_fields():
    # A scanned invoice that OCR failed on extracts no fields, but must NOT be discarded.
    r = InvoiceRelevance().assess(_content(text="", needs_review=True, method="none"), _fields())
    assert r.is_invoice is True
    assert any("unreadable" in reason for reason in r.reasons)


# -- config -----------------------------------------------------------------

def test_threshold_is_config_overridable():
    gate = InvoiceRelevance.from_config({"relevance_min_score": 4.0})
    assert gate.min_score == 4.0
    # invoice_number + total == 2 now falls below the stricter bar.
    assert gate.assess(_content(), _fields(invoice_number="A1", total=500)).is_invoice is False
