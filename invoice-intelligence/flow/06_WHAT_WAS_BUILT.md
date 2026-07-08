# 06 — What Was Built (and test status)

## Status
- **266 automated tests pass** (4 skipped = live-PostgreSQL-only), zero known regressions.
- Verified **live end-to-end**: real mail from `invoices@innovfix.in` → collected → classified →
  stored in PostgreSQL → labelled → queried via CLI **and** via Claude over MCP.
- `python cli.py health` → **HEALTHY** (config, PostgreSQL live, Tesseract OCR available, disk).

## Capabilities delivered
**Intake & no-miss**
- Google Workspace routing to one central mailbox (top-org rule, spam-bypass).
- IMAP reader with a **Gmail-label lifecycle**: reads only un-`Processed` mail, marks `Processed`
  after durable capture — a human opening the mailbox can't cause a miss.
- Body-only invoices (no attachment) are captured too; unreadable docs go to review, never dropped.

**Understanding**
- Document typing (digital PDF / scanned / XML / JSON / email body).
- Extraction: PyMuPDF text, Tesseract OCR, XML/JSON parsing.
- Deterministic field extraction tolerant of real formats: bare "Date" labels, month-name dates
  ("June 6, 2026"), whole-number amounts ("11800"), and tax **rates** ("9%") are never mistaken for
  amounts.
- Validation: GSTIN checksum, mandatory fields, date parsing, arithmetic reconciliation.
- **Relevance gate**: separates real invoices from newsletters/resumes/notifications
  (`not_invoice`) without polluting the review queue — and never discards an unreadable document.

**Data & operations**
- Canonical JSON record + **full extracted text** stored per invoice; PostgreSQL (SQLite fallback).
- Business-key de-duplication (IRN, else vendor_gstin+invoice_number).
- **Incremental pipeline**: re-runs only extract new documents (bounded cost at any archive size).
- **Human review**: `approve` / `reject` / `set <field>` from CLI or Claude; decisions survive
  re-runs.
- Search (CLI + MCP), health checks, reconciliation (no-miss proof).

**Access**
- MCP server exposing 9 tools; runs locally (stdio) or as a remote URL (Streamable HTTP), optional
  bearer-token auth.

## Key fixes made during bring-up (so you understand the history)
- Routing rule was on a **sub-OU** → moved to **top org** (this was why nothing arrived).
- **Bypass spam filter** added → external-sender copies stopped being spam-dropped.
- Extractor made tolerant of real-world date/amount formats → real invoices now reach `accepted`.
- Tax **rate** vs **amount** bug fixed (was capturing "9" from "9%").
- Pipeline made **incremental** (was re-OCR'ing everything every run).

## Known limitations / possible next steps (not blockers)
- **Line-item detail** (per-product rows) is not broken into structured fields yet — header fields +
  totals + full text are captured. Add if per-line data is needed.
- **Foreign-vendor invoices** (non-Indian GSTIN) land in `needs_review` by design — approve after a
  glance, or relax mandatory rules in `config/validation.yaml`.
- **Original-PDF download via MCP** is not exposed (data + full text are). Easy to add a
  `get_attachment` tool if required.
- **24/7 remote MCP** needs an always-on host + a stable URL (reverse proxy + domain, or a tunnel
  running as a service) — see doc 03.
- A few uncommon attachment types (e.g. `.xlsx`, `.docx`) are currently skipped at collection;
  add them to `supported_types` in `config/attachments.yaml` if vendors send those.

## Test map (what proves what)
| Area | Test file |
|---|---|
| Field extraction (formats, rates) | `tests/test_fields.py` |
| Validation + GSTIN + relevance | `tests/test_validation.py`, `tests/test_relevance.py` |
| Pipeline end-to-end, incremental, review-preserve | `tests/test_pipeline.py` |
| Canonical record + full text | `tests/test_canonical.py` |
| IMAP reader + label lifecycle | `tests/test_imap_reader.py` |
| Outcome labelling | `tests/test_labeling.py` |
| Human review actions | `tests/test_review.py` |
| MCP tools | `tests/test_mcp_server.py` |
| Monitoring / health / reconcile | `tests/test_monitoring.py` |

Run everything: `python -m pytest -q`
