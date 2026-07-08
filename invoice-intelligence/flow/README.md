# Invoice Intelligence Platform — Handover Pack

This `flow/` folder is the complete start-to-end guide for the **Enterprise Invoice Intelligence
Platform**: an automatic system that captures every invoice emailed anywhere in the company,
reads it, validates it, and makes it searchable — including from Claude.

## What the system does (one paragraph)
A vendor (or an employee) emails an invoice to **any** company mailbox. A Google Workspace rule
automatically routes a copy to one central mailbox, **invoices@innovfix.in**. A pipeline reads that
mailbox over IMAP, opens each attachment/body, extracts the invoice fields (GSTIN, number, date,
tax, total…), validates them (GSTIN checksum, arithmetic), removes duplicates, and stores a clean
record in PostgreSQL. Real invoices become **accepted**, ones needing a human become **needs_review**,
and non-invoices (newsletters, resumes) become **not_invoice** — nothing is ever silently lost.
Staff can then search the data, or ask **Claude** in plain language via an MCP connector.

## Read in this order
1. **[01_OVERVIEW_AND_FLOW.md](01_OVERVIEW_AND_FLOW.md)** — the full end-to-end flow + architecture.
2. **[02_SERVER_SETUP.md](02_SERVER_SETUP.md)** — install & configure on your live server (Linux/Windows).
3. **[03_RUN_SCHEDULE_MCP.md](03_RUN_SCHEDULE_MCP.md)** — run it, schedule it, connect Claude (MCP).
4. **[04_OPERATIONS_AND_REVIEW.md](04_OPERATIONS_AND_REVIEW.md)** — daily use: search, review, correct, labels.
5. **[05_GOOGLE_WORKSPACE_RULE.md](05_GOOGLE_WORKSPACE_RULE.md)** — the admin routing rule (already live; reference).
6. **[06_WHAT_WAS_BUILT.md](06_WHAT_WAS_BUILT.md)** — everything that was built, and the test status.

## 30-second smoke test (offline, no credentials)
From the project root:
```bash
pip install -r requirements.txt
python -m pytest -q            # expect: all tests pass
# offline demo on bundled sample emails:
#   set config/attachments.yaml -> mail_reader.type: sample
python cli.py collect
python cli.py pipeline
python cli.py search
```

## The one rule to remember
- **Real invoices are captured automatically.** Humans only touch the small **needs_review** queue.
- Everything is **deterministic** (regex + checksums, no paid AI) and **idempotent** (safe to re-run).
