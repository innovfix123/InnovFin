"""Tests for the DocumentProvider abstraction.

These assert the key architectural guarantee: OCR/AI can read documents WITHOUT ever seeing a
storage path — they use opaque doc ids and the provider resolves bytes internally.
"""

import dataclasses

import pytest

from attachments.collector import AttachmentCollector
from attachments.models import AttachmentType
from documents import DocumentMetadata, DocumentRef, RegistryDocumentProvider
from mailreader.sample import SampleFolderReader
from testing.samples import _build

_PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
_XML = b"<?xml version='1.0'?><Invoice><ID>INV-1</ID></Invoice>"


def _provider_with_docs(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    (src / "a.eml").write_bytes(_build(
        sender="v@x.com", subject="Tax Invoice", body="see attached",
        attachments=[("Invoice.pdf", "application/pdf", _PDF),
                     ("einvoice.xml", "application/xml", _XML)],
    ))
    settings = {
        "storage": {"root": str(tmp_path / "blobs")},
        "registry": {"index_path": str(tmp_path / "index.json")},
        "supported_types": ["pdf", "xml"],
    }
    collector = AttachmentCollector.from_config(settings)
    collector.collect(SampleFolderReader(src))
    return RegistryDocumentProvider(collector.registry, collector.blob_store)


def test_ref_and_metadata_expose_no_storage_path():
    """The architectural guarantee: no path/store field leaks to OCR/AI."""
    for model in (DocumentRef, DocumentMetadata):
        names = {f.name for f in dataclasses.fields(model)}
        assert "stored_path" not in names
        assert "path" not in names
        assert not any("path" in n or "store" in n or "blob" in n for n in names)


def test_list_and_open_returns_exact_bytes(tmp_path):
    provider = _provider_with_docs(tmp_path)
    refs = provider.list_documents()
    assert len(refs) == 2

    by_name = {r.filename: r for r in refs}
    assert provider.open(by_name["Invoice.pdf"]) == _PDF
    assert provider.open(by_name["einvoice.xml"]) == _XML


def test_open_by_string_id(tmp_path):
    provider = _provider_with_docs(tmp_path)
    ref = provider.list_documents()[0]
    assert provider.open(ref.doc_id) == provider.open(ref)


def test_metadata_marks_structured_types(tmp_path):
    provider = _provider_with_docs(tmp_path)
    meta = {r.filename: provider.metadata(r) for r in provider.list_documents()}
    assert meta["Invoice.pdf"].attachment_type is AttachmentType.PDF
    assert meta["Invoice.pdf"].is_structured is False
    assert meta["einvoice.xml"].attachment_type is AttachmentType.XML
    assert meta["einvoice.xml"].is_structured is True   # XML e-invoice → parse directly


def test_unknown_document_raises(tmp_path):
    provider = _provider_with_docs(tmp_path)
    with pytest.raises(KeyError):
        provider.open("deadbeef")
