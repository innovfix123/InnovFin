"""InvoiceStore (Part 2, Milestone 2.8) — persist canonical invoice records.

Deterministic, offline-first storage:

  * :class:`SqliteInvoiceStore` (default) — stdlib ``sqlite3``, zero external dependencies, so it
    works on any machine and in tests. The full canonical JSON lives in one column; the queryable
    fields (GSTIN, number, date, total, status, ...) are mirrored into indexed columns.
  * :class:`PostgresInvoiceStore` — the approved production target, same schema/SQL, activated only
    when ``psycopg`` and a server are available. Import is lazy so SQLite never pays for it.

Both satisfy the same tiny contract (:class:`InvoiceStore`): ``upsert`` (idempotent on ``doc_id``),
``get``, ``all``, ``search``. Storing by ``doc_id`` means re-running the pipeline overwrites rather
than duplicates. Search lives in :mod:`storage.search` and runs against whichever backend is active.
"""

from __future__ import annotations

import json
import os
import sqlite3
import warnings
from pathlib import Path
from typing import Any, Iterable, Protocol

from canonical.models import CanonicalInvoice

# Columns mirrored out of the canonical record for indexed querying.
_INDEXED = (
    "canonical_id", "status",
    "vendor_gstin", "vendor_name", "buyer_gstin", "buyer_name",
    "invoice_number", "invoice_date", "total",
    "sender", "received_date",
)
# Columns added after the first release — ALTER'd onto existing tables so old DBs keep working.
_ADDED_COLUMNS = ("sender", "received_date")


def _row(rec: CanonicalInvoice) -> dict[str, Any]:
    f = rec.fields
    src = rec.source or {}
    return {
        "doc_id": rec.doc_id,
        "canonical_id": rec.canonical_id,
        "status": rec.status,
        "vendor_gstin": f.get("vendor_gstin"),
        "vendor_name": f.get("vendor_name"),
        "buyer_gstin": f.get("buyer_gstin"),
        "buyer_name": f.get("buyer_name"),
        "invoice_number": f.get("invoice_number"),
        "invoice_date": f.get("invoice_date"),
        "total": f.get("total"),
        "sender": src.get("sender"),
        "received_date": src.get("received_date"),
        "document": rec.to_json(indent=None),
    }


class InvoiceStore(Protocol):
    def upsert(self, rec: CanonicalInvoice) -> None: ...
    def get(self, doc_id: str) -> dict | None: ...
    def all(self) -> list[dict]: ...
    def search(self, query) -> list[dict]: ...
    def close(self) -> None: ...


