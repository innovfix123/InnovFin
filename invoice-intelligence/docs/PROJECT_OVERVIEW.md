# Project Overview — Enterprise Gmail-Native Invoice Gateway (Phase 1)

## The problem
A company receives invoices scattered across multiple Gmail mailboxes, mixed with newsletters,
OTPs, meeting invites and marketing. The finance team wastes time hunting for them.

## What this delivers (Phase 1)
One **Gmail-native** gateway that automatically detects invoice emails in every configured
company mailbox and **forwards them into a single central mailbox**, auto-labeled **`Invoices`**.
The central mailbox becomes the single source of truth for invoices.

- **Recall-first:** the goal is **zero silent misses** — if an email is a probable invoice, it is
  forwarded. Extra finance mail is acceptable; a missed invoice is not.
- **Gmail-native only:** no Gmail API, IMAP, SMTP, OAuth, App Passwords or servers. Gmail's own
  filters + forwarding do the work; nothing needs to keep running.
- **Configuration-driven:** mailboxes, vendors, keywords, labels and routing are all YAML — adding
  a mailbox or vendor is a config change, never a code change.

## What it produces
A per-mailbox set of importable Gmail filters:
- **1 forwarding filter** (the single broad recall-first net) → forwards to central + labels `Invoices/Auto`.
- **7 tier label filters (P1–P7)** → tag *why* a mail looked like an invoice (observability).
- **1 review filter** → `Invoices/Review` for ambiguous mail (never blocks forwarding).
- **1 central filter** → applies `Invoices` in the central mailbox and keeps it out of spam.

## Scope
**In scope (Phase 1):** email detection, forwarding, central labeling, configuration, testing.
**Out of scope (Phase 2, not started):** attachment collection, OCR, AI field extraction,
validation, de-duplication, normalization, storage, search.

## Status
**Phase 1 is complete and validated** on the test environment (2 source mailboxes + 1 Workspace
central). 117 automated tests pass; live end-to-end forwarding + labeling confirmed. Ready for
production rollout on real company mailboxes.

## Key commands
```
python cli.py mailbox-check    # validate the mailbox/vendor registries
python cli.py gmail-build      # generate all importable filter XML into build/filters/
python cli.py recall-check     # false-negative analysis (zero silent misses)
python -m pytest               # full test suite
```
