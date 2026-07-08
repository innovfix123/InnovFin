"""Tests for the MCP tool logic (over a temp SQLite store)."""

from canonical.models import CanonicalInvoice
from mcp_server import tools
from storage.invoice_store import SqliteInvoiceStore


def _inv(doc_id, status, vendor, number, total, gstin="27AABCU9603R1ZN"):
    return CanonicalInvoice(
        doc_id=doc_id, canonical_id=doc_id, status=status,
        source={"filename": f"{doc_id}.pdf", "document_type": "digital_pdf"},
        fields={
            "vendor_name": vendor, "vendor_gstin": gstin,
            "invoice_number": number, "invoice_date": "2026-07-06",
            "total": total, "currency": "INR",
        },
        provenance={"vendor_gstin": {"confidence": 0.98, "source": "structured"}},
        validation={"errors": []}, dedup={},
    )


def _store(tmp_path):
    s = SqliteInvoiceStore(tmp_path / "inv.db")
    s.upsert(_inv("d1", "accepted", "Acme Supplies", "INV-1", 11800.0))
    s.upsert(_inv("d2", "accepted", "Globex Corp", "INV-2", 5000.0))
    s.upsert(_inv("d3", "needs_review", "Unknown", "INV-3", 0.0))
    return s


def test_search_by_text(tmp_path):
    rows = tools.search_invoices(_store(tmp_path), text="acme")
    assert len(rows) == 1 and rows[0]["vendor_name"] == "Acme Supplies"
    assert rows[0]["invoice_number"] == "INV-1"


def test_search_by_number_and_amount(tmp_path):
    s = _store(tmp_path)
    assert tools.search_invoices(s, invoice_number="INV-2")[0]["total"] == 5000.0
    assert {r["doc_id"] for r in tools.search_invoices(s, min_total=6000)} == {"d1"}


def test_get_invoice_returns_full_record(tmp_path):
    rec = tools.get_invoice(_store(tmp_path), "d1")
    assert rec["doc_id"] == "d1"
    assert rec["fields"]["vendor_gstin"] == "27AABCU9603R1ZN"
    assert "validation" in rec and "provenance" in rec


def test_get_invoice_missing(tmp_path):
    assert "error" in tools.get_invoice(_store(tmp_path), "nope")


def test_list_needs_review(tmp_path):
    rows = tools.list_needs_review(_store(tmp_path))
    assert len(rows) == 1 and rows[0]["doc_id"] == "d3"


def test_invoice_stats(tmp_path):
    stats = tools.invoice_stats(_store(tmp_path))
    assert stats == {"total": 3, "accepted": 2, "needs_review": 1, "duplicate": 0, "not_invoice": 0}


def test_list_not_invoice(tmp_path):
    s = _store(tmp_path)
    s.upsert(_inv("d4", "not_invoice", "Newsletter", "", 0.0))
    rows = tools.list_not_invoice(s)
    assert len(rows) == 1 and rows[0]["doc_id"] == "d4"


def test_server_module_imports_and_registers_tools():
    # Importing the server builds the store and registers the FastMCP tools without error.
    from mcp_server import server
    assert server.mcp is not None
