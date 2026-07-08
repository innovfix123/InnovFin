# InnovFin — Purchase/Vendor TDS Classification Spec (194C / 194J)

*The classification ruleset for the Purchase/Vendor TDS MCP — how an accepted invoice is routed to a TDS section, the rate resolved, and the deductee PAN derived. Written for the CLI to wire against tds-core. **This is a first-draft grounded in tax structure + Innovfix's filed May-2026 sheets + the 29-Jun huddle notes. It goes to Shoyab/CA for validation before rates are locked into filing** — the classifier structure is buildable now; the SAC→section rows marked ⚠ need Shoyab's confirmation.*

**Entity:** Innovfix Private Limited · **GSTIN:** 29AAICI1603A1Z3 · **TAN:** BLRI14759D · **FY 2026-27 (IT Act 2025 / §392–394 codes).**

**Design (per CLI's recommendation):** SAC-code classification + a vendor-override list. SAC is the grounded signal (it's on the invoice); the override list handles known exceptions (Zocket ads). Unknown/ambiguous → review queue, never silently classified.

---

## 1. Classification precedence (the order the classifier applies)

For each accepted invoice, resolve the section in this order — first match wins:

1. **Vendor override** — if the vendor (by GSTIN/PAN or name) is in the override list (§5), use its rule. Handles vendors whose section is known regardless of SAC (Zocket-ads → 194C).
2. **SAC-code map** — else map the invoice's SAC to a section (§2).
3. **Keyword fallback** — else, if no usable SAC, infer from the service description (§3) — but **flag for review** (lower confidence).
4. **Unknown → review queue** — no confident match → `needs_review`, human classifies. Never default-classify.

> The extractor captures one **header** SAC, not per-line. For multi-service invoices (a vendor billing both advertising and subscription on one invoice), flag for review and request per-line SAC — the header SAC can misroute a mixed invoice.

---

## 2. SAC → section map ⚠ (confirm with Shoyab/CA)

SAC (Service Accounting Code) is the GST service code on the invoice. Mapping to TDS section:

| SAC group | Service nature | TDS section | New code | Rate |
|-----------|----------------|-------------|----------|------|
| **9983** (part) — advertising, market research | Advertising / media | **194C** | 1023/1024 | 1% non-co / 2% co |
| **99836** — advertising services | Advertising | **194C** | 1023/1024 | 1% / 2% |
| **9985** — support/contract services | Contract work | **194C** | 1023/1024 | 1% / 2% |
| **9982** — legal, accounting, professional | Professional fees | **194J(b)** | 1027 | 10% |
| **9983** (part) — engineering, technical, R&D | Technical services | **194J(a)** | 1026 | 2% |
| **998313/998314** — IT consulting/technical | Technical | **194J(a)** | 1026 | 2% |
| **9973** — leasing/rental of machinery | Rent — machinery | **194I(a)** | — | 2% |
| **997212** — rental of immovable property | Rent — building | **194I(b)** | 1009 | 10% |
| **9971** (part) — commission/brokerage | Commission | **194H** | 1006 | 2% |
| Pure **goods** (HSN, no service SAC) | Supply of goods | **NONE** | — | 0% |

**Rule of thumb the classifier encodes:** *advertising & contract → 194C; professional & technical → 194J; rent → 194I; commission → 194H; goods → no TDS.* The 194C-vs-194J line is the highest-risk one (§6).

> ⚠ **Shoyab must confirm the exact SAC→section rows**, especially where a SAC could plausibly be 194C or 194J (e.g. some 9983 codes span advertising *and* technical). The above is the defensible default; his filed treatment is authoritative where it differs.

---

## 3. Keyword fallback (when SAC is missing/unreadable)

Applied only if no usable SAC — and always flagged `needs_review` (lower confidence). Precedence-ordered:

