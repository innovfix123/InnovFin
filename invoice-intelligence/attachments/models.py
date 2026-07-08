"""Typed models for collected attachments."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class AttachmentType(str, Enum):
    """Coarse attachment class. Structured types are preferred over OCR downstream."""

    PDF = "pdf"                 # sub-typed digital vs scanned in a later milestone
    XML = "xml"                 # structured e-invoice (UBL / CII / GST XML)
    JSON_EINVOICE = "json"      # GST INV-01 JSON e-invoice (structured, IRN/QR data)
    IMAGE = "image"            # scanned / photographed invoice -> OCR later
    ARCHIVE = "archive"        # zip/rar/... (may contain invoices; unpack later)
    EMAIL_BODY = "email_body"  # the email body itself (captured when there is no usable attachment)
    OTHER = "other"

    @property
    def is_structured(self) -> bool:
        """Structured formats can be parsed directly, skipping OCR/AI."""
        return self in (AttachmentType.XML, AttachmentType.JSON_EINVOICE)


@dataclass(frozen=True)
class CollectedAttachment:
    """One extracted, hashed, classified, stored attachment."""

    source_ref: str            # e.g. the .eml filename it came from
    source_message_id: str     # the email's Message-ID (provenance)
    filename: str
    mime_type: str
    attachment_type: AttachmentType
    sha256: str
    size: int
    is_encrypted: bool         # password-protected PDF (cannot be read without a key)
    stored_path: str           # location in the blob store
    source_sender: str = ""    # the email's From header (who sent it)
    source_date: str = ""      # the email's Date header (raw, when it was sent)
