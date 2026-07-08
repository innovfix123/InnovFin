"""Tests for Document Type Detection (Milestone 2.2).

Uses a stub DocumentProvider (bytes in memory) — proving the typing layer works purely through
the DocumentProvider interface, with no filesystem or blob-store access.
"""

import textwrap

import pytest

from attachments.models import AttachmentType
from core.config import ConfigError
from doctype import DocumentType, DocumentTypeEngine
from documents.models import DocumentMetadata, DocumentRef

# -- fixtures: minimal but structurally valid documents ---------------------

_DIGITAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n"
    b"4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
    b"5 0 obj<</Length 40>>stream\nBT /F1 12 Tf 50 700 Td (Tax Invoice) Tj ET\nendstream endobj\n"
    b"%%EOF"
)
_SCANNED_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n"
    b"4 0 obj<</Type/XObject/Subtype/Image/Width 8/Height 8/Filter/DCTDecode/Length 6>>stream\n"
    b"\xff\xd8\xff\x00\x01\x02\nendstream endobj\n"
    b"5 0 obj<</Length 11>>stream\nq /Im0 Do Q\nendstream endobj\n"
    b"%%EOF"
)
_ENC_PDF = b"%PDF-1.6\n/Encrypt 9 0 R\n1 0 obj<</Type/Catalog>>endobj\n%%EOF"
_XML = b"<?xml version='1.0'?><Invoice><Irn>abc</Irn></Invoice>"
_JSON_EINVOICE = b'{"Version":"1.1","Irn":"a1b2","SellerDtls":{"Gstin":"27AABCU9603R1ZM"}}'
_JSON_PLAIN = b'{"hello":"world"}'
_JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 8
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
_TIFF = b"II*\x00" + b"\x00" * 8
_ZIP = b"PK\x03\x04" + b"\x00" * 8
_TXT = b"just some plain text, not an invoice"


class _StubProvider:
    """In-memory DocumentProvider — no storage of any kind."""

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


def _engine():
    return DocumentTypeEngine.from_config({
        "detectors": [
            {"name": "email_body"}, {"name": "encrypted_pdf"}, {"name": "pdf_layer"},
            {"name": "xml_invoice"}, {"name": "json_einvoice"}, {"name": "image"},
            {"name": "archive"},
        ],
        "rules": {"min_text_ops": 1, "pdf_ambiguous_default": "scanned"},
    })


def _detect(data, filename, atype, **kw):
    p = _StubProvider()
    ref = p.add("d1", data, filename, atype, **kw)
    return _engine().detect(p, ref)


# -- every required type ----------------------------------------------------

def test_digital_pdf():
    assert _detect(_DIGITAL_PDF, "inv.pdf", AttachmentType.PDF).document_type is DocumentType.DIGITAL_PDF


def test_scanned_pdf():
    assert _detect(_SCANNED_PDF, "scan.pdf", AttachmentType.PDF).document_type is DocumentType.SCANNED_PDF


def test_encrypted_pdf():
    r = _detect(_ENC_PDF, "locked.pdf", AttachmentType.PDF, is_encrypted=True)
    assert r.document_type is DocumentType.ENCRYPTED_PDF


def test_xml_invoice():
    assert _detect(_XML, "e.xml", AttachmentType.XML).document_type is DocumentType.XML_INVOICE


def test_json_einvoice_with_keys_is_high_confidence():
    r = _detect(_JSON_EINVOICE, "e.json", AttachmentType.JSON_EINVOICE)
    assert r.document_type is DocumentType.JSON_EINVOICE
    assert r.confidence >= 0.95


def test_json_plain_still_json_but_lower_confidence():
    r = _detect(_JSON_PLAIN, "x.json", AttachmentType.JSON_EINVOICE)
    assert r.document_type is DocumentType.JSON_EINVOICE
    assert r.confidence < 0.95


def test_image_jpg_png_tiff():
    assert _detect(_JPG, "a.jpg", AttachmentType.IMAGE).document_type is DocumentType.IMAGE_JPG
    assert _detect(_PNG, "a.png", AttachmentType.IMAGE).document_type is DocumentType.IMAGE_PNG
    assert _detect(_TIFF, "a.tif", AttachmentType.IMAGE).document_type is DocumentType.IMAGE_TIFF


def test_archive_zip():
    assert _detect(_ZIP, "docs.zip", AttachmentType.ARCHIVE).document_type is DocumentType.ARCHIVE_ZIP


def test_unsupported():
    r = _detect(_TXT, "note.txt", AttachmentType.OTHER)
    assert r.document_type is DocumentType.UNSUPPORTED


def test_email_body_typed_as_text_body():
    r = _detect(b"Tax Invoice INV-1 total 100", "x.body.txt", AttachmentType.EMAIL_BODY)
    assert r.document_type is DocumentType.TEXT_BODY


# -- explainability + routing hints -----------------------------------------

def test_every_decision_is_explainable():
    r = _detect(_DIGITAL_PDF, "inv.pdf", AttachmentType.PDF)
    assert r.reasons and all(reason.startswith("[") for reason in r.reasons)
    assert r.deciding_detector == "pdf_layer"


def test_routing_hints():
    assert DocumentType.SCANNED_PDF.needs_ocr is True
    assert DocumentType.XML_INVOICE.is_structured is True
    assert DocumentType.DIGITAL_PDF.needs_ocr is False


# -- audit + config-driven plugin behavior ----------------------------------

def test_audit_written(tmp_path):
    engine = DocumentTypeEngine.from_config({
        "detectors": [{"name": "image"}],
        "audit": {"path": str(tmp_path / "doctype.jsonl")},
    })
    p = _StubProvider()
    ref = p.add("d1", _JPG, "a.jpg", AttachmentType.IMAGE)
    engine.detect(p, ref)
    assert (tmp_path / "doctype.jsonl").exists()


def test_unknown_detector_raises():
    with pytest.raises(ConfigError):
        DocumentTypeEngine.from_config({"detectors": [{"name": "does_not_exist"}]})


def test_disabling_detector_changes_result():
    # with pdf_layer disabled, a digital PDF is no longer recognized as such
    engine = DocumentTypeEngine.from_config({
        "detectors": [{"name": "encrypted_pdf"}, {"name": "pdf_layer", "enabled": False}],
    })
    p = _StubProvider()
    ref = p.add("d1", _DIGITAL_PDF, "inv.pdf", AttachmentType.PDF)
    assert engine.detect(p, ref).document_type is DocumentType.UNSUPPORTED


def test_no_detectors_enabled_raises():
    with pytest.raises(ConfigError):
        DocumentTypeEngine.from_config({"detectors": [{"name": "image", "enabled": False}]})