class SqliteInvoiceStore:
    backend_name = "sqlite"

    def __init__(self, path: str | Path = "build/invoices.db") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        cols = ",\n  ".join(f"{c} TEXT" for c in _INDEXED if c != "total")
        self._conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS invoices (
              doc_id TEXT PRIMARY KEY,
              {cols},
              total REAL,
              document TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_inv_canonical ON invoices(canonical_id);
            CREATE INDEX IF NOT EXISTS ix_inv_vendor ON invoices(vendor_gstin);
            CREATE INDEX IF NOT EXISTS ix_inv_number ON invoices(invoice_number);
            CREATE INDEX IF NOT EXISTS ix_inv_status ON invoices(status);
            """
        )
        # Self-migrate: add columns introduced after the first release to an existing DB.
        existing = {r["name"] for r in self._conn.execute("PRAGMA table_info(invoices)").fetchall()}
        for col in _ADDED_COLUMNS:
            if col not in existing:
                self._conn.execute(f"ALTER TABLE invoices ADD COLUMN {col} TEXT")
        self._conn.commit()

    def upsert(self, rec: CanonicalInvoice) -> None:
        row = _row(rec)
        cols = list(row)
        placeholders = ", ".join("?" for _ in cols)
        updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "doc_id")
        self._conn.execute(
            f"INSERT INTO invoices ({', '.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT(doc_id) DO UPDATE SET {updates}",
            [row[c] for c in cols],
        )
        self._conn.commit()

    def get(self, doc_id: str) -> dict | None:
        cur = self._conn.execute("SELECT document FROM invoices WHERE doc_id = ?", (doc_id,))
        r = cur.fetchone()
        return json.loads(r["document"]) if r else None

    def all(self) -> list[dict]:
        cur = self._conn.execute("SELECT document FROM invoices ORDER BY doc_id")
        return [json.loads(r["document"]) for r in cur.fetchall()]

    def _rows_where(self, where: str, params: Iterable[Any]) -> list[dict]:
        cur = self._conn.execute(f"SELECT document FROM invoices WHERE {where}", list(params))
        return [json.loads(r["document"]) for r in cur.fetchall()]

    def search(self, query) -> list[dict]:
        from storage.search import run_search
        return run_search(self, query)

    # Backend hook used by storage.search to push filters into SQL.
    def query_rows(self, where: str, params: Iterable[Any]) -> list[dict]:
        return self._rows_where(where, params)

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) AS n FROM invoices").fetchone()["n"]

    def clear(self) -> None:
        self._conn.execute("DELETE FROM invoices")
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


class PostgresInvoiceStore:  # pragma: no cover - requires a live PostgreSQL server
    backend_name = "postgres"

    """Same contract as SqliteInvoiceStore, backed by PostgreSQL via ``psycopg`` (v3).

    Not exercised in the offline test suite; wired for production once a server + DSN exist.
    """

    def __init__(self, dsn: str) -> None:
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError(
                "PostgresInvoiceStore requires the 'psycopg' package. "
                "Install it and provide a DSN, or use SqliteInvoiceStore (default)."
            ) from exc
        self._conn = psycopg.connect(dsn)
        self._init_schema()

    def _init_schema(self) -> None:
        cols = ",\n  ".join(f"{c} TEXT" for c in _INDEXED if c != "total")
        with self._conn.cursor() as cur:
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS invoices (
                  doc_id TEXT PRIMARY KEY,
                  {cols},
                  total DOUBLE PRECISION,
                  document JSONB NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_inv_vendor ON invoices(vendor_gstin);
                CREATE INDEX IF NOT EXISTS ix_inv_number ON invoices(invoice_number);
                CREATE INDEX IF NOT EXISTS ix_inv_status ON invoices(status);
                """
            )
            for col in _ADDED_COLUMNS:      # self-migrate an existing table
                cur.execute(f"ALTER TABLE invoices ADD COLUMN IF NOT EXISTS {col} TEXT")
        self._conn.commit()

    def upsert(self, rec: CanonicalInvoice) -> None:
        row = _row(rec)
        cols = list(row)
        placeholders = ", ".join("%s" for _ in cols)
        updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != "doc_id")
        with self._conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO invoices ({', '.join(cols)}) VALUES ({placeholders}) "
                f"ON CONFLICT(doc_id) DO UPDATE SET {updates}",
                [row[c] for c in cols],
            )
        self._conn.commit()

    def get(self, doc_id: str) -> dict | None:
        with self._conn.cursor() as cur:
            cur.execute("SELECT document FROM invoices WHERE doc_id = %s", (doc_id,))
            r = cur.fetchone()
        return _as_dict(r[0]) if r else None

    def all(self) -> list[dict]:
        with self._conn.cursor() as cur:
            cur.execute("SELECT document FROM invoices ORDER BY doc_id")
            return [_as_dict(r[0]) for r in cur.fetchall()]

    def query_rows(self, where: str, params: Iterable[Any]) -> list[dict]:
        where = where.replace("?", "%s")
        with self._conn.cursor() as cur:
            cur.execute(f"SELECT document FROM invoices WHERE {where}", list(params))
            return [_as_dict(r[0]) for r in cur.fetchall()]

    def search(self, query) -> list[dict]:
        from storage.search import run_search
        return run_search(self, query)

    def clear(self) -> None:
        with self._conn.cursor() as cur:
            cur.execute("TRUNCATE invoices")
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


def _as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else json.loads(value)


def _loud_sqlite_fallback(reason: str, sqlite_path) -> "SqliteInvoiceStore":
    """Degrade to SQLite but make it IMPOSSIBLE to miss (never a silent fallback)."""
    import sys
    banner = (f"STORAGE FALLBACK: PostgreSQL unavailable ({reason}). "
              f"Using SQLite at {sqlite_path}. Data will NOT be in Postgres until this is fixed.")
    line = "!" * min(len(banner), 100)
    print(f"\n{line}\n{banner}\n{line}", file=sys.stderr, flush=True)
    warnings.warn(banner, RuntimeWarning, stacklevel=2)
    return SqliteInvoiceStore(sqlite_path)


def build_invoice_store(settings: dict[str, Any] | None = None) -> InvoiceStore:
    """Factory: PostgreSQL when configured, otherwise SQLite.

    Production uses ``backend: postgres`` with a DSN (from config or the ``INVOICE_DB_DSN`` env var).
    SQLite remains a first-class **fallback adapter**, but the fallback is now **loud** (a stderr
    banner + warning) so an outage can never be silent. Set ``fallback_to_sqlite: false`` (recommended
    for production) to fail hard instead. Every store exposes ``backend_name`` so health checks /
    monitoring can confirm which backend is actually live.
    """
    s = settings or {}
    backend = str(s.get("backend", "sqlite")).lower()
    sqlite_path = s.get("path", "build/invoices.db")
    if backend in ("postgres", "postgresql"):
        dsn = s.get("dsn") or os.environ.get("INVOICE_DB_DSN")
        if not dsn:
            if not s.get("fallback_to_sqlite", True):
                raise RuntimeError("postgres backend selected but no DSN provided (config 'dsn' or INVOICE_DB_DSN)")
            return _loud_sqlite_fallback("no DSN provided", sqlite_path)
        try:
            return PostgresInvoiceStore(dsn)
        except Exception as exc:  # driver missing / server unreachable / bad DSN
            if not s.get("fallback_to_sqlite", True):
                raise
            return _loud_sqlite_fallback(str(exc), sqlite_path)
    return SqliteInvoiceStore(sqlite_path)
