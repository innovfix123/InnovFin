# 05 — Google Workspace Routing Rule (reference)

This is **admin configuration, not server code**. It is **already live** on the Innovfix Workspace.
The server only reads `invoices@innovfix.in`. This doc is for reference / future changes.

## What it does
A Gmail **Compliance** rule (Admin → Apps → Google Workspace → Gmail → Compliance) adds
`invoices@innovfix.in` as an extra recipient to every message that looks like an invoice, so all
invoices — from any mailbox, including internal — collect in one place automatically. New mailboxes
are covered automatically because the rule is applied at the **top org**.

## The rules in place
Two rules, both applied at the **top organisation "Innovfix Private Limited"** (this was the key
fix — a rule on a sub-OU only covers that sub-OU):

1. **Content compliance** — matches invoice keywords in Subject + Body
   (regex e.g. `(?i)(invoice|bill|receipt|gstin|credit note|debit note|payment advice|remittance|amount due|amount payable|purchase order|proforma)`).
2. **Attachment compliance** — matches invoice-like attachment file names
   (`invoice`, `inv`, `bill`, `gst`, `tax invoice`, `receipt`, `credit note`, `debit note` …).

Both are configured with:
- **Email messages to affect:** Inbound ✅ + Internal-receiving ✅
- **Match:** "If ANY of the following match"
- **Action:** Modify message → **Bypass the spam filter** ✅ → **Add more recipients** →
  `invoices@innovfix.in`
- **Account types:** Users (+ Groups, so distribution addresses are covered)

## Two lessons baked in (do not undo)
1. **Top-org scope.** Create/apply the rule with **Innovfix Private Limited** selected, not a
   sub-OU — otherwise most mailboxes are silently skipped.
2. **Bypass spam filter.** Without it, invoice copies from external senders can be spam-dropped at
   the central mailbox and never arrive.

## Broadening / tightening later
- The pipeline is the precision layer, so the rule can stay broad (recall-first). Widen the keyword
  regex / attachment names to catch more; the pipeline will file non-invoices as `not_invoice`.
- If a particular newsletter floods in, add it to an **address-list bypass** on the rule.

## Historical backfill (invoices from before the rule existed)
Mail that arrived in individual mailboxes before the rule was enabled is not in `invoices@`. To
import it, use **Google Vault** (Business Plus/Enterprise): search across the org
`after:YYYY/MM/DD (invoice OR "tax invoice" OR gst OR bill)`, **Export** as MBOX, then feed the
exported `.eml`/mbox files through the pipeline with `mail_reader.type: sample` pointed at the
export folder.
