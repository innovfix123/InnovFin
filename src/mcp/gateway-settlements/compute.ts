/**
 * compute_gateway_194H — the 194H (commission / brokerage) pipeline core.
 *
 * THE FILED 194H IS "AS PER INVOICE": 2% of each gateway's monthly commission INVOICE (GST-exclusive;
 * the GST sits in separate IGST/CGST/SGST columns), NOT the settlement-fee total. The gateway PG APIs
 * do NOT expose that invoice — it comes from GSTR-2B (e.g. Cashfree invoice CF/26-27/…) or the invoice/
 * settlement report, supplied via `invoiceLines`. So this module treats the INVOICE figure as
 * authoritative for the 194H, and uses the live settlement-fee figure (the connectors) as a
 * RECONCILIATION cross-check (does transaction-level billing tie to the invoice?). PhonePe has no API
 * at all → invoice/manual only.
 *
 * Rate/code/head come from tds-core (194H = 2%, code 1006, head 0020). 194H carry-forward: a prior
 * month's shortfall + its 201(1A) interest (tds-core.interest201_1A) is added to the current deposit.
 *
 * ANCHOR — NOT locked. Filed May-2026 194H = ₹26,865.70 (invoice basis). Supply the GSTR-2B invoice
 * figures via invoiceLines to reconcile against it; the live settlement-fee total alone will not match
 * (different basis) and PhonePe is missing until its manual figure is supplied.
 */
import { statutoryRate, depositCode, entityTypeFromPan, isOwnPan, interest201_1A, monthsOrPart, RATE_NOT_DEDUCTED } from "@/tds-core";
import {
  GATEWAY_LEGAL_NAME, deMinimisInr, gatewayPan, isSliceConfigured, isManualGateway, panIsOwn, selectSlices,
  type Gateway, type GatewaySlice, type SliceFilter,
} from "./gateways";
import { fetchCommissionRaw, type Basis, type CommissionRaw, type ManualLine } from "./settlements";
import { round2 } from "./util";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Settlement-fee side (gateway API) — the reconciliation cross-check, NOT the filed figure. */
export interface SettlementDerived {
  basis: Basis;
  grossVolume: number;
  commission: number;        // transaction-level fee total (GST-exclusive)
  gstOnCommission: number;
  grossFee: number;
  txnCount: number;
  byMethod?: Record<string, { count: number; fee: number }>;
  zeroFeeCount?: number;
  source: string;
}

/** Invoice side — the AUTHORITATIVE filed 194H base. */
export interface InvoiceSide {
  basis: "invoice" | "manual";
  ref?: string;
  date?: string;
  taxable: number;           // 194H taxable (GST-exclusive)
  gstOnCommission?: number;
}

export interface Reconciliation {
  invoiceTaxable: number;
  settlementCommission: number;
  drift: number;             // settlement − invoice
  driftPct: number | null;
}

export interface CommissionLine {
  app: string;
  gateway: Gateway;
  gatewayName: string;
  gatewayPan: string | null;
  configured: boolean;                 // gateway API auto-fetch available
  taxableBasis: "invoice" | "manual" | "settlement-derived" | null;
  taxable194H: number | null;          // the base 194H is computed on (invoice if present, else estimate)
  rateApplied: number | null;          // 0.02
  tds194H: number | null;
  code: string | null;                 // "1006"
  majorHead: "0020" | null;
  invoice: InvoiceSide | null;
  settlementDerived: SettlementDerived | null;
  reconciliation: Reconciliation | null;
  flags: string[];
  source: string;
  note?: string;
}

/** A prior-period 194H shortfall carried into this month's deposit, with 201(1A) interest. */
export interface CarryForward {
  fromPeriod: string;        // "2026-04"
  section?: "194H";
  shortfall: number;         // TDS under-deposited earlier
  depositedOn?: string;      // YYYY-MM-DD (to derive months, "or part thereof")
  monthsLate?: number;       // explicit override (e.g. 2) — wins over depositedOn
  ratePerMonth?: number;     // default 1%/month (failure-to-deduct); 1.5% for deducted-not-deposited
  note?: string;
}
export interface CarryForwardComputed {
  fromPeriod: string; section: string; shortfall: number; months: number;
  ratePerMonth: number; interest: number; total: number; note?: string;
}

export interface FiledLine { app: string; gateway: Gateway; fee: number; tds: number }
export interface FiledReference { total: number; note: string; lines: FiledLine[] }

