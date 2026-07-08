"""Storage migration — move canonical invoice records between backends.

Primary use: promote the development SQLite store to production PostgreSQL without data loss.
Because every stored row keeps the full canonical JSON in its ``document`` column, migration is a
faithful re-``upsert`` of each record — idempotent, so it can be re-run safely.
"""

from __future__ import annotations

from canonical.models import SCHEMA_VERSION, CanonicalInvoice


def _row_to_canonical(doc: dict) -> CanonicalInvoice:
    return CanonicalInvoice(
        doc_id=doc["doc_id"],
        canonical_id=doc.get("canonical_id", doc["doc_id"]),
        status=doc.get("status", "accepted"),
        source=doc.get("source", {}),
        fields=doc.get("fields", {}),
        provenance=doc.get("provenance", {}),
        validation=doc.get("validation", {}),
        dedup=doc.get("dedup", {}),
        schema_version=doc.get("schema_version", SCHEMA_VERSION),
    )


def migrate(source, dest) -> int:
    """Copy every record from ``source`` store to ``dest`` store. Returns count migrated."""
    count = 0
    for doc in source.all():
        dest.upsert(_row_to_canonical(doc))
        count += 1
    return count
