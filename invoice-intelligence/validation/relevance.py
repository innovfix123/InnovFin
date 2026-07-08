"""Invoice relevance gate (Part 2) — deterministic "is this actually an invoice?" scoring.

Recall lives in the Google Workspace routing rule, which is broad on purpose so no real invoice
is ever missed. That breadth means the central mailbox also receives marketing mail, newsletters,
generic "receipts" and other noise. This gate is the PRECISION layer: it scores each document on
hard invoice signals and cleanly separates genuine invoices from that noise, so the manual-review
queue stays clean instead of filling up with junk.

Design guarantees (both matter):

  * **No silent miss.** A document we could not read cleanly (``content.needs_review`` —
    unreadable / low-confidence OCR / unsupported) is NEVER called junk. An unreadable scanned
    invoice must reach a human, so it stays in the review path regardless of score.
  * **Nothing is deleted.** A ``not_invoice`` verdict only changes the record's ``status`` label;
    the record is still built, stored and searchable (``--status not_invoice``). It is a
    classification, not a drop.

Signals are deterministic field checks (no AI, no network): valid GSTIN, IRN, invoice number,
tax amounts, taxable value / total, HSN/SAC. Only a document that was read cleanly yet carries
none of these is flagged ``not_invoice``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fields.models import InvoiceFields
from validation.gstin import is_valid_gstin

# Score at/above which a cleanly-read document is treated as a real invoice. A genuine invoice
# almost always clears this easily (a valid GSTIN alone is +3; invoice_number + total is +2),
# while pure noise extracts no invoice fields at all and scores 0.
_DEFAULT_MIN_SCORE = 2.0

_TAX_FIELDS = ("cgst", "sgst", "igst", "cess")


@dataclass(frozen=True)
class RelevanceResult:
    is_invoice: bool
    score: float
    reasons: tuple[str, ...]      # human-readable trace of what scored


class InvoiceRelevance:
    """Scores extracted fields to decide whether a document is a real invoice."""

    def __init__(self, min_score: float = _DEFAULT_MIN_SCORE) -> None:
        self.min_score = float(min_score)

    @classmethod
    def from_config(cls, settings: dict[str, Any] | None) -> "InvoiceRelevance":
        s = settings or {}
        return cls(min_score=float(s.get("relevance_min_score", _DEFAULT_MIN_SCORE)))

    def assess(self, content: Any, fields: InvoiceFields) -> RelevanceResult:
        score, reasons = self._score(fields)
        # Safety net: if extraction could not read the document, we cannot call it junk.
        if getattr(content, "needs_review", False):
            return RelevanceResult(True, score, reasons + ("unreadable document kept for review",))
        is_invoice = score >= self.min_score
        if not is_invoice and not reasons:
            reasons = ("no invoice signals found",)
        return RelevanceResult(is_invoice, score, reasons)

    # -- scoring ------------------------------------------------------------
    def _score(self, f: InvoiceFields) -> tuple[float, tuple[str, ...]]:
        score = 0.0
        reasons: list[str] = []

        vendor = f.value("vendor_gstin")
        if vendor not in (None, ""):
            if is_valid_gstin(str(vendor)):
                score += 3.0
                reasons.append("valid vendor GSTIN (+3)")
            else:
                score += 1.0
                reasons.append("vendor GSTIN present (+1)")

        buyer = f.value("buyer_gstin")
        if buyer not in (None, "") and is_valid_gstin(str(buyer)):
            score += 1.0
            reasons.append("valid buyer GSTIN (+1)")

        if f.value("irn") not in (None, ""):
            score += 3.0
            reasons.append("IRN present (+3)")

        if f.value("invoice_number") not in (None, ""):
            score += 1.0
            reasons.append("invoice number (+1)")

        if any(_num(f.value(n)) is not None for n in _TAX_FIELDS):
            score += 2.0
            reasons.append("tax amount (+2)")

        if _num(f.value("total")) is not None:
            score += 1.0
            reasons.append("total amount (+1)")

        if _num(f.value("taxable_value")) is not None:
            score += 1.0
            reasons.append("taxable value (+1)")

        if f.value("hsn_sac") not in (None, ""):
            score += 1.0
            reasons.append("HSN/SAC code (+1)")

        return score, tuple(reasons)


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None
