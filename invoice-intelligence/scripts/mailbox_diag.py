#!/usr/bin/env python3
"""innovfin mailbox diagnostic — answers: which account? is auth working? how many RAW messages?

Reuses config/attachments.yaml + INVOICE_IMAP_PASSWORD. **Read-only**: every SELECT is readonly and
nothing is ever marked/labelled. Distinguishes "silent auth-empty" (login raises → you see it) from
"logged in, mailbox genuinely (near-)empty" from "mail is here but in All Mail / under a label, not
INBOX" (a forwarding rule that archives or skips the inbox).

Run:  set -a; . <(grep ^INVOICE_ /var/www/innovfin/.env); set +a; .venv/bin/python scripts/mailbox_diag.py
"""
from __future__ import annotations

import imaplib
import os
import sys

import yaml

CFG = os.environ.get("INVOICE_CONFIG_DIR", "config")


def _q(box: str) -> str:
    return f'"{box}"' if (" " in box) else box


def _reader_cfg() -> dict:
    with open(os.path.join(CFG, "attachments.yaml"), encoding="utf-8") as fh:
        return (yaml.safe_load(fh) or {}).get("mail_reader", {}) or {}


def _counts(conn, box: str, unprocessed_query: tuple) -> str:
    typ, data = conn.select(_q(box), readonly=True)
    if typ != "OK":
        return f"(not found / {typ})"
    total = int(data[0]) if data and data[0] else 0
    typ, d = conn.uid("SEARCH", *unprocessed_query)
    unproc = len(d[0].split()) if typ == "OK" and d and d[0] else 0
    return f"total={total:<6} unprocessed={unproc}"


def _recent(conn, box: str, n: int = 10) -> list[str]:
    out: list[str] = []
    typ, _ = conn.select(_q(box), readonly=True)
    if typ != "OK":
        return [f"(cannot select {box})"]
    typ, d = conn.uid("SEARCH", "ALL")
    uids = d[0].split() if typ == "OK" and d and d[0] else []
    for uid in uids[-n:]:
        typ, md = conn.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if typ == "OK" and md and md[0]:
            hdr = md[0][1].decode("utf-8", "replace").strip().replace("\r\n", " | ").replace("\n", " | ")
            out.append(hdr[:200])
    return out or ["(none)"]


def main() -> int:
    mr = _reader_cfg()
    host = mr.get("host", "imap.gmail.com")
    port = int(mr.get("port", 993))
    user = mr.get("username")
    pw = os.environ.get(mr.get("password_env", "INVOICE_IMAP_PASSWORD"), "")
    plabel = mr.get("processed_label", "Processed")

    print(f"config: mail_reader.type={mr.get('type')} mailbox={mr.get('mailbox')!r} "
          f"mark_mode={mr.get('mark_mode')} processed_label={plabel!r} limit={mr.get('limit')}")
    print(f"connect: {user} @ {host}:{port}  password={'SET (%d chars)' % len(pw) if pw else 'MISSING'}")
    if not pw:
        print("!! INVOICE_IMAP_PASSWORD not set — cannot authenticate")
        return 1

    conn = imaplib.IMAP4_SSL(host, port)
    typ, resp = conn.login(user, pw)          # raises on bad credentials — never a silent empty
    print(f"LOGIN: {typ}  authenticated_as={user}")

    typ, boxes = conn.list()
    print(f"\n=== folders / labels ({len(boxes) if typ == 'OK' else 0}) ===")
    if typ == "OK":
        for b in boxes:
            print("   ", b.decode("utf-8", "replace"))

    unprocessed = ("X-GM-RAW", f"-label:{plabel}")
    print(f"\n=== counts (unprocessed = NOT yet labelled {plabel!r}) ===")
    for box in ("INBOX", "[Gmail]/All Mail", "Invoices", "Invoices/Auto"):
        print(f"   {box:18} {_counts(conn, box, unprocessed)}")

    for box in ("INBOX", "[Gmail]/All Mail"):
        print(f"\n=== recent headers — {box} ===")
        for h in _recent(conn, box, 10):
            print("   -", h)

    conn.logout()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
