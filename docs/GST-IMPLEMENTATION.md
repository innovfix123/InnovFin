# InnovFin — GST Automation: Implementation Reference

*The authoritative engineering map of the GST filing module: architecture, every module and route, data shapes, configuration, validation anchors, and how to extend it safely.*

**Entity:** Innovfix Private Limited · **GSTIN:** 29AAICI1603A1Z3 · **State:** Karnataka (29)
**Status:** Production — GSTR-1, GSTR-2B, GSTR-3B, RCM, reconciliations and the full multi-sheet workbook are all built and validated (~95% to the rupee against filed months).
*Last updated: 2026-06-21*

> **Companion docs.** Read these alongside this one:
> - `docs/HOW-IT-WORKS.md` — the plain-English monthly *process* (what happens, in what order, and why).
> - `_private/Innovfix - GST Workings - Master Reference (GSTR-1 & GSTR-3B).md` — the *finance methodology* and legal references the engine is ported from. **This is the spec.** The code is a faithful, test-locked port of this document.

---

## 1. Architecture

Three clean layers, each with a single responsibility. The dependency arrow points one way: routes → lib → core. Core never imports lib; lib never imports routes.

```
┌─────────────────────────────────────────────────────────────┐
│  src/app/gst/page.tsx          3-step client wizard (UI)     │
│  src/app/api/**/route.ts       thin Node route handlers      │  ← orchestration
├─────────────────────────────────────────────────────────────┤
│  src/lib/connectors/*          data sourcing (gateway/DB)    │
│  src/lib/*.ts                  file parsing, Excel output,   │  ← I/O + glue
│                                Zod schemas, AI categoriser   │
├─────────────────────────────────────────────────────────────┤
│  src/gst-core/*                pure tax math, ZERO I/O       │  ← the engine
│                                (identical in browser/server/ │
│                                 test; locked by unit tests)  │
└─────────────────────────────────────────────────────────────┘
```

**The principle that makes it reliable:** all tax logic lives in `src/gst-core/` as pure functions with no file, network, or DB access. It is byte-identical whether run in the browser, on the server, or in a test. Every core module is **locked to a real filed month by a `*.test.ts`**, so the numbers cannot silently drift. I/O (fetching, parsing, Excel) is quarantined in `src/lib/`. Routes are thin: validate input → call a pure function → return JSON or stream a file. **Business logic never lives in a route.**

**Stack:** Next.js 16.2.9 (App Router), React 19, TypeScript, Tailwind v4, Vitest. Path alias `@/*` → `src/*`. All API routes export `runtime = "nodejs"` (gateway/DB/xlsx need Node, not Edge). Read `node_modules/next/dist/docs/` before touching route code — this Next.js version has breaking changes from older conventions (see `AGENTS.md`).

**Universal business rule.** Every app sale is intra-state Karnataka B2C at 18%:
```
taxable value = money received ÷ 1.18
CGST = SGST = taxable × 9%        IGST = 0 on all sales
```
IGST appears **only** on the RCM (reverse-charge) side — imported foreign services.

---

## 2. The pure engine — `src/gst-core/`

Re-exported through `src/gst-core/index.ts`. Four modules.

### `gstr1.ts` — outward supplies (sales)
The heart of GSTR-1. Turns each app's raw transaction dump into taxable/CGST/SGST lines.

- **Constants:** `GST_RATE = 0.18`. `APP_DEFAULTS` maps each app → `{ type (parser), hsn, service }`. `APP_ORDER = ["Hima", "Sudar", "Only Care", "Unman"]` (the 4 live apps).
- **Four parsers**, all operating on an array-of-arrays (AOA) so the source format is irrelevant once read:
  - `parseInvoiceWise` — sum the **Taxable Value** column directly (Hima / dashboard exports).
  - `parseRazorpay` — keep `TYPE = payment` rows, take gross `amount`, ÷ 1.18 (Sudar, Unman).
  - `parsePhonePe` — keep `status = SUCCESS`, sum transaction amount.
  - `parseCashfree` — keep `status = SUCCESS`, sum amount.
- **Fuzzy header handling:** `findHeaderRow` scans the first ~60 rows for required tokens; `findCol` does case-insensitive substring matching. This is why a slightly re-ordered or re-labelled export still parses.
- **`toLine`** — per app: `CGST = SGST = taxable × 0.09`, `IGST = 0`, computes invoice value + round-off, attaches HSN + service string.
- **`summarise`** — groups lines into HSN-wise rows (GSTR-1 Table 12) + grand total.
- **Utilities** used across the codebase: `num` (strips `₹` and commas → number), `r2` (round to 2 dp).

