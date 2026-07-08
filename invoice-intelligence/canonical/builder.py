"""CanonicalBuilder (Part 2, Milestone 2.7) — assemble the canonical invoice record.

Merges the four deterministic stages into one stable JSON document:
extraction (source metadata) + fields (values + provenance) + validation + dedup.

Normalization applied here so the stored record is clean regardless of source format:
  * dates -> ISO ``YYYY-MM-DD`` (falls back to the raw string if unparseable),
  * amounts -> ``float``,
  * everything else -> trimmed string.

``status`` is the single field downstream systems switch on:
``duplicate`` > ``not_invoice`` > ``needs_review`` > ``accepted``.

``not_invoice`` marks noise the broad routing rule forwarded (marketing, newsletters) that a
clean read shows carries no invoice signals — it is separated out here so it never pollutes the
manual-review queue. The record is still built and stored (nothing is dropped).
"""

from __future__ import annotations

from typing import Any

from canonical.models import CanonicalInvoice
from dedup.models import DedupResult
from extraction.models import ExtractedContent
from fields.models import CANONICAL_FIELDS, InvoiceFields
from validation.engine import parse_date
from validation.models import ValidationResult
from validation.relevance import RelevanceResult

_DATE_FIELDS = ("invoice_date", "due_date")
_AMOUNT_FIELDS = ("taxable_value", "cgst", "sgst", "igst", "cess", "total")
_MAX_TEXT_CHARS = 200_000   # safety cap so a pathological document can't bloat the record


def _received_iso(raw_date: str) -> str:
    """Best-effort parse of an email Date header to ISO YYYY-MM-DD (else '')."""
    if not raw_date:
        return ""
    try:
        from email.utils import parsedate_to_datetime
        d = parsedate_to_datetime(raw_date)
        return d.date().isoformat() if d else ""
    except Exception:
        return ""


def _normalize(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name in _DATE_FIELDS:
        d = parse_date(value)
        return d.isoformat() if d else str(value).strip()
    if name in _AMOUNT_FIELDS:
        if isinstance(value, (int, float)):
            return float(value)
        try:
            return float(str(value).replace(",", "").strip())
        except ValueError:
            return value
    return str(value).strip() if isinstance(value, str) else value


class CanonicalBuilder:
    def build(
        self,
        content: ExtractedContent,
        fields: InvoiceFields,
        validation: ValidationResult,
        dedup: DedupResult,
        relevance: RelevanceResult | None = None,
        source_sender: str = "",
        source_date: str = "",
    ) -> CanonicalInvoice:
        values: dict[str, Any] = {}
        provenance: dict[str, dict] = {}
        for name in CANONICAL_FIELDS:
            f = fields.get(name)
            if f is None:
                continue
            values[name] = _normalize(name, f.value)
            provenance[name] = {"confidence": round(f.confidence, 4), "source": f.source}

        is_junk = relevance is not None and not relevance.is_invoice
        status = (
            "duplicate" if dedup.is_duplicate
            else "not_invoice" if is_junk
            else "needs_review" if validation.needs_review
            else "accepted"
        )
        relevance_info = (
            {
                "is_invoice": relevance.is_invoice,
                "score": relevance.score,
                "reasons": list(relevance.reasons),
            }
            if relevance is not None else {}
        )
        return CanonicalInvoice(
            doc_id=content.doc_id,
            canonical_id=dedup.canonical_id,
            status=status,
            source={
                "filename": content.filename,
                "document_type": content.document_type.value,
                "extraction_method": content.method,
                "extraction_confidence": round(content.confidence, 4),
                "sender": source_sender,
                "received_date": _received_iso(source_date),   # ISO YYYY-MM-DD (when it arrived)
                "received_raw": source_date,
            },
            fields=values,
            provenance=provenance,
            validation={
                "ok": validation.ok,
                "confidence": validation.confidence,
                "needs_review": validation.needs_review,
                "errors": list(validation.errors),
            },
            dedup={
                "is_duplicate": dedup.is_duplicate,
                "key": dedup.key,
                "canonical_id": dedup.canonical_id,
            },
            relevance=relevance_info,
            text=(content.text or "")[:_MAX_TEXT_CHARS],   # full document text, verbatim (plain)
        )
