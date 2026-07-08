"""PostgreSQL adapter parity tests (Milestone 2.8, production).

These run only when a reachable PostgreSQL is configured via the ``INVOICE_TEST_PG_DSN`` env var
(so the offline suite stays green). They assert the Postgres adapter honours the same contract as
SQLite: schema creation, insert, idempotent update, and search.
"""

import os

import pytest

from canonical import CanonicalBuilder
from dedup import InvoiceDeduper
from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields import FieldExtractor
from storage.search import SearchQuery
from validation import InvoiceValidator

_DSN = os.environ.get("INVOICE_TEST_PG_DSN")

psycopg = pytest.importorskip("psycopg")
pytestmark = pytest.mark.skipif(not _DSN, reason="INVOICE_TEST_PG_DSN not set; skipping live Postgres tests")


def _rec(doc_id, number="INV-1", total=11800, vendor="Acme Supplies", gstin="27AABCU9603R1ZN"):
    structured = {
        "DocDtls": {"No": number, "Dt": "06/07/2026"},
        "SellerDtls": {"Gstin": gstin, "LglNm": vendor},
        "ValDtls": {"AssVal": total - 1800, "CgstVal": 900, "SgstVal": 900, "TotInvVal": total},
    }
    content = ExtractedContent(doc_id, f"{doc_id}.json", DocumentType.JSON_EINVOICE, "json", "", structured, 1.0, False, ())
    fields = FieldExtractor().extract(content)
    validation = InvoiceValidator().validate(fields)
    dedup = InvoiceDeduper().register(doc_id, fields)
    return CanonicalBuilder().build(content, fields, validation, dedup)


@pytest.fixture()
def pg_store():
    from storage.invoice_store import PostgresInvoiceStore
    store = PostgresInvoiceStore(_DSN)
    # clean slate
    with store._conn.cursor() as cur:
        cur.execute("TRUNCATE invoices")
    store._conn.commit()
    yield store
    store.close()


def test_pg_schema_and_insert(pg_store):
    pg_store.upsert(_rec("d1"))
    got = pg_store.get("d1")
    assert got["fields"]["invoice_number"] == "INV-1"


def test_pg_update_idempotent(pg_store):
    pg_store.upsert(_rec("d1", total=11800))
    pg_store.upsert(_rec("d1", total=23600))
    rows = pg_store.all()
    assert len(rows) == 1
    assert rows[0]["fields"]["total"] == 23600.0


def test_pg_search(pg_store):
    pg_store.upsert(_rec("d1", vendor="Acme Supplies"))
    pg_store.upsert(_rec("d2", vendor="Globex Corp", number="INV-2"))
    res = pg_store.search(SearchQuery(text="globex"))
    assert len(res) == 1 and res[0]["doc_id"] == "d2"
