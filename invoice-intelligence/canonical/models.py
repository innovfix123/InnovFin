"""The canonical invoice record — the pipeline's stable, serializable output."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = "1.0"


@dataclass
class CanonicalInvoice:
    doc_id: str
    canonical_id: str                       # dedup canonical (self if first-seen)
    status: str                             # accepted | needs_review | duplicate | not_invoice
    source: dict[str, Any] = field(default_factory=dict)
    fields: dict[str, Any] = field(default_factory=dict)         # name -> normalized value
    provenance: dict[str, dict] = field(default_factory=dict)    # name -> {confidence, source}
    validation: dict[str, Any] = field(default_factory=dict)
    dedup: dict[str, Any] = field(default_factory=dict)
    relevance: dict[str, Any] = field(default_factory=dict)      # is_invoice + score + reasons
    text: str = ""                                               # full extracted text of the document
    review: dict[str, Any] = field(default_factory=dict)         # human review action (approve/reject/edit)
    schema_version: str = SCHEMA_VERSION

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "doc_id": self.doc_id,
            "canonical_id": self.canonical_id,
            "status": self.status,
            "source": self.source,
            "fields": self.fields,
            "provenance": self.provenance,
            "validation": self.validation,
            "dedup": self.dedup,
            "relevance": self.relevance,
            "text": self.text,
            "review": self.review,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CanonicalInvoice":
        """Rebuild a record from its stored dict (for human review edits + re-persisting)."""
        return cls(
            doc_id=d["doc_id"],
            canonical_id=d.get("canonical_id", d["doc_id"]),
            status=d.get("status", "accepted"),
            source=d.get("source", {}) or {},
            fields=d.get("fields", {}) or {},
            provenance=d.get("provenance", {}) or {},
            validation=d.get("validation", {}) or {},
            dedup=d.get("dedup", {}) or {},
            relevance=d.get("relevance", {}) or {},
            text=d.get("text", "") or "",
            review=d.get("review", {}) or {},
            schema_version=d.get("schema_version", SCHEMA_VERSION),
        )

    def to_json(self, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=True, ensure_ascii=False)
