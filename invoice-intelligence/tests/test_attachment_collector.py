"""Tests for Part 2 Milestone 2.1 — mail reader, classifier, and attachment collector."""

import hashlib
import io
import json
import zipfile

import pytest

from attachments.classifier import classify
from attachments.collector import AttachmentCollector
from attachments.models import AttachmentType
from mailreader import RawEmail, build_mail_reader
from mailreader.sample import SampleFolderReader
from storage.blob_store import FilesystemBlobStore
from testing.samples import _build


class _RecordingReader:
    """A MailReader with a mark_processed() hook, to prove mark-seen-after-success ordering."""

    def __init__(self, emails):          # emails: list[(source_ref, raw_bytes)]
        self._emails = emails
        self.marked = None

    def read(self):
        for ref, raw in self._emails:
            yield RawEmail(source_ref=ref, raw=raw)

    def mark_processed(self, refs):
        self.marked = list(refs)
        return len(self.marked)

_PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
_ENC_PDF = b"%PDF-1.6\n/Encrypt 5 0 R\n1 0 obj<<>>endobj\n%%EOF\n"
_XML = b"<?xml version='1.0'?><Invoice><ID>INV-1</ID></Invoice>"
_JSON = b'{"Version":"1.1","Irn":"abc","SellerDtls":{"Gstin":"27AABCU9603R1ZM"}}'
_JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 16


def _zip_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("inner.pdf", _PDF)
    return buf.getvalue()


def _write_eml(folder, name, attachments):
    (folder / name).write_bytes(
        _build(sender="Vendor <v@example.com>", subject="Tax Invoice", body="See attached.",
               attachments=attachments)
    )


# -- classifier (magic-byte first) -----------------------------------------

def test_classifier_recognizes_all_types():
    assert classify("a.pdf", "application/pdf", _PDF) is AttachmentType.PDF
    assert classify("a.xml", "application/xml", _XML) is AttachmentType.XML
    assert classify("a.json", "application/json", _JSON) is AttachmentType.JSON_EINVOICE
    assert classify("a.jpg", "image/jpeg", _JPG) is AttachmentType.IMAGE
    assert classify("a.zip", "application/zip", _zip_bytes()) is AttachmentType.ARCHIVE
    assert classify("a.txt", "text/plain", b"hello") is AttachmentType.OTHER


def test_classifier_trusts_magic_bytes_over_extension():
    # a JPEG mislabeled as .pdf is still classified an image by its bytes
    assert classify("invoice.pdf", "application/pdf", _JPG) is AttachmentType.IMAGE


# -- mail reader ------------------------------------------------------------

def test_sample_reader_reads_eml(tmp_path):
    _write_eml(tmp_path, "a.eml", [("Invoice.pdf", "application/pdf", _PDF)])
    msgs = list(SampleFolderReader(tmp_path).read())
    assert len(msgs) == 1 and msgs[0].source_ref == "a.eml"


def test_factory_builds_sample_reader():
    r = build_mail_reader({"mail_reader": {"type": "sample", "sample_dir": "x"}})
    assert isinstance(r, SampleFolderReader)


# -- collector --------------------------------------------------------------

def _settings(tmp_path, supported=("pdf", "xml", "jpg")):
    return {
        "storage": {"root": str(tmp_path / "blobs")},
        "registry": {"index_path": str(tmp_path / "index.json")},
        "audit": {"path": str(tmp_path / "audit.jsonl")},
        "supported_types": list(supported),
        "max_size_mb": 25,
    }


