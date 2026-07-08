"""Tests for human review actions (approve / reject / set_field) and the MCP wrappers."""

from canonical.models import CanonicalInvoice
from mcp_server import tools
from review import approve, reject, set_field
from storage.invoice_store import SqliteInvoiceStore


def _rec(status="needs_review", **fields):
    base = {"vendor_gstin": "27AABCU9603R1ZN", "invoice_number": "INV-1",
            "invoice_date": "2026-07-06", "taxable_value": 10000.0,
            "cgst": 900.0, "sgst": 900.0}
    base.update(fields)
    return {
        "doc_id": "d1", "canonical_id": "d1", "status": status,
        "fields": base, "validation": {"errors": ["mandatory field 'total' is missing"]},
    }


# -- pure functions ----------------------------------------------------------

def test_approve_sets_accepted_and_stamps_review():
    out = approve(_rec(), note="checked with vendor")
    assert out["status"] == "accepted"
    assert out["review"]["action"] == "approved"
    assert out["review"]["note"] == "checked with vendor"
    assert out["review"]["ts"]


def test_reject_sets_not_invoice():
    out = reject(_rec())
    assert out["status"] == "not_invoice"
    assert out["review"]["action"] == "rejected"


def test_set_field_fills_total_and_auto_accepts():
    # Missing total is the only gap; supplying it should re-validate to accepted.
    out = set_field(_rec(), "total", "11800")
    assert out["fields"]["total"] == 11800.0        # normalized to float
    assert out["status"] == "accepted"
    assert not out["validation"]["errors"]
    assert out["review"]["action"] == "edited" and out["review"]["field"] == "total"


def test_set_field_keeps_needs_review_when_still_incomplete():
    rec = _rec()
    rec["fields"].pop("invoice_date")
    out = set_field(rec, "total", "11800")          # date still missing
    assert out["status"] == "needs_review"


def test_duplicate_stays_duplicate_after_edit():
    out = set_field(_rec(status="duplicate"), "total", "11800")
    assert out["status"] == "duplicate"


# -- MCP wrappers over a real store ------------------------------------------

def test_mcp_approve_reject_set_roundtrip(tmp_path):
    store = SqliteInvoiceStore(tmp_path / "r.db")
    store.upsert(CanonicalInvoice.from_dict(_rec()))

    assert tools.approve_invoice(store, "INV-1")["status"] == "accepted"
    assert store.get("d1")["status"] == "accepted"

    assert tools.set_invoice_field(store, "INV-1", "total", "11800")["total"] == 11800.0
    assert store.get("d1")["fields"]["total"] == 11800.0

    assert tools.reject_invoice(store, "d1")["status"] == "not_invoice"
    assert store.get("d1")["status"] == "not_invoice"

    assert "error" in tools.approve_invoice(store, "NOPE")
    store.close()
