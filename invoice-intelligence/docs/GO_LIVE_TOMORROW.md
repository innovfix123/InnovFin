# Go-Live Checklist (with Manager — needs Workspace Admin access)

Central mailbox = **`invoices@innovfix.in`** (plural "s"). Everything on the code side is DONE,
tested (232 tests), stress-verified (1000 invoices, zero miss), and health-green. Only the items
below need Admin/Workspace access.

## A. RULES — Admin → Apps → Google Workspace → Gmail → Compliance
Rules already exist and are matching, BUT the central copy isn't arriving (Email Log showed only
1 recipient → the rule isn't adding `invoices@`). Fix both rules:

**A1. EDIT (both rules — content compliance + attachment compliance):**
- Open rule → **Edit** → **Modify message → Add more recipients**:
  - ✅ the **checkbox is TICKED** (not just the address typed), AND
  - address is EXACTLY `invoices@innovfix.in` (plural **s**, no typo/space).
- **SAVE** (editing an existing rule shows SAVE, not ADD SETTING — that's correct).

**A2. ADD loop-prevention exception (both rules):**
- In the rule → find **exceptions / "do not apply if…"** → Add → Advanced content match →
  Location **Full header** → Match **regex** → `(?i)X-Invoice-Routed:\s*true` → SAVE.
- Why: the routed copy carries the `X-Invoice-Routed: true` header we stamp; this makes the rule
  skip it → no loop. (This replaces the per-OU disable that the console didn't expose.)

**A3. DELETE:** nothing. Rules are correct — only fix the recipient + add the exception.

## B. OU — nothing to change
Keep the `Invoice-Central` OU holding `invoices@`. No delete/edit needed (loop prevention is now
the header exception in A2, not an OU toggle).

## C. IMAP + App Password (central mailbox)
- IMAP access: already ON (verify: invoices@ → Settings → Forwarding and POP/IMAP → IMAP enabled).
- 2-Step Verification: done. Now create the **App Password**:
  `myaccount.google.com/apppasswords` → name `invoice-pipeline` → **Create** → copy the 16-char
  code, keep it safe (never in chat/repo).

## D. Google Vault — ONLY for historical (1 June → now) backfill (optional)
- **If Vault is available** (Business Plus/Enterprise): Vault → search
  `after:2026/06/01 (invoice OR gst OR "tax invoice" OR bill)` across the org → **Export** →
  give the exported .eml/mbox to the pipeline offline folder → `python cli.py pipeline`.
- **If no Vault:** going-forward only (the rule handles all NEW mail). Not blocking the MCP handoff.

## E. Go-live switch (code side — do AFTER A + C are done)
1. `setx INVOICE_IMAP_PASSWORD "the 16-char app password"`  (then open a NEW terminal)
2. `config/attachments.yaml`: change `type: sample` → **`type: imap`**
3. `config/storage.yaml`: set **`fallback_to_sqlite: false`** (production fail-loud)
4. Verify: `python cli.py health` → HEALTHY, then `python cli.py collect` → `python cli.py pipeline`
5. `python cli.py search` → real invoices from `invoices@` in the DB.

## F. Hand to manager (MCP → Claude)
- `docs/MCP.md` has the Claude Desktop / Claude Code registration config.
- Manager adds `python -m mcp_server.server` as an MCP server → queries invoices from Claude.

---
### Order tomorrow: A → C → E → (test) → D (if Vault) → F
Live flow after A+C+E: vendor invoice → any company mailbox → (rule) → `invoices@` → IMAP pipeline
→ OCR/parse → validate → dedup → canonical JSON → PostgreSQL → search → MCP.
