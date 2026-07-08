"""Versioning for generated Gmail queries.

Every generated query carries a version so changes can be tracked and compared over time:

- ``engine_version`` — a human-set version string from config (e.g. ``v1``).
- ``revision``       — a content hash (short SHA-256) of the exact query text; it changes
                       automatically whenever the generated query text changes.

Together they form ``full_version`` (e.g. ``v1-a1b2c3d4e5f6``), which is stable for identical
output and diffable across config changes.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


def revision_of(query: str) -> str:
    """Short, stable content hash of a query string."""
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]


@dataclass(frozen=True)
class GeneratedQuery:
    """A single generated Gmail query with its identity, purpose and version metadata."""

    name: str                 # human name, e.g. "P2 Known Vendor Domains"
    tier: str                 # "FORWARD" | "P1".."P7" | "REVIEW" | "CENTRAL"
    purpose: str              # short description of what it does
    query: str                # the exact Gmail query string
    label_key: str            # Label Registry key applied by this filter
    forwards: bool            # True only for the single broad forwarding filter
    engine_version: str       # e.g. "v1"

    @property
    def revision(self) -> str:
        return revision_of(self.query)

    @property
    def full_version(self) -> str:
        return f"{self.engine_version}-{self.revision}"

    @property
    def length(self) -> int:
        return len(self.query)
