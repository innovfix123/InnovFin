"""Tests for invoice storage + search (Milestones 2.8 & 2.9)."""

import pytest

from canonical import CanonicalBuilder
from dedup import InvoiceDeduper
from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields import FieldExtractor
from storage.invoice_store import SqliteInvoiceStore, build_invoice_store
from storage.search import SearchQuery
from validation import InvoiceValidator


def _rec(doc_id, gstin="27AABCU9603R1ZN", number="INV-1", dt="06/07/2026", total=11800,
         vendor="Acme Supplies", irn=None):
    structured = {
        "DocDtls": {"No": number, "Dt": dt},
        "SellerDtls": {"Gstin": gstin, "LglNm": vendor},
        "ValDtls": {"AssVal": total - 1800, "CgstVal": 900, "SgstVal": 900, "TotInvVal": total},
    }
    if irn:
        structured["Irn"] = irn
    content = ExtractedContent(doc_id, f"{doc_id}.json", DocumentType.JSON_EINVOICE, "json", "", structured, 1.0, False, ())
    fields = FieldExtractor().extract(content)
    validation = InvoiceValidator().validate(fields)
    dedup = InvoiceDeduper().register(doc_id, fields)
    return CanonicalBuilder().build(content, fields, validation, dedup)


@pytest.fixture()
def store():
    s = SqliteInvoiceStore(":memory:")
    yield s
    s.close()


def test_upsert_and_get(store):
    store.upsert(_rec("d1"))
    got = store.get("d1")
    assert got["fields"]["invoice_number"] == "INV-1"
    assert store.count() == 1


def test_upsert_is_idempotent(store):
    store.upsert(_rec("d1", total=11800))
    store.upsert(_rec("d1", total=23600))   # same doc_id -> overwrite, not duplicate
    assert store.count() == 1
    assert store.get("d1")["fields"]["total"] == 23600.0


def test_search_by_vendor_gstin(store):
    store.upsert(_rec("d1", gstin="27AABCU9603R1ZN"))
    store.upsert(_rec("d2", gstin="29AAGCR1234M1Z4", number="INV-2"))
    res = store.search(SearchQuery(vendor_gstin="27AABCU9603R1ZN"))
    assert len(res) == 1 and res[0]["doc_id"] == "d1"


def test_search_free_text(store):
    store.upsert(_rec("d1", vendor="Acme Supplies"))
    store.upsert(_rec("d2", vendor="Globex Corp", number="INV-2"))
    res = store.search(SearchQuery(text="globex"))
    assert len(res) == 1 and res[0]["doc_id"] == "d2"


def test_search_date_range(store):
    store.upsert(_rec("d1", dt="01/06/2026", number="INV-1"))
    store.upsert(_rec("d2", dt="15/07/2026", number="INV-2"))
    res = store.search(SearchQuery(date_from="2026-07-01", date_to="2026-07-31"))
    assert [r["doc_id"] for r in res] == ["d2"]


def test_search_total_range(store):
    store.upsert(_rec("d1", total=5000, number="INV-1"))
    store.upsert(_rec("d2", total=50000, number="INV-2"))
    res = store.search(SearchQuery(min_total=10000))
    assert [r["doc_id"] for r in res] == ["d2"]


def test_search_combined_filters(store):
    store.upsert(_rec("d1", gstin="27AABCU9603R1ZN", total=20000, number="INV-1"))
    store.upsert(_rec("d2", gstin="27AABCU9603R1ZN", total=500, number="INV-2"))
    res = store.search(SearchQuery(vendor_gstin="27AABCU9603R1ZN", min_total=1000))
    assert [r["doc_id"] for r in res] == ["d1"]


def test_empty_query_returns_all(store):
    store.upsert(_rec("d1"))
    store.upsert(_rec("d2", number="INV-2"))
    assert len(store.search(SearchQuery())) == 2


def test_search_limit(store):
    for i in range(5):
        store.upsert(_rec(f"d{i}", number=f"INV-{i}"))
    assert len(store.search(SearchQuery(limit=2))) == 2


def test_factory_defaults_to_sqlite(tmp_path):
    s = build_invoice_store({"path": str(tmp_path / "inv.db")})
    assert isinstance(s, SqliteInvoiceStore)
    s.upsert(_rec("d1"))
    assert s.count() == 1
    s.close()


def test_persists_to_disk(tmp_path):
    path = tmp_path / "inv.db"
    s1 = SqliteInvoiceStore(path)
    s1.upsert(_rec("d1"))
    s1.close()
    s2 = SqliteInvoiceStore(path)
    assert s2.get("d1") is not None
    s2.close()
