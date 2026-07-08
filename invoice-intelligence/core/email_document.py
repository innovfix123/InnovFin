"""EmailDocument: the normalized, parsed representation of an email.

Detectors operate exclusively on this structure — never on raw bytes — so the parser
(module 4) is the single place that understands MIME. Phase 1 does NOT read attachment
*contents*; only attachment metadata (name, type, size, hash, structural flags).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Mapping

_FREE_TEXT_REPLY_PREFIXES = ("re:", "re :", "aw:", "sv:")
_FREE_TEXT_FORWARD_PREFIXES = ("fwd:", "fw:", "fwd :", "fw :")


class AuthResult(str, Enum):
    """Result of an email-authentication check (SPF / DKIM / DMARC)."""

    PASS = "pass"
    FAIL = "fail"
    NONE = "none"   # not present / not evaluated


@dataclass(frozen=True)
class AuthResults:
    """Parsed Authentication-Results for the message."""

    spf: AuthResult = AuthResult.NONE
    dkim: AuthResult = AuthResult.NONE
    dmarc: AuthResult = AuthResult.NONE

    @property
    def all_pass(self) -> bool:
        return (
            self.spf is AuthResult.PASS
            and self.dkim is AuthResult.PASS
            and self.dmarc is AuthResult.PASS
        )

    @property
    def any_fail(self) -> bool:
        return AuthResult.FAIL in (self.spf, self.dkim, self.dmarc)


@dataclass(frozen=True)
class Attachment:
    """Metadata about a single attachment. Contents are NOT read in Phase 1."""

    filename: str
    mime_type: str
    size: int = 0
    sha256: str = ""
    is_encrypted: bool = False        # password-protected PDF / archive
    is_archive: bool = False          # .zip / .rar / .7z
    is_image: bool = False            # image/* (potential scanned invoice)
    is_structured_xml: bool = False   # .xml / UBL / Factur-X (embedded CII)

    @property
    def extension(self) -> str:
        name = self.filename.lower().strip()
        dot = name.rfind(".")
        return name[dot:] if dot != -1 else ""

    @property
    def is_pdf(self) -> bool:
        return self.mime_type.lower() == "application/pdf" or self.extension == ".pdf"


@dataclass(frozen=True)
class EmailDocument:
    """A normalized email ready for classification.

    ``body_text`` is the combined plain-text body plus HTML with tags stripped, so
    detectors get a single text field to search.
    """

    message_id: str = ""
    from_addr: str = ""
    from_name: str = ""
    reply_to: str = ""
    to_addrs: tuple[str, ...] = ()
    subject: str = ""
    date: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)
    body_text: str = ""
    attachments: tuple[Attachment, ...] = ()
    auth: AuthResults = AuthResults()
    in_reply_to: str = ""
    references: tuple[str, ...] = ()
    raw_size: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "to_addrs", tuple(self.to_addrs))
        object.__setattr__(self, "attachments", tuple(self.attachments))
        object.__setattr__(self, "references", tuple(self.references))
        object.__setattr__(self, "headers", MappingProxyType(dict(self.headers)))

    # -- convenience accessors used across detectors ------------------------
    @property
    def sender_domain(self) -> str:
        """Lower-cased domain of the From address (empty if unparseable)."""
        addr = self.from_addr.lower().strip()
        at = addr.rfind("@")
        if at == -1:
            return ""
        domain = addr[at + 1:]
        return domain.strip("> ").strip()

    @property
    def reply_to_domain(self) -> str:
        addr = self.reply_to.lower().strip()
        at = addr.rfind("@")
        return addr[at + 1:].strip("> ").strip() if at != -1 else ""

    @property
    def has_attachments(self) -> bool:
        return len(self.attachments) > 0

    @property
    def attachment_count(self) -> int:
        return len(self.attachments)

    @property
    def is_reply(self) -> bool:
        if self.in_reply_to:
            return True
        subject = self.subject.lower().lstrip()
        return subject.startswith(_FREE_TEXT_REPLY_PREFIXES)

    @property
    def is_forward(self) -> bool:
        subject = self.subject.lower().lstrip()
        return subject.startswith(_FREE_TEXT_FORWARD_PREFIXES)

    def header(self, name: str, default: str = "") -> str:
        """Case-insensitive header lookup."""
        target = name.lower()
        for key, value in self.headers.items():
            if key.lower() == target:
                return value
        return default

    @property
    def searchable_text(self) -> str:
        """Subject + body, lower-cased — the common text field for keyword detectors."""
        return f"{self.subject}\n{self.body_text}".lower()
