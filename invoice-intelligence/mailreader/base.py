"""MailReader interface + the raw email it yields.

The collector depends only on this interface, so a live provider (IMAP, Gmail API, Microsoft
Graph) is added by writing one adapter — with no change to the collector.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Protocol, runtime_checkable


@dataclass(frozen=True)
class RawEmail:
    """A single raw RFC822 message plus a reference to where it came from."""

    source_ref: str
    raw: bytes


@runtime_checkable
class MailReader(Protocol):
    """Anything that can yield raw emails (offline sample folder, IMAP, Gmail API, ...)."""

    def read(self) -> Iterator[RawEmail]:
        ...
