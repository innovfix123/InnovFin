/**
 * Aggregator: pull each gateway's numbers and normalise into two shapes —
 *   CommissionRaw  → the 194H fee side (fed to compute.ts)
 *   ReconcileRaw   → the settlement/bank side (fed to the reconcile + list tools)
 *
 * Fee SOURCE differs by gateway (verified live, see the connectors):
 *   Cashfree — settlement-batch service_charge/service_tax (settlement-date basis; one call yields
 *              BOTH the commission and the bank-reconcilable net/UTR rows).
 *   Razorpay — payment-level fee/tax (payment-date basis), because the settlement object carries
 *              fees=0; the net/UTR for reconciliation still comes from the settlement object.
 * A gateway with no keys (PhonePe today) returns null — the caller renders a "pending" line.
 */
import type { Gateway, GatewaySlice, SliceFilter } from "./gateways";
import { cashfreeCredsFor, razorpayCredsFor, isSliceConfigured, isManualGateway, selectSlices } from "./gateways";
import { fetchCashfreeSettlements, fetchCashfreePaymentCommission } from "@/lib/connectors/cashfree";
import { fetchRazorpayCommission, fetchRazorpaySettlements } from "@/lib/connectors/razorpay";
import { round2 } from "./util";

export type Basis = "payment-date" | "settlement-date";

/** Live-path cap for a single heavy per-transaction fetch (offline callers pass no cap). */
const LIVE_FETCH_TIMEOUT_MS = 40_000;

/** Reject with `msg` if `p` doesn't settle within `ms` (the underlying fetch is left to finish/GC). */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

/** The 194H fee side of one app×gateway line for a month (pre-tax-math). */
export interface CommissionRaw {
  app: string;
  gateway: Gateway;
  basis: Basis;
  grossVolume: number;      // gross processed
  commission: number;       // 194H taxable (GST-EXCLUSIVE)
  gstOnCommission: number;  // GST charged on the fee
  grossFee: number;         // commission + GST (what the gateway actually debited)
  txnCount: number;         // captured payments (Razorpay) or settlement batches (Cashfree)
  byMethod?: Record<string, { count: number; fee: number }>;
  zeroFeeCount?: number;
  source: string;
}

/** One settlement batch, normalised for bank reconciliation. Amounts ₹. */
export interface SettlementRow {
  id: string;
  utr: string;          // bank-statement match key
  gross: number;        // gross processed in the batch
  commission: number;   // fee in the batch (Razorpay settlement rows carry 0 — fee is per-payment)
  gst: number;
  net: number;          // what reached the bank
  date: string;         // settlement/credit date (ISO IST)
  status: string;
}

/** The settlement/bank side of one app×gateway line for a month. */
export interface ReconcileRaw {
  app: string;
  gateway: Gateway;
  basis: "settlement-date";
  settlements: SettlementRow[];
  netSettled: number;
  count: number;
  source: string;
}

