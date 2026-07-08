"""Deduplication (Part 2, Milestone 2.6) — semantic invoice dedup, no AI.

Collapses the same invoice arriving as different files/emails using a stable business key
(IRN, else vendor GSTIN + invoice number). See :mod:`dedup.deduper`.
"""

from dedup.deduper import InvoiceDeduper, dedup_key
from dedup.models import DedupResult

__all__ = ["InvoiceDeduper", "dedup_key", "DedupResult"]
