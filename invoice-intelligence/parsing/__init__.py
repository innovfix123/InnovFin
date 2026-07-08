"""Email parsing: raw RFC822 bytes -> normalized EmailDocument.

This is the ONLY place that understands MIME. Detectors never see raw bytes. Phase 1
reads attachment *metadata* only (name, type, size, sha256, structural flags) — never the
document contents.
"""

from parsing.mime_parser import parse_email

__all__ = ["parse_email"]
