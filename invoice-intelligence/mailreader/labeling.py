"""Outcome-label mapping for the central mailbox.

After the pipeline classifies each document, we tag its source message in the mailbox so a human
sees a clean, pipeline-driven view:
  * ``Invoice``     — the message produced at least one real invoice (accepted / needs_review /
    duplicate),
  * ``Not-Invoice`` — every document from the message was noise (``not_invoice``).

A single email can yield several documents (attachments + body); the message is labelled
``Invoice`` if ANY of them is invoice-ish, so a real invoice riding alongside noise is never
mis-tagged. The decision is driven entirely by the smart pipeline — never a dumb keyword filter —
which is exactly why the pipeline reads the whole inbox and labels afterwards.
"""

from __future__ import annotations

from typing import Iterable

INVOICE_LABEL = "Invoice"
NOT_INVOICE_LABEL = "Not-Invoice"
NEEDS_REVIEW_LABEL = "Needs-Review"

# Statuses that mean "this really is an invoice" (only `not_invoice` is noise).
_INVOICE_STATUSES = frozenset({"accepted", "needs_review", "duplicate"})


def build_outcome_labels(
    pairs: Iterable[tuple[str | None, str]],
    *,
    invoice_label: str = INVOICE_LABEL,
    not_invoice_label: str = NOT_INVOICE_LABEL,
    review_label: str = NEEDS_REVIEW_LABEL,
) -> dict[str, list[str]]:
    """Map each ``source_ref`` to its outcome label(s).

    ``pairs`` is an iterable of ``(source_ref, status)`` — one entry per document. A message is
    ``Invoice`` if any of its documents is invoice-ish (and additionally ``Needs-Review`` if any of
    them still needs a human), else ``Not-Invoice``. Entries with no ``source_ref`` (e.g. sample
    runs) are ignored. Returns a LIST of labels per message.
    """
    invoice_refs: set[str] = set()
    review_refs: set[str] = set()
    all_refs: set[str] = set()
    for ref, status in pairs:
        if not ref:
            continue
        all_refs.add(ref)
        if status in _INVOICE_STATUSES:
            invoice_refs.add(ref)
        if status == "needs_review":
            review_refs.add(ref)
    out: dict[str, list[str]] = {}
    for ref in all_refs:
        if ref in invoice_refs:
            labels = [invoice_label]
            if ref in review_refs:
                labels.append(review_label)
        else:
            labels = [not_invoice_label]
        out[ref] = labels
    return out


def apply_outcome_labels(reader, registry, records, **labels) -> dict[str, str]:
    """Best-effort: label each processed message in the mailbox by its pipeline outcome.

    Resolves every record's ``doc_id`` back to its mailbox ``source_ref`` via the registry, builds
    the per-message label map, and asks the reader to apply it. Silently does nothing when the
    reader can't label (e.g. the offline sample reader) — labelling must never break the run.
    """
    apply = getattr(reader, "apply_labels", None)
    if not callable(apply):
        return {}
    pairs: list[tuple[str | None, str]] = []
    for rec in records:
        record = registry.get(rec.doc_id)
        pairs.append((getattr(record, "source_ref", None) if record else None, rec.status))
    mapping = build_outcome_labels(pairs, **labels)
    if mapping:
        apply(mapping)
    return mapping
