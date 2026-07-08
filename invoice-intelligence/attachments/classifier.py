"""Classify an attachment by type — magic bytes first, then MIME, then extension.

Magic-byte checks are the most reliable (a mislabeled ``.pdf`` that is really a JPEG is
classified by its bytes, not its name).
"""

from __future__ import annotations

from attachments.models import AttachmentType

_ARCHIVE_EXT = (".zip", ".rar", ".7z", ".tar", ".gz")
_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff", ".bmp", ".webp")
_XML_EXT = (".xml", ".ubl", ".cii")
_ARCHIVE_MIME = (
    "application/zip", "application/x-zip-compressed",
    "application/x-rar-compressed", "application/x-7z-compressed",
)


def _ext(filename: str) -> str:
    name = (filename or "").lower().strip()
    dot = name.rfind(".")
    return name[dot:] if dot != -1 else ""


def classify(filename: str, mime_type: str, payload: bytes) -> AttachmentType:
    head = payload[:16]
    mime = (mime_type or "").lower().strip()
    ext = _ext(filename)

    # 1) Authoritative magic bytes (beat a wrong extension / MIME).
    if head.startswith(b"%PDF"):
        return AttachmentType.PDF
    if head.startswith(b"\xff\xd8\xff") or head.startswith(b"\x89PNG\r\n\x1a\n"):
        return AttachmentType.IMAGE
    if head[:2] == b"PK":                     # ZIP / Office (docx/xlsx) container
        return AttachmentType.ARCHIVE

    # 2) Fall back to MIME + extension for formats without a reliable magic number.
    if mime == "application/pdf" or ext == ".pdf":
        return AttachmentType.PDF
    if mime.startswith("image/") or ext in _IMAGE_EXT:
        return AttachmentType.IMAGE
    if ext in _ARCHIVE_EXT or mime in _ARCHIVE_MIME:
        return AttachmentType.ARCHIVE

    # 3) Structured text (JSON e-invoice / XML) by content, MIME, then extension.
    stripped = payload.lstrip()[:1]
    if ext == ".json" or mime == "application/json" or stripped == b"{":
        return AttachmentType.JSON_EINVOICE
    if ext in _XML_EXT or mime in ("application/xml", "text/xml") or stripped == b"<":
        return AttachmentType.XML
    return AttachmentType.OTHER