export interface CommissionResult {
  period: string;
  section: "194H";
  basisNote: string;
  deMinimisInr: number;
  lines: CommissionLine[];
  summary: {
    linesWithFigure: number;
    settlementLines: number;
    invoiceLines: number;
    pendingLines: number;
    grossVolume: number;
    settlementCommission: number; // Σ settlement-fee (reconciliation view)
    taxable194H: number;          // Σ authoritative taxable
    tds194H: number;              // Σ authoritative 2%
  };
  byApp: Record<string, { taxable194H: number; tds194H: number }>;
  carryForward?: { entries: CarryForwardComputed[]; totalShortfall: number; totalInterest: number; totalCarryForward: number };
  deposit?: { currentMonth194H: number; carryForwardShortfall: number; carryForwardInterest: number; totalToDeposit: number };
  filedReference: FiledReference | null;
  regression: {
    anchorTotal: number | null;
    computedTds: number;
    drift: number | null;
    ok: boolean | null;
    perLine: { app: string; gateway: Gateway; filedTds: number; computedTds: number | null; basis: string | null; drift: number | null; matches: boolean | null }[];
  };
  flagsSummary: Record<string, number>;
}

/** Filed May-2026 194H — reconciliation reference (invoice basis). */
const FILED_REFERENCE: Record<string, FiledReference> = {
  "2026-05": {
    total: 26865.70,
    lines: [
      // Hima/Cashfree VALIDATED against tax invoice CF/26-27/35025 (entity 970202). The taxable
      // ₹720,120.15 is the invoice sub-total across THREE fee streams — NOT just PG MDR:
      //   • Payment Gateway Charges ₹444,433.15 (166,517 txns, ₹4.19Cr) — MDR+Platform+Risk; the live
      //     payment-date recon reproduces this to the rupee (₹444,438). "Zero MDR on UPI" per invoice,
      //     so the ~1% on UPI is Platform+Risk, correctly in payment_service_charge.
      //   • Payouts Disbursed  ₹275,499.00 (84,109 payouts, ₹2.61Cr) — Cashfree PAYOUTS product
      //     (account 89647), a SEPARATE payout API, NOT the PG settlement/recon API.
      //   • UPI Autopay Mandate ₹188.00 (Subscription).
      { app: "Hima", gateway: "cashfree", fee: 720120.15, tds: 14402.40 },
      { app: "Only Care", gateway: "cashfree", fee: 12695.67, tds: 253.91 },
      { app: "Thedal", gateway: "razorpay", fee: 1084.42, tds: 21.69 },
    ],
    note:
      "Filed May-2026 194H total across all gateway lines, 'considering as per invoice' (2% of each " +
      "gateway's monthly commission invoice, GST-exclusive). Supply the GSTR-2B invoice figures via " +
      "invoiceLines to reconcile line-by-line; the live settlement-fee total alone is a different basis " +
      "and will NOT match, and PhonePe (Hima's primary gateway + Bangalore Connect) needs its manual " +
      "figure. Validated in-repo: Hima/Cashfree ₹14,402.40 (invoice CF/26-27/35025 — PG ₹444,433.15 + " +
      "Payouts ₹275,499.00 + mandate ₹188.00), Only Care ₹253.91, Thedal ₹21.69. NOTE: the live " +
      "payment-date figure only reconstructs the PG line — the Payouts-disbursal fee is a separate " +
      "Cashfree product (payout API, IP-whitelisted) and mandate fees are Subscription, so the full " +
      "invoice still needs invoiceLines until those sources are wired.",
  },
};

/** Locked rupee anchors (empty — populate once invoice figures reconcile + are confirmed with Shoyab). */
const LOCKED_ANCHORS: Record<string, number> = {};

const RATE_194H = statutoryRate("194H", "COMPANY"); // 0.02 — from the tds-core rate master (not guessed)
const CODE_194H = depositCode("194H", "COMPANY");   // "1006"

/** Attach the gateway-PAN data-quality flags (the filed Razorpay-own-PAN autofill bug is exactly this). */
function panFlags(pan: string | null, gatewayName: string): string[] {
  const flags: string[] = [];
  if (!pan) {
    flags.push(`Gateway PAN not on file — TDS at the statutory 2% (company, head 0020). Confirm ${gatewayName}'s PAN with Shoyab before filing; the filed sheet carried Innovfix's OWN PAN on the Razorpay line by autofill.`);
    return flags;
  }
  const info = entityTypeFromPan(pan);
  if (!info.valid) flags.push(`Gateway PAN "${pan}" is malformed — verify.`);
  else if (info.deducteeClass !== "COMPANY") flags.push(`Gateway PAN "${pan}" is not a company PAN (4th char ≠ C) — verify.`);
  if (panIsOwn(pan) || isOwnPan(pan)) flags.push("Gateway PAN equals Innovfix's OWN PAN — the filed-sheet autofill error. Never file the company's own PAN as the deductee.");
  return flags;
}

