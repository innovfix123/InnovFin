# InnovFin — GST Automation: How It Works

*The end‑to‑end monthly process, from raw payment data to the cash challan Shoyab pastes into the portal.*

**Entity:** Innovfix Private Limited · **GSTIN:** 29AAICI1603A1Z3 · **State:** Karnataka (29)
**Returns:** monthly **GSTR‑1** (due 11th) and **GSTR‑3B** (due 20th)
*Last updated: 2026‑06‑13*

---

## 1. The goal

Every month Innovfix files two GST returns:

| Return | What it reports | Due |
|---|---|---|
| **GSTR‑1** | *What you sold* and the GST you charged (outward supplies) | 11th |
| **GSTR‑3B** | A *summary* that nets sales tax against credits → the **cash to pay** (the "challan") | 20th |

The whole point of the tool is to produce that final challan **automatically** — an "AI Shoyab" — so the human only **reviews the checks and pastes the numbers** into the GST portal, instead of building them by hand across spreadsheets.

**One universal rule for Innovfix:** all app sales are **intra‑state Karnataka B2C**, taxed at **18%**:

```
taxable value = money received ÷ 1.18
CGST = SGST = taxable × 9%          (IGST is always 0 on sales)
```

IGST appears **only** on the reverse‑charge (RCM) side — imported foreign services.

---

## 2. The apps and where their money comes from

Four active apps, each selling through a different payment rail:

| App | Sales source | Connector | How it's read |
|---|---|---|---|
| **Hima** | Its own app **DB** (PhonePe + Cashfree coin purchases) | `appdb` | successful coin‑pack purchases × pack price |
| **Sudar** | **Razorpay** API | `razorpay` | captured payments, gross amount |
| **Only Care** | **Cashfree** API | `cashfree` | successful settlements |
| **Unman** | **Razorpay** API | `razorpay` | captured payments, gross amount |

> *Thedal* and *Bangalore Connect* were dropped from scope (can be re‑added later).

---

## 3. The data journey

```
 SOURCES              CONNECTORS              CORE ENGINE                 OUTPUT
 Hima app DB ─┐
 Razorpay ────┼─► fetch + translate ─► GSTR-1  (sales, ~₹6 Cr) ─┐
 Cashfree ────┘      (per-app parser)                           │
                                                                ├─► GSTR-3B ─► RECONCILE ─► CASH CHALLAN
 GST portal 2B ─────► (typed in) ───────► ITC credit ───────────┤   engine      checks      + Excel report
 Expense list ──────► RCM classifier ───► RCM tax ──────────────┘  (Rule 88A)
```

---

## 4. Step by step

### Step 1 — Collect the sales → GSTR‑1  *(cockpit Step 1)*

For each app, a **connector** reaches its source and pulls the month's **successful** payments:

- **Hima** → MySQL app DB over an SSH tunnel: successful (`status=1`) coin‑pack purchases across both gateways, valued at the pack price from the `coins` table.
- **Sudar / Unman** → Razorpay API: only **captured** payments (excludes failed / settlement / refund rows).
- **Only Care** → Cashfree recon API: only **SUCCESS** payments, by payment date.

Each source speaks a different language (JSON, recon API, DB rows); the connector **translates** it into one common table, and a **validated parser** sums it the exact way the manual working does. Apply the universal `÷ 1.18` rule → each app's taxable + CGST + SGST. Add the four apps → the **GSTR‑1 total** (~₹6 Cr taxable for May 2026).

### Step 2 — Collect credits & reverse charge  *(cockpit Step 2)*

Two inputs feed the GSTR‑3B:

- **ITC (Input Tax Credit)** — GST already paid on purchases, which offsets the GST you owe on sales. Source: **GSTR‑2B**, downloaded from the GST portal. *(Currently the totals are typed in; an auto‑parser is the next build.)*
- **RCM (Reverse Charge)** — purchases where **you** owe the GST instead of the supplier:
  - **Foreign / import of services** (Agora, Anthropic, Google, AWS…) → **IGST 18%**, added on top of the INR paid.
  - **Rent from an unregistered landlord** → **CGST 9% + SGST 9%**.

  The **RCM classifier** takes the expense list and tags each line *foreign / rent / exclude* using the standing vendor rules, and sends any **unknown vendor to a "review" queue** so nothing is silently mis‑counted. Quirk: RCM is **paid in cash but comes straight back as ITC** the same month.

### Step 3 — Assemble GSTR‑3B (the tax math)  *(the engine)*

The engine fills the official tables in order:

| Table | What it is |
|---|---|
| **3.1** | Outward sales **+** RCM liability (what you owe) |
| **4** | ITC available = GSTR‑2B credit **+** RCM credit |
| **Rule 88A** | Apply credit to liability: IGST credit first; **surplus IGST splits 50:50** to CGST/SGST; CGST↔CGST, SGST↔SGST. **RCM is never offset — it goes out in cash.** |
| **6.1** | What's left after credit = **the cash challan** |

### Step 4 — Reconcile (the safety net)

Three automatic checks — the ones Shoyab does by hand — each reporting *expected / actual / difference*:

