# Estimated GSTR-2B / ITC MCP

**What it answers:** "What input-tax credit should Innovfix expect for period X?" — days before GSTN
publishes the real GSTR-2B (the 14th) — and, once the real 2B exists, "did it land?".

**What it is NOT:** the filed GSTR-2B. Every payload carries an explicit `basis` label saying so.

## Architecture

Pure function of **(invoice registry, period)** — no store of its own, nothing written anywhere.

```
invoice-intelligence registry (SQLite, Python FastMCP :8765)
        │  search_invoices(status=accepted, received_to?) + get_invoice per doc   ← read-only
        ▼
source.ts  →  RegistryInvoice[]           (canonical fields incl. taxable_value/cgst/sgst/igst/cess)
        ▼
compute.ts →  buildEstimate(invoices, {period})        ← pure; bucketing + eligibility + aggregation
           →  reconcileVsActual(lines, parseGstr2b(…))  ← reuses src/lib/gstr2b.ts + src/gst-core/reconcile.ts
```

- Period bucketing is **local** (invoice_date startsWith period): store-side date filters would
  silently drop rows with no extracted invoice_date — those must surface as review (NO_DATE) instead.
- `received_to` (mail-arrival cut-off, inclusive) is the **point-in-time axis**: "expected ITC for
  June as of 3 July" → `period=2026-06, received_to=2026-07-03`.

## The two explicit layers

1. **ESTIMATE label** — `basis` on every payload: expected ITC from invoices in hand; the real 2B
   depends on suppliers filing GSTR-1 by the 11th.
2. **Eligibility flags** (`config.ts`, ⚠ **PENDING SHOYAB/CA**) — a flag routes a line into the
   review bucket: excluded from the headline, listed with reasons, **never auto-included and never
   silently dropped**. Codes: NO_GSTIN, INVALID_GSTIN (incl. 99… OIDAR), OWN_GSTIN (extractor grabbed
   our own registration — real case in the registry), BUYER_MISMATCH, FOREIGN_CURRENCY (import →
   RCM, never in 2B B2B), NO_TAX_BREAKUP, HEAD_MISMATCH (vendor state vs 29-Karnataka), BLOCKED_17_5
   (seed SAC/keyword lists), RCM_SUSPECT (seed lists), NO_DATE.

## Tools

| tool | inputs | answer |
|---|---|---|
| `itc_estimate` | period, received_to? | headline ITC by head + by vendor GSTIN; review bucket with per-flag counts; needs_review pending as a caveat |
| `itc_invoices` | period, received_to?, bucket? | the per-invoice lines with flags (included / review / all) |
| `itc_reconcile` | period, file \| file_base64, received_to? | estimate vs ACTUAL portal 2B: 4(A)(5) heads diff + GSTIN+number invoice match (matched / chase-supplier / book-it) |

`file` must live under `GSTR-2B-est-mcp/` (the gitignored drop folder); `file_base64` is the
workbook itself. Parsing = `src/lib/gstr2b.ts` (portal "ITC Available" 4(A)(5) row + B2B sheet);
matching = `src/gst-core/reconcile.ts reconcilePurchasesVs2b` — both reused untouched.

## Endpoints & auth (mirror of tds-working)

- stdio: `npm run mcp:gstr2b` (needs the Python invoice MCP up)
- HTTPS: `https://gst.innovfix.ai/mcp/gstr2b-estimate` — static per-user bearer
  (`GSTR2B_EST_MCP_TOKEN_<USER>` in `.env`) or OAuth 2.1 via the portal login
  (allowlist `GSTR2B_EST_MCP_ALLOWED_EMAILS`, default JP/Shoyab/Fida); per-call audit log at
  `GSTR-2B-est-mcp/logs/access.jsonl` (call shape only, no amounts/GSTINs).

## Pending Shoyab (blocks treating the headline as claimable, not the build)

- Which Section 17(5) categories actually apply to Innovfix (seed lists in `config.ts`).
- Which inbound categories are RCM for us (June working already has "Foreign Payments - RCM",
  "Rent RCM").
- Whether the headline should net off portal-side "ITC not available" style reversals differently.
