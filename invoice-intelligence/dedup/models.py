"""Deduplication result types."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DedupResult:
    is_duplicate: bool
    key: str | None          # the semantic dedup key, or None if the invoice is unkeyable
    canonical_id: str        # doc_id of the FIRST invoice seen for this key (self if new)
    reason: str
