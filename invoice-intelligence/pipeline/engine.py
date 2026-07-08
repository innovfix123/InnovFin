"""InvoicePipeline (Part 2) — the full deterministic flow, end to end.

Chains every stage over one DocumentProvider:

    doctype -> extract -> fields -> validate -> dedup -> canonical -> store

No stage touches the network or any AI service. One bad document never halts the run: the
extractor already degrades to ``needs_review`` on error, and that status flows through unchanged.
Returns the built :class:`CanonicalInvoice` records plus a small run summary.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from canonical import CanonicalBuilder, CanonicalInvoice
from dedup import InvoiceDeduper
from doctype import DocumentTypeEngine
from extraction import ExtractionEngine
from fields import FieldExtractor
from validation import InvoiceRelevance, InvoiceValidator


@dataclass
class PipelineSummary:
    total: int = 0
    accepted: int = 0
    needs_review: int = 0
    duplicate: int = 0
    not_invoice: int = 0
    processed: int = 0      # documents actually (re)extracted this run
    skipped: int = 0        # already stored (content-addressed) -> reused, not re-extracted
    by_status: dict[str, int] = field(default_factory=dict)


class InvoicePipeline:
    def __init__(
        self,
        typer: DocumentTypeEngine,
        extractor: ExtractionEngine,
        field_extractor: FieldExtractor,
        validator: InvoiceValidator,
        deduper: InvoiceDeduper,
        builder: CanonicalBuilder | None = None,
        store=None,
        gate: InvoiceRelevance | None = None,
    ) -> None:
        self.typer = typer
        self.extractor = extractor
        self.field_extractor = field_extractor
        self.validator = validator
        self.deduper = deduper
        self.builder = builder or CanonicalBuilder()
        self.store = store
        self.gate = gate or InvoiceRelevance()

    def process_one(self, provider, ref) -> CanonicalInvoice:
        dtype = self.typer.detect(provider, ref).document_type
        content = self.extractor.extract(provider, ref, dtype)
        fields = self.field_extractor.extract(content)
        validation = self.validator.validate(fields)
        relevance = self.gate.assess(content, fields)
        dedup = self.deduper.register(content.doc_id, fields)
        sender, received = "", ""
        meta_fn = getattr(provider, "metadata", None)
        if callable(meta_fn):
            try:
                meta = meta_fn(ref)
                sender = getattr(meta, "source_sender", "") or ""
                received = getattr(meta, "source_date", "") or ""
            except Exception:
                pass
        record = self.builder.build(content, fields, validation, dedup, relevance,
                                    source_sender=sender, source_date=received)
        if self.store is not None:
            # A human review (approve/reject/correct) WINS over re-extraction — re-running the
            # pipeline (e.g. the 15-min scheduled job) must never wipe a manual decision.
            existing = self.store.get(record.doc_id)
            if existing and existing.get("review"):
                return CanonicalInvoice.from_dict(existing)
            self.store.upsert(record)
        return record

    def run(self, provider, reprocess: bool = False) -> tuple[list[CanonicalInvoice], PipelineSummary]:
        """Process every document from ``provider``.

        Documents are content-addressed (``doc_id`` = content hash), so a document already in the
        store never changes. By default (``reprocess=False``) such documents are REUSED as-is —
        the run only (re)extracts genuinely new documents. This keeps the scheduled job cheap and
        bounded no matter how large the archive grows. Pass ``reprocess=True`` after an
        extractor/validator change to rebuild everything (human review decisions are still kept).
        """
        records: list[CanonicalInvoice] = []
        summary = PipelineSummary()
        for ref in provider.list_documents():
            doc_id = getattr(ref, "doc_id", None) or str(ref)
            existing = self.store.get(doc_id) if (self.store is not None and not reprocess) else None
            if existing is not None:
                rec = CanonicalInvoice.from_dict(existing)
                summary.skipped += 1
            else:
                rec = self.process_one(provider, ref)
                summary.processed += 1
            records.append(rec)
            summary.total += 1
            summary.by_status[rec.status] = summary.by_status.get(rec.status, 0) + 1
        summary.accepted = summary.by_status.get("accepted", 0)
        summary.needs_review = summary.by_status.get("needs_review", 0)
        summary.duplicate = summary.by_status.get("duplicate", 0)
        summary.not_invoice = summary.by_status.get("not_invoice", 0)
        if self.deduper.index_path:
            self.deduper.save()
        return records, summary