- "advertisement", "advertising", "ad spend", "media", "marketing services" → **194C** (advertising)
- "contract", "labour", "job work", "AMC", "annual maintenance" → **194C** (contract)
- "professional fee", "consultancy", "legal", "audit", "accounting", "retainer" → **194J(b)** professional
- "technical", "engineering", "software development", "OTP", "verification services", "API" → **194J(a)** technical
- "commission", "brokerage", "processing fee", "gateway charges" → **194H**
- "rent", "lease", "hire" (+ property/machinery context) → **194I**
- "subscription", "license", "SaaS" → **review** (could be 194J, 195 if foreign, or exempt — see §6)

---

## 4. Deductee PAN + entity type (the 1% vs 2% split)

**Derive PAN from the vendor GSTIN** — the PAN is embedded in the GSTIN (characters 3–12). E.g. GSTIN `29AAICI1603A1Z3` → PAN `AAICI1603A`.

**Entity type from PAN 4th character** (drives 194C 1%/2% AND the challan major head 0020/0021):

| PAN 4th char | Entity | 194C rate | Major head |
|---|---|---|---|
| **C** | Company | 2% | 0020 (Corporation Tax) |
| **P** | Individual | 1% | 0021 (Income-tax other) |
| **H** | HUF | 1% | 0021 |
| **F** | Firm / LLP | 2% | 0021 |
| **A/B/T/etc.** | AOP/BOI/Trust | 2% | 0021 |

**Note:** the entity split applies to the 194C *rate* (1% individual/HUF vs 2% everyone else). For 194J the rate is 10%/2% *regardless* of entity — entity type there only drives the major head, not the rate.

**Data-quality guard (encode):** if the derived PAN == Innovfix's own PAN (`AAICI1603A`), **flag, do not inherit** — this is the recurring autofill leak seen on Razorpay/Scholiverse rows. Also flag missing/malformed PANs (wrong length/format) → review.

---

## 5. Vendor-override list (seeded from the May workbook)

Known vendors whose section/treatment is fixed regardless of SAC. **Per-service where a vendor spans sections.**

| Vendor | GSTIN/PAN | Service | Section | Rate | Note |
|--------|-----------|---------|---------|------|------|
| **Zocket** (ads) | AABCZ7555P | Advertising / META ADS | **194C-company** | 2% | The ad-spend lines |
| **Zocket** (subscription) | AABCZ7555P | Subscription charges | **194J(a)** | 2% | Same vendor, different service — per-invoice split |
| **Paysprint** | AALCP6782E | OTP/verification services | **194J(a)** | 2% | Also our PAN-verification provider |
| **Datagen** | AAGCD1543A | OTP verification | **194J(a)** | 2% | — |
| **Scholiverse** | ⚠ AAICI1603A | Subscription | **194J(a)** | 2% | ⚠ carries OUR PAN — data error, needs real PAN |
| **CFO Angle** (CA office) | AANFC0897L | Professional fees | **194J(b)** | 10% | Also reviews our filing |
| **Produco** | BWDPM9841H | Professional fees | **194J(b)** | 10% | — |
| **Directors** (Jaya Prasad, Ayush) | (internal) | Director remuneration | **194J(b)** | 10% | Code 1028, no threshold — from Tessa, not invoices |
| Foreign SaaS (Google, Anthropic, DigitalOcean, etc.) | (foreign) | SaaS/cloud | **195 / review** | varies | Some exempt per CA (see §6) |

> ⚠ **Two flags:** (1) Scholiverse's PAN in the workbook is Innovfix's own — get the real PAN. (2) "IMS" appeared in notes as an unidentified vendor — section unconfirmed, add once Shoyab identifies it.

---

## 6. Thresholds ⚠ (confirm application with Shoyab)

