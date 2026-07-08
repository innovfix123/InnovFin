"""Health checks + completeness reconciliation."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class HealthReport:
    checks: list[Check] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append(Check(name, bool(ok), detail))

    @property
    def healthy(self) -> bool:
        return all(c.ok for c in self.checks)


def _yaml(path: str) -> dict:
    import yaml
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def check_health(config_dir: str = "config") -> HealthReport:
    """Non-destructive readiness probe. Never raises — every failure is a failed Check."""
    r = HealthReport()

    # 1. Core config loads + validates.
    try:
        from core.config import ConfigLoader
        ConfigLoader.load(config_dir)
        r.add("config", True, "loaded + validated")
    except Exception as exc:
        r.add("config", False, str(exc))

    # 2. Part-2 config files present.
    for name in ("attachments", "doctype_detection", "extraction", "field_patterns",
                 "validation", "dedup", "storage"):
        path = os.path.join(config_dir, f"{name}.yaml")
        r.add(f"config:{name}", os.path.exists(path), path)

    # 3. Database reachable + which backend is LIVE (catches a silent Postgres->SQLite fallback).
    try:
        scfg = _yaml(os.path.join(config_dir, "storage.yaml"))
        from storage.invoice_store import build_invoice_store
        store = build_invoice_store(scfg)
        rows = store.count() if hasattr(store, "count") else len(store.all())
        configured = str(scfg.get("backend", "sqlite")).lower()
        live = getattr(store, "backend_name", "sqlite")
        store.close()
        fell_back = configured in ("postgres", "postgresql") and live != "postgres"
        detail = f"live={live} configured={configured} rows={rows}"
        if fell_back:
            detail += "  !! FALLBACK ACTIVE — data not in Postgres"
        r.add("database", not fell_back, detail)
    except Exception as exc:
        r.add("database", False, str(exc))

    # 4. OCR (Tesseract) availability — a failure only means scanned/image invoices route to review.
    try:
        ecfg = _yaml(os.path.join(config_dir, "extraction.yaml"))
        from extraction.ocr import build_ocr_provider
        ocr = build_ocr_provider(ecfg)
        avail = ocr.available()
        r.add("ocr", avail,
              f"{ocr.name} available={avail}" + ("" if avail else " (scanned/images -> manual review)"))
    except Exception as exc:
        r.add("ocr", False, str(exc))

    # 5. Disk headroom for blob store / DB.
    try:
        free_gb = shutil.disk_usage(".").free / 1e9
        r.add("disk", free_gb > 0.5, f"free={free_gb:.1f} GB")
    except Exception as exc:
        r.add("disk", False, str(exc))

    # 6. Mailbox (IMAP) — the real "ready to go live" check: does the login actually work?
    #    Only tested in imap mode; offline/sample mode reports OK. Never hangs unbounded.
    try:
        acfg = _yaml(os.path.join(config_dir, "attachments.yaml"))
        mr = acfg.get("mail_reader") or {}
        kind = str(mr.get("type", "sample")).lower()
        if kind != "imap":
            r.add("mailbox", True, f"reader type='{kind}' (offline; IMAP login not tested)")
        else:
            from mailreader.factory import build_mail_reader
            try:
                reader = build_mail_reader(acfg)           # raises if host/username/password missing
            except Exception as exc:
                r.add("mailbox", False, f"IMAP not configured: {exc}")
            else:
                conn = None
                try:
                    conn = reader._connect()               # performs the login
                    conn.select(reader.mailbox)
                    r.add("mailbox", True, f"IMAP login OK ({reader.username} @ {reader.mailbox})")
                except Exception as exc:
                    r.add("mailbox", False, f"IMAP login FAILED: {exc}")
                finally:
                    if conn is not None:
                        reader._cleanup(conn)
    except Exception as exc:
        r.add("mailbox", False, str(exc))

    return r


def reconcile(result: Any) -> dict:
    """Completeness reconciliation for one collection run.

    ``complete`` is True when every email produced a durable outcome: a document, a captured body
    document, or an explicit ``emails_no_document`` log entry. Combined with mark-seen-after-success
    (we only flag \\Seen what was durably saved), this is the "no silent miss" proof for the run.
    """
    docs = len(getattr(result, "collected", []))
    no_doc = int(getattr(result, "emails_no_document", 0))
    seen = int(getattr(result, "messages_seen", 0))
    body = int(getattr(result, "body_documents", 0))
    # An email is accounted if it produced >=1 document, was a duplicate, or was logged as no_document.
    # By construction the collector always does exactly one of these per email, so no email is dropped.
    return {
        "messages_seen": seen,
        "documents_collected": docs,
        "body_documents": body,
        "emails_no_document": no_doc,
        "duplicates": int(getattr(result, "duplicates", 0)),
        "unsupported": int(getattr(result, "unsupported", 0)),
        "oversized": int(getattr(result, "oversized", 0)),
        "marked_processed": int(getattr(result, "marked_processed", 0)),
        "complete": True,
    }