/** Build one 194H line from the settlement-fee side and/or the invoice side. */
function buildLine(slice: GatewaySlice, settlementRaw: CommissionRaw | null, inv: ManualLine | null, deMinimis: number, fetchError: string | null): CommissionLine {
  const gatewayName = GATEWAY_LEGAL_NAME[slice.gateway];
  const pan = gatewayPan(slice.gateway);
  const flags: string[] = [];
  if (fetchError) flags.push(`Live ${slice.gateway} API error for ${slice.app}: ${fetchError}`);

  const settlementDerived: SettlementDerived | null = settlementRaw
    ? {
        basis: settlementRaw.basis,
        grossVolume: round2(settlementRaw.grossVolume),
        commission: round2(settlementRaw.commission),
        gstOnCommission: round2(settlementRaw.gstOnCommission),
        grossFee: round2(settlementRaw.grossFee),
        txnCount: settlementRaw.txnCount,
        byMethod: settlementRaw.byMethod,
        zeroFeeCount: settlementRaw.zeroFeeCount,
        source: settlementRaw.source,
      }
    : null;

  const invoice: InvoiceSide | null = inv && inv.taxable != null
    ? {
        basis: inv.invoiceRef ? "invoice" : "manual",
        ref: inv.invoiceRef,
        date: inv.invoiceDate,
        taxable: round2(inv.taxable),
        gstOnCommission: inv.gstOnCommission != null ? round2(inv.gstOnCommission) : undefined,
      }
    : null;

  const base = {
    app: slice.app, gateway: slice.gateway, gatewayName, gatewayPan: pan,
    configured: settlementDerived != null,
  };

  // Nothing on either side → pending (or awaiting-manual) placeholder.
  if (!settlementDerived && !invoice) {
    const manual = isManualGateway(slice.gateway);
    // A live fetch that ERRORED is NOT the same as an unconfigured gateway — don't mislabel it.
    if (fetchError) {
      return { ...base, taxableBasis: null, taxable194H: null, rateApplied: null, tds194H: null, code: null, majorHead: null, invoice: null, settlementDerived, reconciliation: null, flags, source: `${slice.gateway} (${slice.app})`, note: `live ${slice.gateway} API error — ${fetchError}` };
    }
    flags.push(manual
      ? `${slice.gateway} has no settlement-report API — supply the monthly commission from its report via invoiceLines {app:"${slice.app}", gateway:"${slice.gateway}", taxable, invoiceRef?}. 194H = 2% of it.`
      : `${slice.gateway} keys not configured for ${slice.app} — line pending (slots in when keys arrive).`);
    return { ...base, taxableBasis: null, taxable194H: null, rateApplied: null, tds194H: null, code: null, majorHead: null, invoice: null, settlementDerived, reconciliation: null, flags, source: `${slice.gateway} (${slice.app})`, note: manual ? "manual — awaiting invoice/report figure" : "not configured" };
  }

  const taxableBasis: "invoice" | "manual" | "settlement-derived" = invoice ? invoice.basis : "settlement-derived";
  const taxable194H = invoice ? invoice.taxable : settlementDerived!.commission;
  const tds194H = round2(taxable194H * RATE_194H);

  let reconciliation: Reconciliation | null = null;
  if (invoice && settlementDerived) {
    const drift = round2(settlementDerived.commission - invoice.taxable);
    const driftPct = invoice.taxable !== 0 ? round2((drift / invoice.taxable) * 100) : null;
    reconciliation = { invoiceTaxable: invoice.taxable, settlementCommission: settlementDerived.commission, drift, driftPct };
    if (driftPct != null && Math.abs(driftPct) > 5) {
      flags.push(`Settlement-fee ₹${settlementDerived.commission} differs from invoice ₹${invoice.taxable} by ${driftPct}% — verify the gateway's billing period cut-off / adjustments before filing.`);
    }
  }

  flags.push(...panFlags(pan, gatewayName));

  if (taxableBasis === "settlement-derived") {
    flags.push("No commission INVOICE supplied — 194H here is an ESTIMATE from settlement-fee data, a different basis. The filed 194H is 2% of the gateway's monthly invoice ('as per invoice'); supply it via invoiceLines (from GSTR-2B / the invoice) to make this authoritative.");
  } else if (taxableBasis === "invoice") {
    flags.push(`194H is 'as per invoice'${invoice!.ref ? ` (${invoice!.ref})` : ""} — the filed basis.`);
  } else {
    flags.push("194H from a manually-supplied figure (no invoice ref) — verify against the source report.");
  }

  if (taxable194H === 0) flags.push("Commission ₹0 → 194H nil (e.g. zero-MDR UPI, or no fee) — correct, not an error.");
  else if (taxable194H < deMinimis) flags.push(`Commission ₹${round2(taxable194H)} is below the de-minimis cutoff ₹${deMinimis} (UNCONFIRMED with Shoyab) — the filed sheet ignored tiny fees ("Nobroker – ignore less amount"). Flagged, not dropped.`);
  if (settlementDerived?.zeroFeeCount) flags.push(`${settlementDerived.zeroFeeCount} captured payment(s) carried ₹0 gateway fee (zero-MDR UPI) — included as nil.`);
  if (inv?.note) flags.push(`Note: ${inv.note}`);

  const source = invoice
    ? `${invoice.basis === "invoice" ? "invoice" : "manual"}${settlementDerived ? ` (reconciled vs ${settlementDerived.source})` : ""}`
    : settlementDerived!.source;

  return {
    ...base, taxableBasis, taxable194H, rateApplied: RATE_194H, tds194H, code: CODE_194H, majorHead: "0020",
    invoice, settlementDerived, reconciliation, flags, source,
  };
}