TDS applies only above these limits (standard statutory thresholds — confirm Innovfix's application):

- **194C:** ₹30,000 per single payment **OR** ₹1,00,000 aggregate per year to one vendor → then deduct on all.
- **194J:** ₹30,000 per year per vendor → then deduct.
- **194H:** ₹20,000 per year (confirm — some use ₹15k/₹20k).
- **194I:** ₹2,40,000 per year.
- **De-minimis:** the workbook shows tiny fees ignored ("Nobroker – ignore less amount", ₹0.23→₹0.00). Confirm the exact cutoff.

The classifier should compute the running aggregate per vendor per year to apply the 194C/194J thresholds correctly (a ₹25k invoice may be below the per-payment limit but push the annual aggregate over ₹1L → deduct).

---

## 7. Scope — what attracts purchase-side TDS at all ⚠

**In scope (services):** advertising, contracts/job-work, professional fees, technical services, commission, rent. These attract 194C/194J/194H/194I.

**Out of scope:** pure supply of **goods** (HSN-coded, no service element) — no purchase-side TDS. Reimbursements, pure product purchases → not a TDS invoice → route to `not_invoice` or a "no-TDS" bucket.

**The judgment cases (→ review, never auto):**
- **Foreign SaaS/subscriptions** — may be 195 (foreign), may be exempt per CA ruling (your filed sheet has a 195 SaaS exemption "per case law, on CA advice"). Never auto-classify foreign — flag.
- **Payment gateways** (already handled by the Gateway MCP as 194H) — if a gateway invoice appears here, route to review, don't double-count.
- **Bundled/mixed invoices** — one invoice, multiple services → review for per-line split.

---

## 8. Challan deposit codes ⚠ (from Shoyab)

The FY2026-27 codes for the sections this MCP produces:

| Section | New code | Major head |
|---|---|---|
| 194C non-company | 1023 | 0021 |
| 194C company | 1024 | 0020 |
| 194J(a) technical | 1026 | per PAN |
| 194J(b) professional | 1027 | per PAN |
| 194J(b) director remuneration | 1028 | per PAN |

> ⚠ Confirm these codes with Shoyab against a filed challan — the 194C codes (1023/1024) and 194J codes (1026/1027/1028) are from the May filing but should be verified for company-vs-non-company routing.

---

## 9. Output contract (per invoice)

The classifier emits, per accepted invoice:
`{ invoiceNumber, vendorName, vendorGstin, deducteePan, entityType, section, newCode, majorHead, rate, taxableValue (invoice value EXCL GST), tds (rate × taxable), classificationBasis (SAC/override/keyword), confidence, flags[] }`

**Rules that hold (from tds-core):**
- **TDS on taxable value, NEVER on GST** — rate × (invoice value excluding GST). GST sits in separate columns.
- **Per-service classification** — never a fixed vendor→section map for multi-service vendors.
- Unknown/low-confidence/foreign/mixed → `needs_review`, human confirms.

---

## 10. What's buildable now vs pending Shoyab

**Build now (structure — no tax judgment):**
- The SAC-based classifier with the vendor-override list (§1, §5)
- PAN-from-GSTIN derivation + entity-type split + own-PAN guard (§4)
- The invoice → tds-core wiring, the output contract (§9)
- The threshold *aggregation logic* (§6) — the mechanism, with limits as config
- Route to review for unknown/foreign/mixed (§7)

**Pending Shoyab/CA (tax rules — populate as config, don't hardcode):**
- The exact SAC→section rows ⚠ (§2) — especially 194C-vs-194J boundary SACs
- Threshold values + de-minimis cutoff ⚠ (§6)
- Scope confirmation — which categories are in/out ⚠ (§7)
- Challan codes verification ⚠ (§8)
- Scholiverse real PAN, IMS identification (§5)

> **The one firm line:** the SAC→section map and thresholds go in as **configurable inputs Shoyab validates** — the CLI builds the engine, but no SAC→section row or rate is *locked for filing* until Shoyab confirms it, because the 194C-vs-194J boundary is the ~₹1L-penalty-risk call from the huddle notes. Structure now; tax rules from finance. Same discipline as every anchor.
