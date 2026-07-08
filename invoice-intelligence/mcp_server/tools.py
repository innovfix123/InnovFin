"""Tool logic for the MCP server — plain functions over an InvoiceStore (unit-testable).

Kept free of the MCP framework so they can be tested directly and reused by the CLI.
"""

from __future__ import annotations

from storage.search import SearchQuery


def summary(rec: dict) -> dict:
    """A compact, LLM-friendly view of a stored canonical invoice."""
    f = rec.get("fields") or {}
    src = rec.get("source") or {}
    return {
        "doc_id": rec.get("doc_id"),
        "status": rec.get("status"),
        "vendor_name": f.get("vendor_name"),
        "vendor_gstin": f.get("vendor_gstin"),
        "buyer_gstin": f.get("buyer_gstin"),
        "invoice_number": f.get("invoice_number"),
        "invoice_date": f.get("invoice_date"),
        "total": f.get("total"),
        "currency": f.get("currency"),
        "sender": src.get("sender"),               # who emailed it
        "received_date": src.get("received_date"),  # when it arrived (ISO)
    }


def search_invoices(store, *, text=None, vendor_gstin=None, invoice_number=None,
                    status=None, date_from=None, date_to=None,
                    received_from=None, received_to=None, sender=None,
                    min_total=None, max_total=None, limit=50) -> list[dict]:
    query = SearchQuery(
        text=text, vendor_gstin=vendor_gstin, invoice_number=invoice_number,
        status=status, date_from=date_from, date_to=date_to,
        received_from=received_from, received_to=received_to, sender=sender,
        min_total=min_total, max_total=max_total, limit=limit,
    )
    return [summary(r) for r in store.search(query)]


def get_invoice(store, doc_id: str) -> dict:
    rec = store.get(doc_id)
    if rec is None:
        return {"error": f"no invoice found with doc_id {doc_id!r}"}
    return rec


def list_needs_review(store, limit=50) -> list[dict]:
    return [summary(r) for r in store.search(SearchQuery(status="needs_review", limit=limit))]


def list_not_invoice(store, limit=50) -> list[dict]:
    """The junk bin — mail the broad rule forwarded that carries no invoice signals."""
    return [summary(r) for r in store.search(SearchQuery(status="not_invoice", limit=limit))]


def invoice_stats(store) -> dict:
    rows = store.all()
    out = {"total": len(rows), "accepted": 0, "needs_review": 0, "duplicate": 0, "not_invoice": 0}
    for r in rows:
        s = r.get("status", "accepted")
        out[s] = out.get(s, 0) + 1
    return out


# -- human review actions ---------------------------------------------------

def _resolve(store, ident: str):
    rec = store.get(ident)
    if rec is None:
        hits = store.search(SearchQuery(invoice_number=ident, limit=1))
        rec = hits[0] if hits else None
    return rec


def _persist(store, updated: dict) -> dict:
    from canonical.models import CanonicalInvoice
    store.upsert(CanonicalInvoice.from_dict(updated))
    return summary(updated)


def approve_invoice(store, ident: str, note: str = "") -> dict:
    """Mark a reviewed invoice as accepted."""
    import review
    rec = _resolve(store, ident)
    if rec is None:
        return {"error": f"no invoice found for {ident!r}"}
    return _persist(store, review.approve(rec, note=note))


def reject_invoice(store, ident: str, note: str = "") -> dict:
    """Mark an invoice as not_invoice (not a real invoice)."""
    import review
    rec = _resolve(store, ident)
    if rec is None:
        return {"error": f"no invoice found for {ident!r}"}
    return _persist(store, review.reject(rec, note=note))


def set_invoice_field(store, ident: str, field: str, value) -> dict:
    """Set/correct one field and re-validate (status may move to accepted)."""
    import review
    rec = _resolve(store, ident)
    if rec is None:
        return {"error": f"no invoice found for {ident!r}"}
    return _persist(store, review.set_field(rec, field, value))
