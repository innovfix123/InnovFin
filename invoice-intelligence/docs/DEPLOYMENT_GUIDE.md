# Deployment Guide — Phase 1

## Prerequisites
- Python 3.11+ (`pip install -r requirements.txt` — PyYAML, pandas, pytest only).
- Access to each source Gmail mailbox (desktop web — the phone app cannot import filters or set
  forwarding) and the central mailbox.

## 1. Configure mailboxes
Edit `config/mailboxes.yaml` — the **Mailbox Registry**. Keep `id`s stable (filenames derive from
them). Set real source + central emails. Keep `central.routing_rules.use_invoice_signals: true`.
```yaml
central_mailboxes:
  - id: central-primary
    email: <real central address>
    routing_rules: { use_invoice_signals: true }
source_mailboxes:
  - { id: src-ap, name: "Accounts Payable", email: ap@company.com, department: Finance, priority: high, forward_target: central-primary }
```
Validate: `python cli.py mailbox-check`  → must print **OK**.

## 2. Generate filters
```
python cli.py gmail-build
```
Writes `build/filters/gmail_filters_<source-id>.xml` (one per source) and
`gmail_filters_central_<central-id>.xml`. Confirm the printout says **"Length guard: OK."**

## 3. Per source mailbox (each mailbox owner can do this on their own laptop — no shared passwords)
1. **Enable forwarding:** Settings ⚙ → **Forwarding and POP/IMAP** → **Add a forwarding address**
   → the central address → the central mailbox owner clicks the **verification** link/code.
   Keep "Keep Gmail's copy in the Inbox" — do NOT enable "forward all mail."
2. **Import filters:** Settings → **Filters and Blocked Addresses** → **Import filters** → select
   that mailbox's XML → **Select: All** → **Create filters**. (If old filters exist, delete them
   first to avoid duplicates.)
3. Gmail auto-creates the labels (`Invoices/Auto`, `Invoices/Tier/*`, `Invoices/Review`).

## 4. Central mailbox (once)
Settings → Filters → **Import filters** → `gmail_filters_central_<id>.xml` → tick **"Apply to
existing email"** → **Create filters**. Confirm the `Invoices` label appears.

## 5. Verify (live)
- Send a real invoice into a source mailbox → confirm it reaches Central and gets `Invoices`.
- Send a newsletter/OTP → confirm it does NOT reach Central.
- Confirm no invoice is missed (check Central Inbox and Spam).

## Ongoing operations
| Task | Action |
|---|---|
| Add a mailbox | add to `mailboxes.yaml` → `gmail-build` → import that one file + verify forwarding |
| Remove a mailbox | set `active: false` → `gmail-build`; delete its Gmail filters + forwarding |
| Update vendors | edit `config/trusted_vendors.yaml` → `gmail-build` → re-import |
| Update keywords | edit `config/invoice_keywords.yaml` / `query_engine.yaml` → `gmail-build` → re-import |
| Rename labels | edit `config/labels.yaml` → `gmail-build` → re-import |

## Scale note
Consumer Gmail forwards ~500/day per mailbox; Google Workspace 10,000/day. For higher volume, use
Workspace. If the company has **Workspace admin access**, a single Admin content-compliance/routing
rule can deploy to all mailboxes at once (per-mailbox XML remains the fallback).