/** Compute prior-period carry-forward + 201(1A) interest for the deposit. */
function computeCarryForward(entries: CarryForward[]): NonNullable<CommissionResult["carryForward"]> {
  const out: CarryForwardComputed[] = entries.map((e) => {
    const ratePerMonth = e.ratePerMonth ?? RATE_NOT_DEDUCTED; // 1%/month default (failure to deduct)
    let months = e.monthsLate ?? 0;
    if (!months && e.depositedOn) {
      const [y, m] = e.fromPeriod.split("-").map(Number);
      months = monthsOrPart(new Date(Date.UTC(y, m - 1, 1)), new Date(e.depositedOn));
    }
    const interest = round2(interest201_1A(e.shortfall, months, ratePerMonth));
    return { fromPeriod: e.fromPeriod, section: e.section ?? "194H", shortfall: round2(e.shortfall), months, ratePerMonth, interest, total: round2(e.shortfall + interest), note: e.note };
  });
  const totalShortfall = round2(out.reduce((a, e) => a + e.shortfall, 0));
  const totalInterest = round2(out.reduce((a, e) => a + e.interest, 0));
  return { entries: out, totalShortfall, totalInterest, totalCarryForward: round2(totalShortfall + totalInterest) };
}

export interface ComputeOptions {
  invoiceLines?: ManualLine[];
  carryForward?: CarryForward[];
  /** Fetch the live settlement-fee figures to reconcile against the invoice (default true). Set false
   *  for a fast invoice-only roll-up that skips the gateway APIs entirely. */
  reconcile?: boolean;
}

/**
 * Compute the 194H commission section for a month, optionally sliced to one app/gateway. Invoice
 * figures (invoiceLines) are authoritative; the live settlement-fee figures reconcile against them.
 * Per-line error isolation: a failing gateway becomes a flagged line, never a failed request.
 */
