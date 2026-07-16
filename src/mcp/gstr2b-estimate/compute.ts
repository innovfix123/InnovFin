/**
 * Estimated GSTR-2B / ITC — pure compute. No I/O, no clock, no store of its own: the estimate is a
 * pure function of (registry invoices, period), and the reconciliation of (estimate lines, parsed
 * portal 2B). The 2B parse (src/lib/gstr2b.ts) and the books↔2B matcher
 * (src/gst-core/reconcile.ts reconcilePurchasesVs2b) are REUSED as-is — both already tested.
 *
 * Two explicit layers, per the working agreement:
 *  1. Everything is labelled ESTIMATE (invoices in hand ≠ filed GSTR-2B).
 *  2. Eligibility is a FLAG layer: 17(5)/RCM/GSTIN problems route a line into the review bucket —
 *     excluded from the headline, listed with reasons, never auto-included (rules ⚠ pending Shoyab).
 */
import type { Gstr2bResult } from "@/lib/gstr2b";
import { reconcilePurchasesVs2b, type PurchaseInvoice } from "@/gst-core/reconcile";
import { ELIGIBILITY_RULES, GSTIN_RE, HOME_STATE_CODE, isOwnGstin, type EligibilityRules } from "./config";
import { monthLabel, round2 } from "./util";
import type {
  EligibilityFlag, EstimateLine, EstimateVsActual, ItcEstimate, ItcHeads,
  RegistryInvoice, ReviewLineSummary, VendorRollup,
} from "./types";

export const ESTIMATE_BASIS =
  "ESTIMATE — expected ITC computed from vendor invoices in hand (accepted rows of the invoice registry). " +
  "This is NOT the filed GSTR-2B: GSTN generates that on the 14th from supplier GSTR-1 filings, and an " +
  "invoice in hand reaches the real 2B only if its supplier files on time.";

export const ELIGIBILITY_NOTE =
  "⚠ ITC-eligibility rules (Section 17(5) blocked credits, reverse charge, GSTIN checks) are FIRST-DRAFT " +
  "pending Shoyab/CA (config.ts). Flagged invoices are EXCLUDED from the headline and listed under review — " +
  "nothing is auto-included.";

/** Rupee tolerance, same as gst-core: money math full-precision, comparisons at the paise. */
const TOL = 0.02;

export const zeroHeads = (): ItcHeads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const addHeads = (acc: ItcHeads, h: ItcHeads): void => {
  acc.igst += h.igst; acc.cgst += h.cgst; acc.sgst += h.sgst; acc.cess += h.cess;
};
const roundHeads = (h: ItcHeads): ItcHeads => ({ igst: round2(h.igst), cgst: round2(h.cgst), sgst: round2(h.sgst), cess: round2(h.cess) });
const headsTotal = (h: ItcHeads): number => h.igst + h.cgst + h.sgst + h.cess;

const lineItc = (inv: RegistryInvoice): ItcHeads =>
  ({ igst: inv.igst ?? 0, cgst: inv.cgst ?? 0, sgst: inv.sgst ?? 0, cess: inv.cess ?? 0 });