### `gstr3b.ts` — the summary return & cash challan
`computeGstr3b(input) → Gstr3bResult`. Fills the official tables in order:
- **Table 3.1** — outward (B2C) + RCM liability (3.1(d)).
- **Table 4** — ITC available = RCM credit (4(A)(3), same month) + GSTR-2B credit (4(A)(5)).
- **Rule 88A offset** — IGST credit → IGST output first; **surplus IGST splits 50:50** to CGST/SGST with spillover; then CGST↔CGST, SGST↔SGST. **RCM liability is never offset by ITC — it is always paid in cash** (Sec 49(4)).
- **Cash challan** = RCM cash + regular residual + late fee + interest.

### `rcm.ts` — reverse-charge classification (Table 3.1(d))
- **Rates:** `RCM_IGST_RATE = 0.18` (foreign / import of services), `RCM_CGST_RATE = RCM_SGST_RATE = 0.09` (rent from unregistered landlord).
- **Standing vendor rules** (management-approved, hard-coded so they don't get re-derived monthly):
  - `EXCLUDE_KEYS` — apple media, oh dear, tamil rent / iniya home, incubex.
  - `RENT_KEYS` — rent jp, tipiverse, yuvanesh rent, ayush rent, b v srinivas.
  - `FOREIGN_KEYS` — agora, digital ocean, higgsfield, claude/anthropic, cursor, openrouter, slack, hostinger, google play, chatgpt/openai, lambdatest, manus, wondershare, freepik, elevenlabs, canva.
- **`classifyVendor`** — case-insensitive substring match, precedence **EXCLUDE → RENT → FOREIGN → "review"**. An unknown vendor is *never silently counted*; it goes to a review queue.
- **`computeRcm`** — rupee-rounds each line; foreign taxable × 18% = IGST; rent × 9% each.

### `reconcile.ts` — the pre-filing safety net (`TOL = 0.02`)
- **`reconcileGstr1Vs3b`** (forward) — GSTR-3B Table 3.1(a) must equal the GSTR-1 total to the rupee.
- **`reconcileGstr3bInternal`** (backward) — the 3B's own math is self-consistent: 3.1 = outward + RCM; ITC available = RCM + 2B; 6.1 liability = ITC used + cash; RCM stays in cash; challan = Σ cash + fees.
- **`reconcilePurchasesVs2b`** (cross) — match books purchase register vs GSTR-2B B2B by `gstin|invoiceNo`; flag `inBooksNotIn2b` (ITC at risk) and `in2bNotInBooks` (unbooked bill).

---

## 3. The I/O + glue layer — `src/lib/`

### Data sourcing — `src/lib/connectors/`
A pluggable auto-fetch framework. Each connector implements the `Connector` contract in `types.ts`: `{ parserType, isConfigured(), fetch(period) → { aoa, count, source } }`. It translates a provider's native shape into the common AOA the validated parser already understands.

- **`index.ts`** — the registry. `WIRING` maps app → provider:

  | App | Provider | Parser | Credentials (env) |
  |---|---|---|---|
  | Hima | `appdb` | invoicewise | `APPDB_HIMA_URL`, `APPDB_HIMA_QUERY` |
  | Sudar | `razorpay` | razorpay | `RAZORPAY_SUDAR_KEY_ID/_SECRET` |
  | Only Care | `cashfree` | cashfree | `CASHFREE_ONLY_CARE_APP_ID/_SECRET_KEY` |
  | Unman | `razorpay` | razorpay | `RAZORPAY_UNMAN_KEY_ID/_SECRET` |

  `getConnector(app)` is the factory (switches on `WIRING`, builds creds from env, returns `null` for manual apps). `getSalesPlan()` returns each app's `{app, hsn, provider, mode, configured}` for the Step-1 plan. Contains the **validated default Hima SQL** (`DEFAULT_APPDB_QUERY["Hima"]`): a `UNION ALL` of `phonepe_payments` (`checked=1 AND status=1`) + `cashfree_payments` (`status=1`), each JOINed to `coins` for pack price, filtered by `:from`/`:to`; taxable = `price / 1.18`.
- **`appdb.ts`** — MySQL connector via `mysql2/promise`. Parses a `mysql://…` URL, uses `namedPlaceholders` (`:from`/`:to`) from IST month bounds, returns rows as AOA. One `createConnection` per fetch, closed in `finally` (single-shot monthly job; no pool by design).
- **`razorpay.ts`** — paginates `GET /v1/payments` (100/page, HTTP Basic auth), keeps `status === "captured"`, paise → ₹.
- **`cashfree.ts`** — `POST /pg/settlement/recon` (cursor-paginated, 1000/page, `x-client-id`/`x-client-secret` headers); keeps `PAYMENT`/`SUCCESS` rows by **payment time** in-month; de-dupes across settlement windows.
- **`period.ts`** — IST → UTC month boundary helpers for the epoch-second API filters.
- **PhonePe has no connector** — manual upload only (the `parsePhonePe` parser handles the export when uploaded). Inside Hima it arrives as the `phonepe_payments` DB table.

### File parsing
- **`workbook.ts`** — uses **`xlsx` (SheetJS)** for *reading* uploads. `bufferToAOA` (single sheet, `cellDates:true, raw:false` to match the validated web tool), `sheetNames`, `bufferToSheets` (all sheets → `{name: AOA}`). Auto-detects CSV/XLS/XLSX.
- **`gstr2b.ts`** — `parseGstr2b(sheets)`. Reads the portal's **"ITC Available" FORM SUMMARY** sheet, pulling the **4(A)(5)** row directly (igst/cgst/sgst) so it ties to the portal to the rupee; also 4(B)(2) reversal and 4(D)(2) ineligible. `parseB2bInvoices` picks any row whose first cell matches the GSTIN regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$` (fixed columns: 0 GSTIN, 7 invoice no, 13 taxable, 14 IGST, 15 CGST, 16 SGST).
- **`bank-statement.ts`** — two parsers. `parseBankStatement` detects the header by a Narration/Description column + a Withdrawal column (**handles HDFC and Yes Bank** layouts), returns **withdrawals only** `{date, narration, amount}` (deposits ignored). `parseRcmPivot` reads an "Expense Categorisation" pivot and returns rows flagged **"RCM Applicable"** as `{vendor, amount}` — robust to column order. **The pivot is the RCM source of truth** (Master Reference §4.2); the raw-statement path is the fallback.

### Schemas & AI
- **`gstr3b-input.ts`** — the shared Zod schema (`gstr3bInputSchema`, `rcmExpenseSchema`). `.refine` requires either a pre-totalled `rcm` **or** a raw `rcmExpenses[]` list. `resolveRcm` classifies a raw list when supplied, returning both the engine input and the classification report. Used by both `gstr3b/compute` and `gstr3b/report`.
- **`rcm-llm.ts`** — the AI bank-narration categoriser via **OpenRouter → Claude** (`OPENROUTER_MODEL`, default `anthropic/claude-sonnet-4.5`, `temperature:0`). **Strictly advisory and fails soft** — returns `[]` on missing key or any error, so the deterministic path always works. `extractItems` strips markdown fences and parses the items array. AI hits are capped (`AI_CAP = 250`) and foreign/rent suggestions land in a review queue the human must confirm — the AI never books anything unattended.

### Excel output (filed format)
Writing uses **`xlsx-js-style`** (styled cells, fills, borders, number formats); reading uses plain `xlsx`. Three builders:
- **`gstr1-report.ts` → `buildGstr1Workbook`** — single "GSTR-1 Summary" sheet, the 16-column B2C layout; money format shows zeros as "–".
- **`gstr3b-report.ts` → `buildGstr3bWorkbook`** — single "GSTR-3B Summary" sheet: Table 3.1 → Table 4 → Table 6.1 → Rule 88A detail → cash-challan breakup; due date = 20th of the next month.
- **`workbook-full.ts` → `buildFullWorkbook`** — the multi-sheet "GST Working" workbook that mirrors the manual workbook sheet-for-sheet. Scope `gstr1`: GSTR-1 summary + one `{App} Sales` raw sheet each. Scope `full`: adds Final WORKINGS (with CESS column + Rule 88A), GSTR-2B summary + raw `2B - B2B` passthrough, Foreign Payments RCM, Rent RCM, and a formal Tables-3.1/4/5/6.1 summary sheet with the GSTR-1↔3B reconciliation and a methodology/notes block. (`addSheet` styled; `addRawSheet` verbatim; tab names capped at 31 chars.)
- **`format.ts` → `inr()`** — Indian-numbering format (`en-IN`), 2 dp, "—" for null/NaN.

---

## 4. API routes — `src/app/api/`

All `runtime = "nodejs"`. Uploads via `req.formData()` → `Buffer` → `bufferToAOA`/`bufferToSheets`. Validation via Zod.

| Route | Method | Purpose | Key I/O |
|---|---|---|---|
| `/api/sources` | GET | Step-1 plan: per-app `{app, hsn, provider, mode, configured}` | → `{ sources }` |
| `/api/sales` | POST | Compute GSTR-1 for a period. Per app: manual upload wins → else connector auto-fetch → else `pending` | form-data `period` + optional `file:<App>`, `type:<App>` → `{ period, lines, hsnRows, total, sources[] }` |
| `/api/gstr1/report` | POST | Stream single-sheet GSTR-1 .xlsx | JSON `{period, lines, total}` → xlsx |
| `/api/gstr2b/parse` | POST | Parse a portal GSTR-2B workbook → ITC totals | `file` → `{ itcAvailable, itcReversed, itcIneligible, invoiceCount }` |
| `/api/gstr3b/compute` | POST | Core GSTR-3B computation + reconciliations + RCM report | JSON (`gstr3bInputSchema`) → `Gstr3bResult` + `reconciliation` + `rcmReport` |
| `/api/gstr3b/report` | POST | Stream final single-sheet GSTR-3B .xlsx | same input → xlsx |
| `/api/rcm/parse` | POST | Parse bank statement **or** RCM pivot → RCM buckets | `file` → `{ foreign, rent, review[], excluded[], note, source }` (`maxDuration=120`) |
| `/api/gstr/workbook` | POST | Build the full multi-sheet "GST Working" workbook | form-data `period`, `input` (3B JSON), optional `gstr2b`+`bank` files, `scope=gstr1\|full` → xlsx (`maxDuration=300`) |

**`/api/rcm/parse` has two paths:** (1) **pivot** — if a sheet has an "RCM Applicable" pivot, use it (deterministic, validated, `source:"pivot"`); (2) **bank+AI** — else parse raw statements, keyword-classify via `classifyVendor`, send unmatched (≤250) to the LLM; foreign/rent AI hits become a **review queue** confirmed before filing (`source:"bank+ai"`).

**`/api/gstr/workbook`** re-fetches every configured app's raw transactions for the per-app detail tabs, recomputes GSTR-1, parses any uploaded 2B/bank files (preferring parsed files over typed cockpit totals), runs `computeGstr3b`, and emits the workbook. `pickB2bSheet` selects the raw portal "GSTR - 2B - B2B" sheet to pass through verbatim.

---

## 5. The cockpit UI — `src/app/gst/page.tsx`

A client-side 3-step wizard (dark glassmorphism). Header shows the GSTIN; an `<input type="month">` sets the period. `inputBody()` assembles the shared 3B request from wizard state.

1. **Sales (GSTR-1)** — on mount fetches `/api/sources` for the plan table (app · source badge auto/manual · HSN · status · manual fallback · taxable). "Fetch & compute GSTR-1" → `/api/sales`; tie-out badge appears. "Download GSTR-1 working" → `/api/gstr/workbook?scope=gstr1`.
2. **Purchases / RCM** — "Upload GSTR-2B" → `/api/gstr2b/parse` auto-fills the editable ITC 4(A)(5) fields. "Upload bank statement / RCM pivot" → `/api/rcm/parse` fills foreign (IGST 18%) + rent (CGST/SGST 9%) and surfaces the amber **"AI suggestions — confirm before adding"** review list (each with `+ add`). Late-fee / interest fields. "Compute GSTR-3B" → `/api/gstr3b/compute`.
3. **Review & File** — big **cash-challan** card; **reconciliation checklist** (forward + internal, each ✓/✗ with Δ; green "safe to file" banner only when all pass); Table 6.1 mini-table; cash-challan breakup. Downloads: final GSTR-3B report + full GST working. Filing itself happens on gst.gov.in — **the tool prepares figures; the human pastes and files.**

---

## 6. Configuration

Env keys (values in `.env`, which is gitignored; documented in `.env.example`). Convention: `{PROVIDER}_{APP}_{FIELD}`, app upper-cased with non-alphanumerics → `_` (so "Only Care" → `ONLY_CARE`).

```
OPENROUTER_API_KEY / OPENROUTER_BASE_URL / OPENROUTER_MODEL   # advisory AI categoriser
DATABASE_URL                                                  # reserved — persistence not yet built
RAZORPAY_SUDAR_KEY_ID / _KEY_SECRET                           # Sudar sales
RAZORPAY_UNMAN_KEY_ID / _KEY_SECRET                           # Unman sales
CASHFREE_ONLY_CARE_APP_ID / _SECRET_KEY                       # Only Care sales
APPDB_HIMA_URL / APPDB_HIMA_QUERY                             # Hima sales (SSH-tunnelled MySQL)
APPDB_ONLY_CARE_URL / _QUERY                                  # reserved (future cross-check)
APPDB_UNMAN_URL / _QUERY                                      # reserved (future cross-check)
```

**Hima DB tunnel.** `APPDB_HIMA_URL` points at `127.0.0.1:3307` — a forwarded port, not the remote host. The SSH tunnel is **infrastructure, not code**: a macOS launchd agent `com.innovfin.hima-tunnel` (auto-start at login, self-heal; logs at `~/Library/Logs/innovfin-hima-tunnel.log`). There is no tunnel script in the repo. Hosting this off the laptop is a standing roadmap item.

**Outbound endpoints in code:** `api.razorpay.com`, `api.cashfree.com`, `openrouter.ai` (advisory only). No other external calls.

---

## 7. Validation anchors (how we know it's right)

The engine is locked to real filed months by co-located `*.test.ts` files (run `npm test` — Vitest):

- **GSTR-1 — May 2026** (live sources): Hima ₹5,93,05,667 filed, connector matches **99.977%** (₹5,92,91,906); Only Care ₹5,00,412.71 exact; Unman ₹2,981.36 exact; Sudar ₹1,50,155.93 vs ₹1,48,382.20 filed (**+7 boundary payments**, flagged).
- **GSTR-3B — April 2026:** full engine reproduces the filed challan **₹52,52,218.18 to the rupee** — including RCM IGST ₹3,86,097.84, rent CGST/SGST ₹9,225 each, and the Rule 88A 50:50 split.

Reference fixtures live in `_private/` (filed workbooks, a sample GSTR-2B, bank statements, and the Master Reference). They are validation inputs, not runtime dependencies. `_private/web-tool/.../gstr1-core.js` is the original validated JS that `src/gst-core/gstr1.ts` was ported 1:1 from.

---

## 8. Known limitations — "the 5%"

The module is ~95% to the rupee. The remaining gap is bounded and understood:

1. **Boundary-timing payments** (e.g. Sudar's +7) — a payment captured at a gateway near a month/timezone edge can land in a different period than the filed working used. Flagged, not silently absorbed; needs a human confirm.
2. **GSTR-2B "Not Available" credits** — the parser reads 4(A)(5) directly; ITC the portal marks "Not Available" belongs in Table 4(D) and must be excluded by hand if the source sheet mixes them.
3. **New / unknown vendors** — any vendor not in the standing RCM rules goes to the review queue (never auto-counted). Genuinely new foreign vendors or landlords need a one-time classification, and a "Google Play" line invoiced by **Google India** (29AAACG0527D1ZG) is B2B (in 2B), *not* RCM.
4. **Two apps not wired** — the Master Reference describes six apps; only four (Hima, Sudar, Only Care, Unman) are live in `APP_ORDER`/`WIRING`. **Thedal** (HSN 998433, Razorpay) and **Bangalore Connect** (HSN 998599, PhonePe) are documented but not configured.
5. **No persistence** — there is no app database yet (the `DATABASE_URL` / Prisma slot is reserved but unbuilt). Each run is stateless; nothing is remembered between months except what the user re-supplies.

Per the team's direction, the module is considered done; further changes happen only on a finance-team request.

---

## 9. How to extend

- **Add an app to GSTR-1:** add it to `APP_DEFAULTS` + `APP_ORDER` in `gstr1.ts` (with its HSN + service + parser type). If it auto-fetches, add a `WIRING` entry + env creds in `connectors/index.ts`; otherwise it's manual-upload only. Add a test locking it to a known month.
- **Add a connector (new provider):** implement the `Connector` contract in a new `connectors/<provider>.ts` (auth, pagination, `fetch(period) → AOA`, fail loud), register it in the `getConnector` factory. Mirror `razorpay.ts`/`cashfree.ts`.
- **Add / change an RCM vendor rule:** edit `EXCLUDE_KEYS` / `RENT_KEYS` / `FOREIGN_KEYS` in `rcm.ts`. These are management-approved standing rules — change them deliberately and update the Master Reference.
- **Change tax logic:** edit the pure function in `gst-core/`, then update its `*.test.ts` against the relevant filed month. Never patch tax math inside a route or the UI.

---

## 10. Running it

1. **Tunnel** (for Hima's DB): the launchd agent keeps the SSH tunnel always-on. Confirm it's up if Hima returns no rows.
2. **App:** `npm run dev` → open `http://localhost:3000/gst`.
3. **Cockpit:** pick the return month → Fetch & compute GSTR-1 (Step 1) → upload 2B + bank/RCM, confirm any AI review items (Step 2) → review the challan + reconciliations, download the report/workbook (Step 3).
4. **Tests:** `npm test` (Vitest). **Lint:** `npm run lint`.

---

*This document describes the implementation. For the monthly process see `docs/HOW-IT-WORKS.md`; for the finance methodology and legal basis see the Master Reference in `_private/`.*
