# Invoice Intelligence Platform

Automatically captures every invoice emailed anywhere in the company, reads it (GSTIN, invoice
number, date, tax, total), validates it, de-duplicates it, stores a clean record in PostgreSQL, and
makes it searchable — from the command line, from the mailbox labels, and from **Claude** via MCP.

Deterministic-first (regex + checksums + OCR, **no paid AI**), idempotent, and no-miss by design.

## 👉 Start here
**Read [`flow/README.md`](flow/README.md)** — the complete, ordered handover guide:

1. [`flow/01_OVERVIEW_AND_FLOW.md`](flow/01_OVERVIEW_AND_FLOW.md) — the full end-to-end flow + architecture
2. [`flow/02_SERVER_SETUP.md`](flow/02_SERVER_SETUP.md) — install & configure on your server (Linux/Windows)
3. [`flow/03_RUN_SCHEDULE_MCP.md`](flow/03_RUN_SCHEDULE_MCP.md) — run it, schedule it, connect Claude (MCP)
4. [`flow/04_OPERATIONS_AND_REVIEW.md`](flow/04_OPERATIONS_AND_REVIEW.md) — daily use: search, review, correct, labels
5. [`flow/05_GOOGLE_WORKSPACE_RULE.md`](flow/05_GOOGLE_WORKSPACE_RULE.md) — the admin routing rule (already live; reference)
6. [`flow/06_WHAT_WAS_BUILT.md`](flow/06_WHAT_WAS_BUILT.md) — everything that was built, and the test status

## 30-second smoke test (offline, no credentials)
```bash
pip install -r requirements.txt
python -m pytest -q            # all tests should pass
# offline demo on the bundled sample emails:
#   in config/attachments.yaml set mail_reader.type: sample
#   in config/storage.yaml    set backend: sqlite
python cli.py collect
python cli.py pipeline
python cli.py search
```

## The flow, in one line
```
vendor emails an invoice -> Google Workspace rule -> invoices@innovfix.in
   -> collect (IMAP) -> pipeline (type -> extract/OCR -> fields -> validate -> relevance -> dedup
   -> canonical JSON -> PostgreSQL) -> Gmail labels -> search / Claude (MCP) / human review
```

## Common commands
```bash
python cli.py health                         # readiness preflight (config, DB, OCR, disk, IMAP login)
python cli.py collect                        # read new mail from the central mailbox
python cli.py pipeline                       # classify + store + label (add --reprocess to rebuild all)
python cli.py search --status accepted        # list clean invoices
python cli.py search --sender vaibhav         # by who emailed it
python cli.py show INV-778                     # one invoice: fields + full text
python cli.py approve INV-778                  # human review: approve / reject / set <field> <value>
python -m mcp_server.server                    # MCP server for Claude (stdio; see flow/03 for a URL)
```

> **Note:** this file is Markdown (`.md`) — open it with any text editor (Notepad, VS Code) or a
> Markdown viewer / browser. It is plain text; there is nothing to "run" here.