/** Evaluate one invoice against the eligibility layer → flags (empty = clean → headline). */
export function evaluateFlags(inv: RegistryInvoice, rules: EligibilityRules = ELIGIBILITY_RULES): EligibilityFlag[] {
  const flags: EligibilityFlag[] = [];
  const gstin = (inv.vendorGstin ?? "").trim().toUpperCase();

  if (!gstin) {
    flags.push({ code: "NO_GSTIN", detail: "no vendor GSTIN captured — B2B ITC only flows via a registered supplier; if the supplier is unregistered this may instead be an RCM supply (e.g. rent)" });
  } else if (!GSTIN_RE.test(gstin)) {
    flags.push({
      code: "INVALID_GSTIN",
      detail: gstin.startsWith("99")
        ? `"${gstin}" looks like a non-resident/OIDAR registration — import of service (RCM territory), not a 2B B2B credit`
        : `"${gstin}" is not a valid 15-character GSTIN — correct it via set_invoice_field`,
    });
  } else if (isOwnGstin(gstin)) {
    flags.push({ code: "OWN_GSTIN", detail: `vendor GSTIN ${gstin} is Innovfix's own registration — the extractor grabbed the buyer GSTIN; correct the vendor GSTIN` });
  }

  const buyer = (inv.buyerGstin ?? "").trim().toUpperCase();
  if (buyer && GSTIN_RE.test(buyer) && !isOwnGstin(buyer)) {
    flags.push({ code: "BUYER_MISMATCH", detail: `billed to ${buyer}, which is not an Innovfix registration — ITC belongs to whoever the invoice names` });
  }

  const ccy = (inv.currency ?? "").trim().toUpperCase();
  if (ccy && !["INR", "RS", "₹"].includes(ccy)) {
    flags.push({ code: "FOREIGN_CURRENCY", detail: `${ccy} invoice — import of service is self-assessed under RCM (IGST via GSTR-3B 3.1(d) / 4(A)(2)); it never appears in the 2B B2B tables` });
  }

  const itc = lineItc(inv);
  const anyTax = itc.igst > 0 || itc.cgst > 0 || itc.sgst > 0 || itc.cess > 0;
  if (!anyTax) {
    flags.push({ code: "NO_TAX_BREAKUP", detail: "no CGST/SGST/IGST amounts extracted — a zero-rated/exempt supply carries no ITC; if tax IS on the PDF, fill the heads via set_invoice_field" });
  }

  // Head-vs-state consistency (only meaningful for a valid standard GSTIN with tax on it).
  if (GSTIN_RE.test(gstin) && anyTax) {
    const vendorState = gstin.slice(0, 2);
    if (vendorState === HOME_STATE_CODE && itc.igst > 0) {
      flags.push({ code: "HEAD_MISMATCH", detail: `intra-state vendor (${vendorState}) charged IGST — check the place of supply before counting` });
    }
    if (vendorState !== HOME_STATE_CODE && (itc.cgst > 0 || itc.sgst > 0)) {
      flags.push({ code: "HEAD_MISMATCH", detail: `inter-state vendor (state ${vendorState}) charged CGST/SGST — another state's CGST/SGST is not creditable to ${HOME_STATE_CODE}-Karnataka (hotel-style place of supply?); review` });
    }
  }

  const name = (inv.vendorName ?? "").toLowerCase();
  const sac = (inv.hsnSac ?? "").trim();
  for (const r of rules.blockedSacPrefixes) {
    if (sac && sac.startsWith(r.match)) flags.push({ code: "BLOCKED_17_5", detail: `SAC ${sac} → ${r.label} — blocked-credit suspect (⚠ pending Shoyab)` });
  }
  for (const r of rules.blockedKeywords) {
    if (name.includes(r.match)) flags.push({ code: "BLOCKED_17_5", detail: `vendor name matches "${r.match}" → ${r.label} — blocked-credit suspect (⚠ pending Shoyab)` });
  }
  for (const r of rules.rcmSacPrefixes) {
    if (sac && sac.startsWith(r.match)) flags.push({ code: "RCM_SUSPECT", detail: `SAC ${sac} → ${r.label} — if RCM applies, the credit comes from self-payment in 3B, not this 2B line (⚠ pending Shoyab)` });
  }
  for (const r of rules.rcmKeywords) {
    if (name.includes(r.match)) flags.push({ code: "RCM_SUSPECT", detail: `vendor name matches "${r.match}" → ${r.label} — if RCM applies, the credit comes from self-payment in 3B, not this 2B line (⚠ pending Shoyab)` });
  }

  return flags;
}

/** Evaluate one registry invoice into an estimate line (bucket decided by the flags). */
export function evaluateLine(inv: RegistryInvoice, rules: EligibilityRules = ELIGIBILITY_RULES): EstimateLine {
  const flags = evaluateFlags(inv, rules);
  const itc = lineItc(inv);
  return {
    docId: inv.docId,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    receivedDate: inv.receivedDate,
    vendorName: inv.vendorName,
    vendorGstin: inv.vendorGstin,
    hsnSac: inv.hsnSac,
    currency: inv.currency,
    taxableValue: inv.taxableValue,
    total: inv.total,
    itc: roundHeads(itc),
    itcTotal: round2(headsTotal(itc)),
    included: flags.length === 0,
    flags,
  };
}

const toReviewSummary = (l: EstimateLine): ReviewLineSummary => ({
  docId: l.docId,
  vendorName: l.vendorName,
  vendorGstin: l.vendorGstin,
  invoiceNumber: l.invoiceNumber,
  invoiceDate: l.invoiceDate,
  total: l.total,
  itcTotal: l.itcTotal,
  flags: l.flags.map((f) => `${f.code} — ${f.detail}`),
});

export interface EstimateOptions {
  period: string;               // YYYY-MM — the 2B period being estimated
  receivedTo?: string | null;   // the point-in-time cut already applied to `invoices` by the source
  rules?: EligibilityRules;
  needsReviewPending?: { count: number; totalInclGst: number } | null;
}

