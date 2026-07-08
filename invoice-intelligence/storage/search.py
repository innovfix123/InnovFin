"""Invoice search (Part 2, Milestone 2.9) — deterministic query over the InvoiceStore.

A small structured query is compiled to a parameterized SQL ``WHERE`` clause and pushed into the
active backend (SQLite or PostgreSQL) via its ``query_rows`` hook — so the same query runs
unchanged on either. All matching is exact/range except ``text``, a case-insensitive substring
match across the human-readable identity fields (vendor, buyer, invoice number, GSTIN).

ISO date normalization (done in the canonical builder) is what lets ``date_from`` / ``date_to``
work as plain lexical string comparisons.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

_TEXT_COLUMNS = ("vendor_name", "buyer_name", "invoice_number", "vendor_gstin", "buyer_gstin", "sender")


@dataclass(frozen=True)
class SearchQuery:
    text: str | None = None            # free-text substring over identity columns (incl. sender)
    vendor_gstin: str | None = None
    invoice_number: str | None = None
    status: str | None = None
    date_from: str | None = None       # invoice_date ISO YYYY-MM-DD (inclusive)
    date_to: str | None = None         # invoice_date ISO YYYY-MM-DD (inclusive)
    received_from: str | None = None   # received_date (when the mail arrived) ISO, inclusive
    received_to: str | None = None     # received_date ISO, inclusive
    sender: str | None = None          # substring match on the From header
    min_total: float | None = None
    max_total: float | None = None
    limit: int | None = None

    def is_empty(self) -> bool:
        return all(
            getattr(self, f) is None
            for f in ("text", "vendor_gstin", "invoice_number", "status",
                      "date_from", "date_to", "received_from", "received_to", "sender",
                      "min_total", "max_total")
        )


def _compile(q: SearchQuery) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if q.text:
        like = f"%{q.text.strip()}%"
        ors = " OR ".join(f"UPPER({c}) LIKE UPPER(?)" for c in _TEXT_COLUMNS)
        clauses.append(f"({ors})")
        params.extend([like] * len(_TEXT_COLUMNS))
    if q.vendor_gstin:
        clauses.append("UPPER(vendor_gstin) = UPPER(?)")
        params.append(q.vendor_gstin.strip())
    if q.invoice_number:
        clauses.append("UPPER(invoice_number) = UPPER(?)")
        params.append(q.invoice_number.strip())
    if q.status:
        clauses.append("status = ?")
        params.append(q.status.strip())
    if q.date_from:
        clauses.append("invoice_date >= ?")
        params.append(q.date_from)
    if q.date_to:
        clauses.append("invoice_date <= ?")
        params.append(q.date_to)
    if q.received_from:
        clauses.append("received_date >= ?")
        params.append(q.received_from)
    if q.received_to:
        clauses.append("received_date <= ?")
        params.append(q.received_to)
    if q.sender:
        clauses.append("UPPER(sender) LIKE UPPER(?)")
        params.append(f"%{q.sender.strip()}%")
    if q.min_total is not None:
        clauses.append("total >= ?")
        params.append(float(q.min_total))
    if q.max_total is not None:
        clauses.append("total <= ?")
        params.append(float(q.max_total))
    where = " AND ".join(clauses) if clauses else "1=1"
    return where, params


def run_search(store, query: SearchQuery) -> list[dict]:
    where, params = _compile(query)
    rows = store.query_rows(where, params)
    if query.limit is not None:
        rows = rows[: max(0, int(query.limit))]
    return rows