- **Forward:** GSTR‑1 total **=** GSTR‑3B Table 3.1(a) (must be 0 difference).
- **Backward:** the 3B's own math is self‑consistent (credits add up; liability = credit used + cash; challan ties out; RCM stays in cash).
- **Cross:** the books purchase register **vs** GSTR‑2B — flags *in‑books‑not‑in‑2B*, *in‑2B‑not‑in‑books*, and tax differences.

A mismatch is caught **before** filing, not after.

### Step 5 — Final report  *(cockpit Step 3)*

The engine writes the **GSTR‑3B Excel in the filed format** — the challan plus every table — which Shoyab pastes into the portal.

---

## 5. Key tax terms (plain English)

| Term | Meaning |
|---|---|
| **Taxable value** | Sale amount *excluding* GST (= gross ÷ 1.18) |
| **CGST / SGST** | The two halves of intra‑state GST (9% each); equal because everything is within Karnataka |
| **ITC** | Input Tax Credit — GST paid on purchases, set off against GST on sales |
| **GSTR‑2B** | Portal‑generated statement of the ITC available to you |
| **RCM** | Reverse Charge — the *buyer* pays the GST (foreign services, unregistered rent); paid in cash, reclaimed as ITC |
| **Rule 88A** | The order credits are used: IGST first, surplus 50:50 to CGST/SGST |
| **Challan** | The net cash actually paid to the government |

---

## 6. How the code is laid out

- **Core (pure math, no I/O)** — `src/gst-core/`
  - `gstr1.ts` — sales parsers + the `÷1.18` / CGST / SGST logic
  - `gstr3b.ts` — Tables 3.1 / 4 / 6.1, Rule 88A offset, cash challan
  - `rcm.ts` — vendor classifier (foreign / rent / exclude / review) + Table 3.1(d)
  - `reconcile.ts` — forward / backward / cross checks
- **Connectors (I/O)** — `src/lib/connectors/`: `razorpay.ts`, `cashfree.ts`, `appdb.ts` (fetch + translate per app)
- **API routes (engine entry points)** — `POST /api/sales`, `POST /api/gstr3b/compute` (also returns reconciliations + RCM classification), `POST /api/gstr3b/report`
- **Cockpit (UI)** — `src/app/gst/page.tsx`, the 3‑step wizard

Each core module is **locked to a real filed month by tests**, so the numbers can't quietly drift.

---

## 7. Automated vs still manual

| Stage | Status |
|---|---|
| Hima / Sudar / Only Care / Unman sales | ✅ auto‑fetched |
| GSTR‑1 computation | ✅ auto |
| GSTR‑3B tax math (3.1 / 4 / 6.1, Rule 88A) | ✅ auto |
| RCM classification logic | ✅ auto (in the engine) |
| Reconciliations | ✅ auto |
| Final GSTR‑3B Excel | ✅ auto |
| **GSTR‑2B → ITC totals** | ⏳ manual (download + type; auto‑parser planned) |
| **RCM expense‑list ingest** | ⏳ manual (upload/feed planned) |
| Reconciliations + review queue shown in the UI | ⏳ planned |

---

## 8. How we know it's right (validation anchors)

- **GSTR‑1 — May 2026**, reproduced from live sources:
  - Hima ₹5,93,05,667 filed · connector matches to **99.977%** (₹5,92,91,906)
  - Only Care **₹5,00,412.71** — exact · Unman **₹2,981.36** — exact
  - Sudar — connector ₹1,50,155.93 vs filed ₹1,48,382.20 (**+7 boundary payments**, flagged for confirmation)
- **GSTR‑3B — April 2026**: full engine reproduces the filed challan **₹52,52,218.18** to the rupee (incl. RCM IGST ₹3,86,097.84 + rent CGST/SGST ₹9,225 each, and the Rule 88A 50:50 split).
- Test suite: **45 passing**, TypeScript clean.

---

## 9. Running it

1. **Tunnel** (for Hima's DB): a macOS launchd agent (`com.innovfin.hima-tunnel`) keeps the SSH tunnel always‑on (auto‑start at login, self‑heal). Logs at `~/Library/Logs/innovfin-hima-tunnel.log`.
2. **App:** `npm run dev` → open **http://localhost:3000/gst**.
3. In the cockpit: pick the **return month** → **Fetch & compute GSTR‑1** (Step 1) → enter 2B/RCM (Step 2) → **review the challan + download the report** (Step 3).

---

## 10. Roadmap (to full "paste‑and‑file")

1. **GSTR‑2B parser** — auto‑fill the ITC totals (the last hand‑typed input).
2. **RCM ingest** — upload the expense list / bank pivot straight into the classifier.
3. **Surface reconciliations + RCM review queue** in cockpit Step 3.
4. **Host off the laptop** — run the tool + tunnel on an always‑on server (or give the server direct DB access), so nothing depends on the Mac being awake.

---

*See also `_private/Innovfix - GST Workings - Master Reference (GSTR‑1 & GSTR‑3B).md` for the underlying finance methodology and legal references.*
