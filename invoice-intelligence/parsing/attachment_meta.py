"""Build Attachment metadata from a MIME part. Contents are NOT interpreted (Phase 1).

We compute a content hash (for duplicate detection) and set structural flags that the
filter uses to (a) recognize structured e-invoices and (b) route unreadable-but-likely
documents (encrypted / scanned / archived) to Review instead of dropping them.
"""

from __future__ import annotations

import hashlib

_ARCHIVE_EXT = (".zip", ".rar", ".7z", ".tar", ".gz")
_STRUCTURED_EXT = (".xml", ".ubl", ".cii")
_IMAGE_MIME_PREFIX = "image/"


def _extension(filename: str) -> str:
    name = filename.lower().strip()
    dot = name.rfind(".")
    return name[dot:] if dot != -1 else ""


def _looks_encrypted_pdf(payload: bytes) -> bool:
    """Cheap structural check for a password-protected PDF (no content parsing).

    A PDF that carries an /Encrypt dictionary is password/permission protected. We only
    peek at the raw bytes for the marker; we never decode the document.
    """
    if not payload.startswith(b"%PDF"):
        return False
    return b"/Encrypt" in payload[:65536] or b"/Encrypt" in payload[-65536:]


def build_attachment(filename: str, mime_type: str, payload: bytes):
    """Create an :class:`~core.email_document.Attachment` from a part's raw bytes."""
    from core.email_document import Attachment  # local import to avoid cycle at module load

    filename = (filename or "").strip()
    mime_type = (mime_type or "application/octet-stream").lower().strip()
    ext = _extension(filename)

    is_archive = ext in _ARCHIVE_EXT or mime_type in (
        "application/zip",
        "application/x-zip-compressed",
        "application/x-rar-compressed",
        "application/x-7z-compressed",
    )
    is_image = mime_type.startswith(_IMAGE_MIME_PREFIX)
    is_structured_xml = ext in _STRUCTURED_EXT or mime_type in (
        "application/xml",
        "text/xml",
    )
    is_encrypted = _looks_encrypted_pdf(payload)

    return Attachment(
        filename=filename,
        mime_type=mime_type,
        size=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        is_encrypted=is_encrypted,
        is_archive=is_archive,
        is_image=is_image,
        is_structured_xml=is_structured_xml,
    )
