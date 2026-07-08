"""AttachmentRegistry — the persisted ledger of collected attachments.

It serves two roles:
  * **idempotency / dedup** for the collector (``has`` / ``add``), and
  * the **record source** the DocumentProvider reads from.

It stores metadata only (keyed by content hash); the raw bytes live in the blob store. This is
what lets downstream (typing / OCR / AI) work through the :class:`DocumentProvider` without ever
knowing where bytes are physically stored.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from attachments.models import AttachmentType, CollectedAttachment


class AttachmentRegistry:
    def __init__(self, index_path: str | Path | None = None) -> None:
        self.index_path = Path(index_path) if index_path else None
        self._records: dict[str, CollectedAttachment] = {}
        self._load()

    # -- queries ------------------------------------------------------------
    def has(self, sha256: str) -> bool:
        return sha256 in self._records

    def get(self, doc_id: str) -> CollectedAttachment | None:
        return self._records.get(doc_id)

    def all(self) -> list[CollectedAttachment]:
        return list(self._records.values())

    def by_type(self, attachment_type: AttachmentType) -> list[CollectedAttachment]:
        return [r for r in self._records.values() if r.attachment_type is attachment_type]

    # -- mutation -----------------------------------------------------------
    def add(self, record: CollectedAttachment) -> None:
        self._records[record.sha256] = record

    # -- persistence --------------------------------------------------------
    def _load(self) -> None:
        if not (self.index_path and self.index_path.exists()):
            return
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        if not isinstance(data, dict):
            return
        for sha, rec in data.items():
            try:
                self._records[sha] = CollectedAttachment(
                    source_ref=rec["source_ref"],
                    source_message_id=rec["source_message_id"],
                    filename=rec["filename"],
                    mime_type=rec["mime_type"],
                    attachment_type=AttachmentType(rec["attachment_type"]),
                    sha256=rec["sha256"],
                    size=rec["size"],
                    is_encrypted=rec["is_encrypted"],
                    stored_path=rec["stored_path"],
                )
            except (KeyError, TypeError, ValueError):
                # Skip malformed / legacy-format entries instead of crashing.
                continue

    def save(self) -> None:
        if not self.index_path:
            return
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            sha: {**asdict(r), "attachment_type": r.attachment_type.value}
            for sha, r in self._records.items()
        }
        self.index_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