/** Fee side for a slice, or null if the gateway isn't configured. Throws only on a live API failure. */
export async function fetchCommissionRaw(slice: GatewaySlice, period: string): Promise<CommissionRaw | null> {
  if (slice.gateway === "cashfree") {
    const creds = cashfreeCredsFor(slice.app);
    if (!creds) return null;
    // Commission is the PAYMENT-date MDR (recon, per-transaction) — the basis the monthly invoice is
    // built on. The settlement-BATCH sum is timing-shifted; it stays the bank-reconciliation source
    // (fetchReconcileRaw) for UTR/net, not the 194H figure.
    // Per-transaction recon is heavy for high-volume apps (Hima ≈ 166k payments ≈ 2–3 min under
    // Cashfree's rate limit). Cap it in the LIVE path so the tool stays responsive; on timeout the
    // line is flagged (per-line isolation) — the authoritative figure comes from invoiceLines anyway,
    // and the full offline figure is available via check-anchor.ts. No cap when called directly.
    const s = await withTimeout(
      fetchCashfreePaymentCommission(slice.app, creds, period),
      LIVE_FETCH_TIMEOUT_MS,
      `Cashfree payment-date recon exceeded ${LIVE_FETCH_TIMEOUT_MS / 1000}s for ${slice.app} (high transaction volume). Supply the invoice figure via invoiceLines, or run the offline reconciliation (check-anchor.ts) for the full per-transaction MDR.`,
    );
    return {
      app: slice.app, gateway: "cashfree", basis: "payment-date",
      grossVolume: round2(s.grossVolume),
      commission: round2(s.commission),
      gstOnCommission: round2(s.gstOnCommission),
      grossFee: round2(s.commission + s.gstOnCommission),
      txnCount: s.txnCount,
      byMethod: s.byMethod,
      zeroFeeCount: s.zeroFeeCount,
      source: s.source,
    };
  }
  if (slice.gateway === "razorpay") {
    const creds = razorpayCredsFor(slice.app);
    if (!creds) return null;
    const c = await fetchRazorpayCommission(slice.app, creds, period);
    return {
      app: slice.app, gateway: "razorpay", basis: "payment-date",
      grossVolume: c.grossVolume,
      commission: c.commission,
      gstOnCommission: c.gst,
      grossFee: c.grossFee,
      txnCount: c.capturedCount,
      byMethod: c.byMethod,
      zeroFeeCount: c.zeroFeeCount,
      source: c.source,
    };
  }
  return null; // phonepe — no connector yet
}

/** Settlement/bank side for a slice, or null if not configured. Throws only on a live API failure. */
export async function fetchReconcileRaw(slice: GatewaySlice, period: string): Promise<ReconcileRaw | null> {
  if (slice.gateway === "cashfree") {
    const creds = cashfreeCredsFor(slice.app);
    if (!creds) return null;
    const s = await fetchCashfreeSettlements(slice.app, creds, period);
    const settlements: SettlementRow[] = s.settlements.map((b) => ({
      id: b.settlementId, utr: b.utr, gross: round2(b.grossVolume), commission: round2(b.commission),
      gst: round2(b.gstOnCommission), net: round2(b.net), date: b.settlementDate, status: b.status,
    }));
    return { app: slice.app, gateway: "cashfree", basis: "settlement-date", settlements, netSettled: round2(s.netSettled), count: settlements.length, source: s.source };
  }
  if (slice.gateway === "razorpay") {
    const creds = razorpayCredsFor(slice.app);
    if (!creds) return null;
    const s = await fetchRazorpaySettlements(slice.app, creds, period);
    const settlements: SettlementRow[] = s.settlements.map((b) => ({
      id: b.id, utr: b.utr, gross: round2(b.amount + b.fees + b.tax), commission: round2(b.fees),
      gst: round2(b.tax), net: round2(b.amount), date: new Date(b.createdAt * 1000).toISOString(), status: b.status,
    }));
    return { app: slice.app, gateway: "razorpay", basis: "settlement-date", settlements, netSettled: round2(s.netSettled), count: settlements.length, source: s.source };
  }
  return null; // phonepe
}

/**
 * An invoice-basis / manually-supplied line — the AUTHORITATIVE 194H figure. The filed 194H is "as
 * per invoice" (2% of the gateway's monthly commission INVOICE, GST-exclusive), NOT the settlement-fee
 * total. The gateway PG APIs don't expose that invoice, so it comes from GSTR-2B (invoice CF/26-27/…)
 * or the invoice/settlement report, supplied at the Claude layer:
 *   - `taxable` (+ optional `invoiceRef`/`invoiceDate`) → the 194H tools use it as authoritative and
 *     reconcile the settlement-fee figure against it.
 *   - `netSettled`/`settlements` → the reconcile tool (e.g. PhonePe, which has no API at all).
 * gateway defaults to "phonepe".
 */
