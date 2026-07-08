"""Canonical record (Part 2, Milestone 2.7) — the pipeline's stable JSON output.

Merges extraction + fields + validation + dedup into one versioned, normalized
:class:`CanonicalInvoice` document that Storage and Search consume.
"""

from canonical.builder import CanonicalBuilder
from canonical.models import SCHEMA_VERSION, CanonicalInvoice

__all__ = ["CanonicalBuilder", "CanonicalInvoice", "SCHEMA_VERSION"]