/**
 * Bucket + evaluate + aggregate. `invoices` = ALL accepted registry rows (already received_to-cut
 * by the source): dated-in-period lines are evaluated, undated lines join the review bucket
 * (NO_DATE — they might belong here), other months' lines are only counted.
 */
export function buildEstimate(invoices: RegistryInvoice[], opts: EstimateOptions): { estimate: ItcEstimate; lines: EstimateLine[] } {
  const rules = opts.rules ?? ELIGIBILITY_RULES;
  const inPeriod: RegistryInvoice[] = [];
  const undated: RegistryInvoice[] = [];
  let outOfPeriod = 0;
  for (const inv of invoices) {
    if (!inv.invoiceDate) undated.push(inv);
    else if (inv.invoiceDate.startsWith(opts.period)) inPeriod.push(inv);
    else outOfPeriod++;
  }

  const lines: EstimateLine[] = [
    ...inPeriod.map((i) => evaluateLine(i, rules)),
    ...undated.map((i) => {
      const l = evaluateLine(i, rules);
      l.flags.push({ code: "NO_DATE", detail: "no invoice date extracted — cannot place in a 2B period; if dated, it may belong to this month" });
      l.included = false;
      return l;
    }),
  ];

  const included = lines.filter((l) => l.included);
  const review = lines.filter((l) => !l.included);

  const byVendorMap = new Map<string, VendorRollup>();
  const estHeads = zeroHeads();
  let estTaxable = 0;
  for (const l of included) {
    addHeads(estHeads, l.itc);
    estTaxable += l.taxableValue ?? 0;
    const key = (l.vendorGstin as string).toUpperCase(); // included ⇒ valid GSTIN by construction
    const v = byVendorMap.get(key) ?? { gstin: key, vendorName: l.vendorName, invoices: 0, taxable: 0, itc: zeroHeads(), itcTotal: 0 };
    v.invoices += 1;
    v.taxable += l.taxableValue ?? 0;
    addHeads(v.itc, l.itc);
    v.vendorName = v.vendorName ?? l.vendorName;
    byVendorMap.set(key, v);
  }
  const byVendor = [...byVendorMap.values()]
    .map((v) => ({ ...v, taxable: round2(v.taxable), itc: roundHeads(v.itc), itcTotal: round2(headsTotal(v.itc)) }))
    .sort((a, b) => b.itcTotal - a.itcTotal);

  const revHeads = zeroHeads();
  const byFlag: Record<string, number> = {};
  for (const l of review) {
    addHeads(revHeads, l.itc);
    for (const f of l.flags) byFlag[f.code] = (byFlag[f.code] ?? 0) + 1;
  }

  const nrp = opts.needsReviewPending ?? null;
  const caveats = [
    "Counts only invoices in hand — suppliers may report purchases the mailbox never received, so the real 2B can be larger.",
    "Supplier-filing risk — an invoice in hand lands in this period's 2B only if the supplier files GSTR-1 by the 11th; late filers push the ITC into a later 2B.",
    "Reverse-charge ITC (imports, notified categories) is self-assessed in GSTR-3B and never enters the 2B B2B tables — such lines are flagged under review, not counted.",
    opts.receivedTo ? `Point-in-time view — only invoices received on or before ${opts.receivedTo} are counted.` : null,
    nrp && nrp.count > 0 ? `${nrp.count} invoice(s) ≈ ₹${nrp.totalInclGst.toLocaleString("en-IN")} (incl. GST) sit in needs_review for this window — approve them at /invoices to pull them into the estimate.` : null,
    undated.length > 0 ? `${undated.length} accepted invoice(s) carry no invoice date — they sit in the review bucket and may belong to this period.` : null,
  ].filter((c): c is string => c !== null);

  const estimate: ItcEstimate = {
    basis: ESTIMATE_BASIS,
    eligibilityNote: ELIGIBILITY_NOTE,
    period: opts.period,
    periodLabel: monthLabel(opts.period),
    receivedTo: opts.receivedTo ?? null,
    registry: {
      acceptedFetched: invoices.length,
      inPeriod: inPeriod.length,
      undated: undated.length,
      outOfPeriod,
      needsReviewPending: nrp,
    },
    estimate: {
      invoices: included.length,
      vendors: byVendor.length,
      taxable: round2(estTaxable),
      itc: roundHeads(estHeads),
      itcTotal: round2(headsTotal(estHeads)),
      byVendor,
    },
    underReview: {
      invoices: review.length,
      potentialItc: roundHeads(revHeads),
      potentialItcTotal: round2(headsTotal(revHeads)),
      byFlag,
      lines: review.map(toReviewSummary),
    },
    caveats,
  };
  return { estimate, lines };
}