export interface ManualLine {
  app: string;
  gateway?: Gateway;
  taxable?: number;           // 194H taxable (GST-EXCLUSIVE) from the invoice / manual report
  invoiceRef?: string;        // e.g. "CF/26-27/35025" (GSTR-2B invoice number)
  invoiceDate?: string;       // YYYY-MM-DD (optional)
  gstOnCommission?: number;   // GST on the fee — sits in separate IGST/CGST/SGST columns, NOT in 194H
  grossVolume?: number;
  netSettled?: number;        // for reconcile
  settlements?: { date: string; net: number; utr: string }[]; // optional per-batch rows for reconcile
  note?: string;
}

/** One reconcile line: the settlement/bank side for an app×gateway, or a pending/error placeholder. */
export interface ReconcileLine {
  app: string;
  gateway: Gateway;
  configured: boolean;
  basis: "settlement-date" | "manual" | null;
  settlements: SettlementRow[];
  netSettled: number | null;
  count: number | null;
  source: string;
  note?: string;
}

const normApp = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The settlement/bank side for every slice matching the filter, in parallel with per-line error
 * isolation. Shaped so the caller can cross-check netSettled + per-batch {date, net, utr} against the
 * Innovfix Bank Data MCP at the Claude Desktop layer (MCPs can't call each other directly).
 */
export async function fetchReconcileLines(period: string, filter?: SliceFilter, manualLines?: ManualLine[]): Promise<ReconcileLine[]> {
  const slices = selectSlices(filter);
  const settled = await Promise.allSettled(
    slices.map(async (s) => (isSliceConfigured(s) ? await fetchReconcileRaw(s, period) : null)),
  );
  const lines: ReconcileLine[] = slices.map((slice, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { app: slice.app, gateway: slice.gateway, configured: true, basis: null, settlements: [], netSettled: null, count: null, source: `${slice.gateway} (${slice.app})`, note: `Live ${slice.gateway} API error: ${msg}` };
    }
    if (!r.value) {
      const manual = isManualGateway(slice.gateway);
      const note = manual
        ? `${slice.gateway} has no settlement API — supply net figures via manualLines {app, gateway:"${slice.gateway}", netSettled, settlements?} to bank-reconcile.`
        : `${slice.gateway} keys not configured for ${slice.app} — line pending.`;
      return { app: slice.app, gateway: slice.gateway, configured: false, basis: null, settlements: [], netSettled: null, count: null, source: `${slice.gateway} (${slice.app})`, note };
    }
    return { ...r.value, configured: true };
  });

  // Merge manually-supplied net figures (PhonePe, or any gateway when its API is unavailable).
  for (const m of manualLines ?? []) {
    const gateway = m.gateway ?? "phonepe";
    if (filter?.gateway && filter.gateway !== gateway) continue;
    if (filter?.app && normApp(filter.app) !== normApp(m.app)) continue;
    if (m.netSettled == null && !(m.settlements && m.settlements.length)) continue; // nothing for reconcile
    const rows: SettlementRow[] = (m.settlements ?? []).map((s, i) => ({
      id: `manual-${i}`, utr: s.utr, gross: 0, commission: 0, gst: 0, net: round2(s.net), date: s.date, status: "manual",
    }));
    const netSettled = m.netSettled != null ? round2(m.netSettled) : round2(rows.reduce((a, r) => a + r.net, 0));
    const line: ReconcileLine = {
      app: m.app, gateway, configured: true, basis: "manual", settlements: rows, netSettled, count: rows.length,
      source: `manual (${gateway} settlement report)`, note: m.note ? `Manual: ${m.note}` : "Manual net figures — verify against the source report.",
    };
    const idx = lines.findIndex((l) => normApp(l.app) === normApp(m.app) && l.gateway === gateway);
    if (idx >= 0) lines[idx] = line; else lines.push(line);
  }
  return lines;
}
