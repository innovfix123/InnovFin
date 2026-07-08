"""Regression: AttachmentRegistry save->load must preserve email provenance.

The collector captures source_sender / source_date, but registry._load() used to reconstruct the
record WITHOUT them — so when `collect` and `pipeline` run as separate processes, the pipeline
reloaded empty sender/date, wrote empty source.sender / source.received_date into every canonical
record, and the next collect's save() persisted the emptiness back to index.json. These tests pin
the round-trip so it can't silently regress again.
"""

import json

from attachments.models import AttachmentType, CollectedAttachment
from attachments.registry import AttachmentRegistry


def _rec(sha: str) -> CollectedAttachment:
    return CollectedAttachment(
        source_ref="imap:[Gmail]/All Mail:42", source_message_id="<m@x>", filename="inv.pdf",
        mime_type="application/pdf", attachment_type=AttachmentType.PDF, sha256=sha,
        size=10, is_encrypted=False, stored_path="build/attachments/x.bin",
        source_sender="Vaibhav Sahu <v@example.com>", source_date="Wed, 08 Jul 2026 12:00:00 +0530",
    )


def test_registry_roundtrip_preserves_sender_and_date(tmp_path):
    idx = tmp_path / "index.json"
    reg = AttachmentRegistry(idx)
    reg.add(_rec("a" * 64))
    reg.save()

    # Fresh registry loading from disk — mirrors `collect` then `pipeline` as separate processes.
    loaded = AttachmentRegistry(idx).get("a" * 64)
    assert loaded is not None
    assert loaded.source_sender == "Vaibhav Sahu <v@example.com>"
    assert loaded.source_date == "Wed, 08 Jul 2026 12:00:00 +0530"

    # And re-saving must NOT wipe them (the second half of the original bug).
    AttachmentRegistry(idx).save()
    again = AttachmentRegistry(idx).get("a" * 64)
    assert again.source_sender == "Vaibhav Sahu <v@example.com>"


def test_registry_load_tolerates_legacy_entry_without_provenance(tmp_path):
    """An index written before these fields existed must still load (defaults to '')."""
    idx = tmp_path / "index.json"
    idx.write_text(json.dumps({"b" * 64: {
        "source_ref": "imap:INBOX:1", "source_message_id": "<x>", "filename": "f.pdf",
        "mime_type": "application/pdf", "attachment_type": "pdf", "sha256": "b" * 64,
        "size": 1, "is_encrypted": False, "stored_path": "p",
    }}))
    loaded = AttachmentRegistry(idx).get("b" * 64)
    assert loaded is not None
    assert loaded.source_sender == ""
    assert loaded.source_date == ""
