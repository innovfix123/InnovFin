"""Tests for the canonical invoice record builder (Milestone 2.7)."""

import json

from canonical import CanonicalBuilder, SCHEMA_VERSION
from dedup import InvoiceDeduper
from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields import FieldExtractor
from validation import InvoiceValidator

_INV = {
    "Irn": "irn-abc-123",
    "DocDtls": {"No": "INV-2026-501", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": "27AABCU9603R1ZN", "LglNm": "Acme"},
    "BuyerDtls": {"Gstin": "29AAGCR1234M1Z4", "LglNm": "Innovfix"},
    "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800},
    "ItemList": [{"HsnCd": "998314"}],
}


def _content(structured=None, text="", filename="inv.json", dtype=DocumentType.JSON_EINVOICE):
    return ExtractedContent("d1", filename, dtype, "json", text, structured, 1.0, False, ())


def _build(content, deduper=None):
    fields = FieldExtractor().extract(content)
    validation = InvoiceValidator().validate(fields)
    deduper = deduper or InvoiceDeduper()
    dedup = deduper.register(content.doc_id, fields)
    return CanonicalBuilder().build(content, fields, validation, dedup)


def test_accepted_record_shape():
    rec = _build(_content(structured=_INV))
    assert rec.status == "accepted"
    assert rec.schema_version == SCHEMA_VERSION
    assert rec.fields["invoice_number"] == "INV-2026-501"
    assert rec.fields["total"] == 11800.0
    assert rec.source["document_type"] == "json_einvoice"
    assert rec.provenance["vendor_gstin"]["source"].startswith("structured:")


def test_date_normalized_to_iso():
    rec = _build(_content(structured=_INV))
    assert rec.fields["invoice_date"] == "2026-07-06"


def test_json_roundtrips():
    rec = _build(_content(structured=_INV))
    data = json.loads(rec.to_json())
    assert data["fields"]["total"] == 11800.0
    assert data["status"] == "accepted"
    assert set(data) >= {"schema_version", "doc_id", "canonical_id", "status", "fields", "validation", "dedup"}


def test_full_extracted_text_is_captured():
    rec = _build(_content(structured=_INV, text="TAX INVOICE\nGSTIN 27AABCU9603R1ZN\nGrand Total 11800"))
    assert "TAX INVOICE" in rec.text
    assert json.loads(rec.to_json())["text"].startswith("TAX INVOICE")


def test_needs_review_status_on_bad_gstin():
    bad = {**_INV, "SellerDtls": {"Gstin": "27AABCU9603R1ZZ", "LglNm": "Acme"}}
    rec = _build(_content(structured=bad))
    assert rec.status == "needs_review"
    assert rec.validation["errors"]


def test_source_sender_and_received_date_captured():
    content = _content(structured=_INV)
    fields = FieldExtractor().extract(content)
    validation = InvoiceValidator().validate(fields)
    dedup = InvoiceDeduper().register(content.doc_id, fields)
    rec = CanonicalBuilder().build(content, fields, validation, dedup,
                                   source_sender="Vaibhav Sahu <v@x.com>",
                                   source_date="Mon, 06 Jul 2026 10:00:00 +0530")
    assert rec.source["sender"] == "Vaibhav Sahu <v@x.com>"
    assert rec.source["received_date"] == "2026-07-06"     # RFC-2822 parsed to ISO
    assert rec.source["received_raw"] == "Mon, 06 Jul 2026 10:00:00 +0530"


def test_duplicate_status():
    d = InvoiceDeduper()
    _build(_content(structured=_INV), deduper=d)
    dup_content = ExtractedContent("d2", "inv2.json", DocumentType.JSON_EINVOICE, "json", "", _INV, 1.0, False, ())
    rec = _build(dup_content, deduper=d)
    assert rec.status == "duplicate"
    assert rec.canonical_id == "d1"
