"""Tests for production monitoring (health checks + reconciliation) and fail-loud DB."""

import pytest

from monitoring import HealthReport, check_health, reconcile
from storage.invoice_store import SqliteInvoiceStore, build_invoice_store


# -- health -----------------------------------------------------------------

def test_check_health_returns_report_with_core_checks():
    r = check_health("config")
    assert isinstance(r, HealthReport)
    names = {c.name for c in r.checks}
    assert {"config", "database", "ocr", "disk"} <= names
    # config must load and disk must have headroom regardless of environment
    assert next(c for c in r.checks if c.name == "config").ok
    assert next(c for c in r.checks if c.name == "disk").ok


def test_health_never_raises_on_bad_config_dir():
    r = check_health("no_such_dir_xyz")
    assert isinstance(r, HealthReport)
    assert not next(c for c in r.checks if c.name == "config").ok   # failed, not crashed


# -- reconciliation (no-miss proof) -----------------------------------------

class _Result:
    collected = [1, 2, 3]
    messages_seen = 5
    body_documents = 1
    emails_no_document = 1
    duplicates = 1
    unsupported = 0
    oversized = 0
    marked_processed = 5


def test_reconcile_reports_every_email_accounted():
    d = reconcile(_Result())
    assert d["messages_seen"] == 5
    assert d["documents_collected"] == 3
    assert d["body_documents"] == 1
    assert d["emails_no_document"] == 1
    assert d["marked_processed"] == 5
    assert d["complete"] is True


# -- fail-loud database -----------------------------------------------------

def test_postgres_without_dsn_and_no_fallback_raises():
    with pytest.raises(RuntimeError, match="no DSN"):
        build_invoice_store({"backend": "postgres", "fallback_to_sqlite": False})


def test_postgres_fallback_is_loud_and_reports_sqlite_backend(tmp_path):
    with pytest.warns(RuntimeWarning):
        store = build_invoice_store({
            "backend": "postgres", "fallback_to_sqlite": True,
            "path": str(tmp_path / "fallback.db"),
        })
    assert isinstance(store, SqliteInvoiceStore)
    assert store.backend_name == "sqlite"    # health check uses this to detect a fallback
    store.close()


def test_sqlite_backend_name(tmp_path):
    store = build_invoice_store({"backend": "sqlite", "path": str(tmp_path / "s.db")})
    assert store.backend_name == "sqlite"
    store.close()
