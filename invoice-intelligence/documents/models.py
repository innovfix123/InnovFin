"""Opaque document handle + metadata exposed to OCR/AI.

Deliberately contain **no storage location** (no path, no bucket, no store reference). The
only identifier is ``doc_id`` (the content hash), which the provider resolves internally.
"""

from __future__ import annotations

from dataclasses import dataclass

from attachments.models import AttachmentType


@dataclass(frozen=True)
class DocumentRef:
    """An opaque handle to a document. OCR/AI pass this back to the provider to get bytes."""

    doc_id: str                       # content hash — NOT a path
    filename: str
    attachment_type: AttachmentType


@dataclass(frozen=True)
class DocumentMetadata:
    """Everything OCR/AI may need to know *about* a document without opening it."""

    doc_id: str
    filename: str
    attachment_type: AttachmentType
    mime_type: str
    size: int
    is_encrypted: bool
    is_structured: bool               # XML / JSON e-invoice → parse directly, skip OCR
    source_message_id: str
    source_sender: str = ""           # who emailed it (From header)
    source_date: str = ""             # when it was emailed (raw Date header)
    source_ref: str = ""              # where it came from: the .eml name, or the Drive path