def test_collect_classifies_stores_and_hashes(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    _write_eml(src, "a.eml", [
        ("Invoice.pdf", "application/pdf", _PDF),
        ("einvoice.xml", "application/xml", _XML),
        ("scan.jpg", "image/jpeg", _JPG),
    ])
    collector = AttachmentCollector.from_config(_settings(tmp_path))
    result = collector.collect(SampleFolderReader(src))

    assert result.messages_seen == 1
    assert len(result.collected) == 3
    assert result.by_type == {"pdf": 1, "xml": 1, "image": 1}
    a = next(a for a in result.collected if a.filename == "Invoice.pdf")
    assert a.sha256 == hashlib.sha256(_PDF).hexdigest()
    assert FilesystemBlobStore(str(tmp_path / "blobs")).exists(a.sha256)


def test_unsupported_types_are_ignored(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    _write_eml(src, "a.eml", [
        ("Invoice.pdf", "application/pdf", _PDF),
        ("docs.zip", "application/zip", _zip_bytes()),   # zip not in supported_types
        ("data.json", "application/json", _JSON),        # json not in supported_types
    ])
    result = AttachmentCollector.from_config(_settings(tmp_path)).collect(SampleFolderReader(src))
    assert [a.filename for a in result.collected] == ["Invoice.pdf"]
    assert result.unsupported == 2


def test_oversized_is_skipped(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    _write_eml(src, "a.eml", [("big.pdf", "application/pdf", b"%PDF-" + b"0" * 5000)])
    settings = _settings(tmp_path); settings["max_size_mb"] = 0.001  # ~1KB
    result = AttachmentCollector.from_config(settings).collect(SampleFolderReader(src))
    assert result.oversized == 1
    # the oversized attachment is skipped, but the email BODY is still captured (no-miss guarantee)
    assert not any(a.attachment_type.value == "pdf" for a in result.collected)
    assert result.body_documents == 1


def test_encrypted_pdf_flagged(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    _write_eml(src, "a.eml", [("enc.pdf", "application/pdf", _ENC_PDF)])
    result = AttachmentCollector.from_config(_settings(tmp_path)).collect(SampleFolderReader(src))
    assert result.collected[0].is_encrypted is True


def test_body_only_email_is_captured(tmp_path):
    # An email with NO attachment (invoice in body) must NOT be missed -> body captured.
    src = tmp_path / "src"; src.mkdir()
    (src / "a.eml").write_bytes(
        _build(sender="v@x.com", subject="Invoice",
               body="Tax Invoice INV-9 GSTIN 27AABCU9603R1ZN Grand Total 11800.00")
    )
    r = AttachmentCollector.from_config(_settings(tmp_path)).collect(SampleFolderReader(src))
    assert r.body_documents == 1
    assert r.collected and r.collected[0].attachment_type is AttachmentType.EMAIL_BODY


def test_empty_email_is_logged_not_silently_lost(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    (src / "a.eml").write_bytes(_build(sender="v@x.com", subject="x", body=""))
    r = AttachmentCollector.from_config(_settings(tmp_path)).collect(SampleFolderReader(src))
    assert r.body_documents == 0 and r.emails_no_document == 1
    assert r.messages_seen == 1  # accounted for (logged), not dropped


def test_collector_marks_processed_after_capture(tmp_path):
    raw = _build(sender="v@x.com", subject="Invoice", body="see attached",
                 attachments=[("a.pdf", "application/pdf", _PDF)])
    reader = _RecordingReader([("imap:INBOX:1", raw)])
    result = AttachmentCollector.from_config(_settings(tmp_path)).collect(reader)
    assert reader.marked == ["imap:INBOX:1"]       # marked \Seen only after collect
    assert result.marked_processed == 1


def test_collector_does_NOT_mark_processed_if_save_fails(tmp_path, monkeypatch):
    # CRASH SAFETY: if the durable save fails, messages must NOT be marked processed,
    # so the next run re-reads them (no silent miss).
    raw = _build(sender="v@x.com", subject="Invoice", body="x",
                 attachments=[("a.pdf", "application/pdf", _PDF)])
    reader = _RecordingReader([("imap:INBOX:1", raw)])
    collector = AttachmentCollector.from_config(_settings(tmp_path))

    def boom():
        raise OSError("disk full")
    monkeypatch.setattr(collector.registry, "save", boom)

    with pytest.raises(OSError):
        collector.collect(reader)
    assert reader.marked is None                   # NOT flagged -> re-read next run


def test_dedup_via_registry_index_across_runs(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    _write_eml(src, "a.eml", [("A.pdf", "application/pdf", _PDF)])
    _write_eml(src, "b.eml", [("B.pdf", "application/pdf", _PDF)])  # same bytes, different name
    settings = _settings(tmp_path)

    first = AttachmentCollector.from_config(settings).collect(SampleFolderReader(src))
    assert len(first.collected) == 1 and first.duplicates == 1   # 2nd identical blob deduped

    # re-run: everything already in the index → nothing new collected (idempotent)
    second = AttachmentCollector.from_config(settings).collect(SampleFolderReader(src))
    assert len(second.collected) == 0 and second.duplicates == 2

    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert len(index) == 1  # one unique blob recorded
    assert (tmp_path / "audit.jsonl").exists()