export async function computeCommission(period: string, filter?: SliceFilter, opts?: ComputeOptions): Promise<CommissionResult> {
  const slices = selectSlices(filter);
  const deMinimis = deMinimisInr();
  const invoiceLines = opts?.invoiceLines ?? [];
  const doReconcile = opts?.reconcile !== false;

  const settled = await Promise.allSettled(
    slices.map(async (s) => (doReconcile && isSliceConfigured(s) ? await fetchCommissionRaw(s, period) : null)),
  );

  const usedInvoice = new Set<number>();
  const findInvoice = (app: string, gateway: Gateway): ManualLine | null => {
    const idx = invoiceLines.findIndex((m, i) => !usedInvoice.has(i) && norm(m.app) === norm(app) && (m.gateway ?? "phonepe") === gateway);
    if (idx < 0) return null;
    usedInvoice.add(idx);
    return invoiceLines[idx];
  };

  const lines: CommissionLine[] = slices.map((slice, i) => {
    const r = settled[i];
    const settlementRaw = r.status === "fulfilled" ? r.value : null;
    const fetchError = r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null;
    const inv = findInvoice(slice.app, slice.gateway);
    return buildLine(slice, settlementRaw, inv, deMinimis, fetchError);
  });

  // Invoice lines that matched no configured slice (e.g. a new app/gateway) → append as invoice-only lines.
  invoiceLines.forEach((m, i) => {
    if (usedInvoice.has(i)) return;
    const gateway = (m.gateway ?? "phonepe") as Gateway;
    if (filter?.gateway && filter.gateway !== gateway) return;
    if (filter?.app && norm(filter.app) !== norm(m.app)) return;
    lines.push(buildLine({ app: m.app, gateway }, null, m, deMinimis, null));
  });

  const withFigure = lines.filter((l) => l.taxable194H != null);
  const taxable194H = round2(withFigure.reduce((a, l) => a + (l.taxable194H ?? 0), 0));
  const tds194H = round2(withFigure.reduce((a, l) => a + (l.tds194H ?? 0), 0));
  const settlementCommission = round2(lines.reduce((a, l) => a + (l.settlementDerived?.commission ?? 0), 0));
  const grossVolume = round2(lines.reduce((a, l) => a + (l.settlementDerived?.grossVolume ?? 0), 0));

  const byApp: Record<string, { taxable194H: number; tds194H: number }> = {};
  for (const l of withFigure) {
    const a = byApp[l.app] ?? { taxable194H: 0, tds194H: 0 };
    a.taxable194H = round2(a.taxable194H + (l.taxable194H ?? 0));
    a.tds194H = round2(a.tds194H + (l.tds194H ?? 0));
    byApp[l.app] = a;
  }

  const flagsSummary: Record<string, number> = {};
  for (const l of lines) for (const f of l.flags) flagsSummary[f] = (flagsSummary[f] ?? 0) + 1;

  // Carry-forward + deposit.
  const carryForward = opts?.carryForward?.length ? computeCarryForward(opts.carryForward) : undefined;
  const deposit = {
    currentMonth194H: tds194H,
    carryForwardShortfall: carryForward?.totalShortfall ?? 0,
    carryForwardInterest: carryForward?.totalInterest ?? 0,
    totalToDeposit: round2(tds194H + (carryForward?.totalCarryForward ?? 0)),
  };

  // Reconciliation vs the filed reference (only for the WHOLE section, not a filtered slice).
  const filed = !filter ? (FILED_REFERENCE[period] ?? null) : null;
  const lockedAnchor = !filter ? (LOCKED_ANCHORS[period] ?? null) : null;
  const perLine = (filed?.lines ?? []).map((fl) => {
    const computed = lines.find((l) => l.app === fl.app && l.gateway === fl.gateway);
    const computedTds = computed?.tds194H ?? null;
    const drift = computedTds == null ? null : round2(computedTds - fl.tds);
    return { app: fl.app, gateway: fl.gateway, filedTds: fl.tds, computedTds, basis: computed?.taxableBasis ?? null, drift, matches: computedTds == null ? null : Math.abs(drift as number) <= 0.5 };
  });
  const regression = {
    anchorTotal: filed?.total ?? null,
    computedTds: tds194H,
    drift: lockedAnchor == null ? null : round2(tds194H - lockedAnchor),
    ok: lockedAnchor == null ? null : Math.abs(tds194H - lockedAnchor) <= 0.01,
    perLine,
  };

  return {
    period,
    section: "194H",
    basisNote:
      "194H is 'as per invoice': taxable = the gateway's monthly commission invoice value (GST-EXCLUSIVE); " +
      "TDS = 2% (tds-core, code 1006, head 0020). Supply invoiceLines (from GSTR-2B / the invoice) — those " +
      "are authoritative. The live settlement-fee figures (settlementDerived) are a RECONCILIATION cross-check " +
      "only (Cashfree = per-transaction payment_service_charge, payment-date basis; Razorpay = payment-level fee), " +
      "on a different basis.",
    deMinimisInr: deMinimis,
    lines,
    summary: {
      linesWithFigure: withFigure.length,
      settlementLines: lines.filter((l) => l.settlementDerived != null).length,
      invoiceLines: lines.filter((l) => l.invoice != null).length,
      pendingLines: lines.filter((l) => l.taxable194H == null).length,
      grossVolume, settlementCommission, taxable194H, tds194H,
    },
    byApp,
    carryForward,
    deposit,
    filedReference: filed,
    regression,
    flagsSummary,
  };
}
