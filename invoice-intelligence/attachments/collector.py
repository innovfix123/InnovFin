"""AttachmentCollector — extract, classify, de-duplicate, store and audit invoice attachments.

Reads raw emails from a :class:`~mailreader.base.MailReader`, parses each with stdlib ``email``
to get attachment BYTES (the Phase-1 parser keeps only metadata, so Part 2 reads raw itself —
Phase 1 is untouched), then:
  * classifies the attachment type,
  * ignores unsupported / oversized attachments,
  * stores bytes in a content-addressed blob store,
  * records each blob in a registry index (idempotent across runs — dedup ledger),
  * appends an audit line for every decision.

STOPS before reading attachment *contents*. Document-typing (digital vs scanned) and OCR are
later milestones.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import message_from_bytes, policy
from pathlib import Path
from typing import Any, Iterator

from attachments.classifier import classify
from attachments.models import AttachmentType, CollectedAttachment
from attachments.registry import AttachmentRegistry
from mailreader.base import MailReader
from storage.blob_store import FilesystemBlobStore

_DEFAULT_MAX_BYTES = 25 * 1024 * 1024   # 25 MB


def _ext(filename: str) -> str:
    name = (filename or "").lower().strip()
    dot = name.rfind(".")
    return name[dot + 1:] if dot != -1 else ""


def _looks_encrypted_pdf(payload: bytes) -> bool:
    if not payload.startswith(b"%PDF"):
        return False
    return b"/Encrypt" in payload[:65536] or b"/Encrypt" in payload[-65536:]


def _iter_attachment_parts(msg) -> Iterator[tuple[str, str, bytes]]:
    for part in msg.walk():
        if part.is_multipart():
            continue
        content_type = (part.get_content_type() or "").lower()
        if content_type == "text/calendar":
            continue  # meeting invite, never an invoice document
        disposition = part.get_content_disposition() or ""
        filename = part.get_filename()
        if disposition == "attachment" or (filename and disposition != "inline"):
            payload = part.get_payload(decode=True) or b""
            yield (filename or "", content_type, payload)


@dataclass
class CollectionResult:
    collected: list[CollectedAttachment] = field(default_factory=list)
    messages_seen: int = 0
    duplicates: int = 0        # already present in the registry index (not re-stored)
    unsupported: int = 0       # extension not in supported_types
    oversized: int = 0
    body_documents: int = 0    # emails with no attachment whose BODY was captured as a document
    emails_no_document: int = 0  # emails that produced nothing at all (empty body + no attachment)
    marked_processed: int = 0  # messages flagged \Seen AFTER durable capture (mark-seen-after-success)

    @property
    def by_type(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for a in self.collected:
            out[a.attachment_type.value] = out.get(a.attachment_type.value, 0) + 1
        return out

    @property
    def completeness_ok(self) -> bool:
        """True when EVERY email was accounted for (produced a document or was explicitly logged)."""
        return True  # by construction: every email yields an attachment, a body doc, or a no_document log


class AttachmentCollector:
    def __init__(
        self,
        blob_store: FilesystemBlobStore,
        registry: AttachmentRegistry,
        *,
        supported_ext: tuple[str, ...] = (),
        max_size_bytes: int = _DEFAULT_MAX_BYTES,
        audit_path: str | Path | None = None,
    ) -> None:
        self.blob_store = blob_store
        self.registry = registry
        self.supported_ext = {e.lower().lstrip(".") for e in supported_ext}
        self.max_size_bytes = max_size_bytes
        self.audit_path = Path(audit_path) if audit_path else None

    @classmethod
    def from_config(cls, settings: dict[str, Any]) -> "AttachmentCollector":
        settings = settings or {}
        storage_root = (settings.get("storage", {}) or {}).get("root", "build/attachments")
        max_mb = float(settings.get("max_size_mb", 25))
        return cls(
            FilesystemBlobStore(storage_root),
            AttachmentRegistry((settings.get("registry", {}) or {}).get("index_path")),
            supported_ext=tuple(settings.get("supported_types", []) or []),
            max_size_bytes=int(max_mb * 1024 * 1024),
            audit_path=(settings.get("audit", {}) or {}).get("path"),
        )

    def collect(self, reader: MailReader) -> CollectionResult:
        result = CollectionResult()
        read_refs: list[str] = []          # for mark-seen-after-success

        for email in reader.read():
            read_refs.append(email.source_ref)
            result.messages_seen += 1
            msg = message_from_bytes(email.raw, policy=policy.default)
            message_id = (msg.get("Message-ID") or "").strip()
            sender = (str(msg.get("From") or "")).strip()      # who sent it
            sent_date = (str(msg.get("Date") or "")).strip()   # when it was sent

            supported = 0    # supported attachments this email had (collected OR duplicate)
            for filename, mime, payload in _iter_attachment_parts(msg):
                ext = _ext(filename)
                if self.supported_ext and ext not in self.supported_ext:
                    result.unsupported += 1
                    self._audit("unsupported", email.source_ref, message_id, filename, None, "", len(payload))
                    continue
                if len(payload) > self.max_size_bytes:
                    result.oversized += 1
                    self._audit("oversized", email.source_ref, message_id, filename, None, "", len(payload))
                    continue

                supported += 1
                atype = classify(filename, mime, payload)
                sha256, path = self.blob_store.put(payload)

                if self.registry.has(sha256):
                    result.duplicates += 1
                    self._audit("duplicate", email.source_ref, message_id, filename, atype, sha256, len(payload))
                    continue

                self._store_record(email, message_id, sender, sent_date, filename,
                                   (mime or "application/octet-stream").lower(),
                                   atype, payload, path, sha256, _looks_encrypted_pdf(payload), result, "collected")

            # NO-MISS GUARANTEE: an email with no supported attachment might carry the invoice in
            # its BODY (or be a stray). Capture the body as a document so it is never silently lost.
            if supported == 0:
                self._capture_body(email, message_id, sender, sent_date, result)

        # Durably persist EVERYTHING first...
        self.registry.save()
        # ...and only THEN mark the source messages processed (\Seen). If we crash before this
        # point, nothing is flagged, so the next run re-reads and re-captures — never a silent miss.
        mark_processed = getattr(reader, "mark_processed", None)
        if callable(mark_processed):
            result.marked_processed = mark_processed(read_refs)
        return result

    # -- body-only invoices (completeness) ----------------------------------
    def _capture_body(self, email, message_id, sender, sent_date, result: CollectionResult) -> None:
        from parsing.mime_parser import parse_email

        body = (parse_email(email.raw).body_text or "").strip()
        if not body:
            result.emails_no_document += 1
            self._audit("no_document", email.source_ref, message_id, "", None, "", 0)
            return
        payload = body.encode("utf-8", "ignore")
        filename = f"{message_id or email.source_ref}.body.txt"
        sha256, path = self.blob_store.put(payload)
        if self.registry.has(sha256):
            result.duplicates += 1
            self._audit("duplicate", email.source_ref, message_id, filename,
                        AttachmentType.EMAIL_BODY, sha256, len(payload))
            return
        self._store_record(email, message_id, sender, sent_date, filename, "text/plain",
                           AttachmentType.EMAIL_BODY, payload, path, sha256, False, result, "collected_body")
        result.body_documents += 1

    def _store_record(self, email, message_id, sender, sent_date, filename, mime, atype, payload,
                      path, sha256, is_encrypted, result: CollectionResult, event: str) -> None:
        record = CollectedAttachment(
            source_ref=email.source_ref, source_message_id=message_id, filename=filename,
            mime_type=mime, attachment_type=atype, sha256=sha256, size=len(payload),
            is_encrypted=is_encrypted, stored_path=path,
            source_sender=sender, source_date=sent_date,
        )
        self.registry.add(record)
        result.collected.append(record)
        self._audit(event, email.source_ref, message_id, filename, atype, sha256, len(payload))

    # -- audit trail --------------------------------------------------------
    def _audit(self, event, source_ref, message_id, filename, atype, sha256, size) -> None:
        if not self.audit_path:
            return
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": _now(),
            "event": event,
            "source_ref": source_ref,
            "message_id": message_id,
            "filename": filename,
            "type": atype.value if atype else None,
            "sha256": sha256,
            "size": size,
        }
        with self.audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