/**
 * Estimate lines → gst-core PurchaseInvoice rows for the GSTIN+number identity match. Review flags
 * gate the CLAIM, not presence in the 2B — a 17(5)-suspect line the supplier filed still matches —
 * so ALL lines with a valid GSTIN and an invoice number join; the rest are reported as excluded.
 */
export function toPurchaseInvoices(lines: EstimateLine[]): { books: PurchaseInvoice[]; excluded: Array<{ docId: string; vendorName: string | null; reason: string }> } {
  const books: PurchaseInvoice[] = [];
  const excluded: Array<{ docId: string; vendorName: string | null; reason: string }> = [];
  for (const l of lines) {
    const gstin = (l.vendorGstin ?? "").trim().toUpperCase();
    if (!GSTIN_RE.test(gstin)) {
      excluded.push({ docId: l.docId, vendorName: l.vendorName, reason: gstin ? `invalid vendor GSTIN "${gstin}"` : "no vendor GSTIN" });
      continue;
    }
    if (!l.invoiceNumber) {
      excluded.push({ docId: l.docId, vendorName: l.vendorName, reason: "no invoice number" });
      continue;
    }
    books.push({ gstin, invoiceNo: l.invoiceNumber, taxable: l.taxableValue ?? 0, igst: l.itc.igst, cgst: l.itc.cgst, sgst: l.itc.sgst });
  }
  return { books, excluded };
}

/** Hold the estimate against the ACTUAL portal GSTR-2B (already parsed by src/lib/gstr2b.ts). */
export function reconcileVsActual(
  lines: EstimateLine[],
  twoB: Gstr2bResult,
  opts: { period: string; receivedTo?: string | null },
): EstimateVsActual {
  const included = lines.filter((l) => l.included);
  const est = zeroHeads();
  for (const l of included) addHeads(est, l.itc);
  const all = zeroHeads();
  for (const l of lines) addHeads(all, l.itc);

  const a = twoB.itcAvailable;
  const diff = {
    igst: round2(a.igst - est.igst),
    cgst: round2(a.cgst - est.cgst),
    sgst: round2(a.sgst - est.sgst),
    total: round2(a.igst + a.cgst + a.sgst - (est.igst + est.cgst + est.sgst)),
  };

  const { books, excluded } = toPurchaseInvoices(lines);
  const match = reconcilePurchasesVs2b(books, twoB.invoices);

  const estR = roundHeads(est);
  const allR = roundHeads(all);
  return {
    basis:
      "Estimate vs ACTUAL — left side is the ESTIMATE from invoices in hand (headline = clean lines only); " +
      "right side is the ACTUAL GST-portal GSTR-2B workbook (ITC Available 4(A)(5) + B2B tables) as parsed by src/lib/gstr2b.ts.",
    period: opts.period,
    periodLabel: monthLabel(opts.period),
    receivedTo: opts.receivedTo ?? null,
    headline: {
      estimate: { ...estR, total: round2(headsTotal(est)), invoices: included.length },
      estimateWithReview: { ...allR, total: round2(headsTotal(all)), invoices: lines.length },
      actual2b: { igst: a.igst, cgst: a.cgst, sgst: a.sgst, taxable: a.taxable, invoices: twoB.invoices.length, total: round2(a.igst + a.cgst + a.sgst) },
      diff,
      ok: Math.abs(diff.igst) <= TOL && Math.abs(diff.cgst) <= TOL && Math.abs(diff.sgst) <= TOL,
    },
    invoiceMatch: {
      matched: match.matched.length,
      matchedWithTaxDiff: match.matched.filter((m) => Math.abs(m.taxDiff) > TOL),
      inBooksNotIn2b: match.inBooksNotIn2b,
      in2bNotInBooks: match.in2bNotInBooks,
      ok: match.ok,
    },
    excludedFromMatch: excluded,
    actual2bExtras: { itcReversed: twoB.itcReversed, itcIneligible: twoB.itcIneligible },
    caveats: [
      "inBooksNotIn2b — the supplier hasn't filed the invoice → that ITC is at risk this period; chase the supplier.",
      "in2bNotInBooks — the supplier filed an invoice the registry never captured → check invoices@ / book it, then re-run.",
      "The headline diff compares the CLEAN estimate to the 2B 4(A)(5) row — review-bucket lines the supplier did file (e.g. 17(5) suspects) legitimately widen it; estimateWithReview gives the upper bound.",
      estR.cess > TOL ? `The estimate carries ₹${estR.cess.toLocaleString("en-IN")} cess, which the 2B summary-row parse does not cover — check the workbook's cess column manually.` : null,
    ].filter((c): c is string => c !== null),
  };
}
