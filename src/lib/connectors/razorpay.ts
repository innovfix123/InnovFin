import type { AOA } from "@/gst-core/gstr1";
import { monthRange } from "./period";
import type { Connector, FetchResult } from "./types";

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}

export interface RzpPayment {
  id: string;
  amount: number; // paise
  status: string; // created | authorized | captured | refunded | failed
  created_at: number;
  method?: string;
}

/**
 * Map Razorpay payment objects → the AOA the razorpay parser expects.
 * Keep only CAPTURED payments (the consideration); amounts paise → ₹.
 * type="payment" so the parser includes them (settlement/fee rows never appear from /payments).
 */
export function mapRazorpayPayments(items: RzpPayment[]): AOA {
  const rows: AOA = [["entity_id", "type", "amount", "status", "created_at"]];
  for (const p of items) {
    if (p.status !== "captured") continue;
    rows.push([p.id, "payment", p.amount / 100, p.status, p.created_at]);
  }
  return rows;
}

const PAGE = 100;

export function razorpayConnector(app: string, creds?: RazorpayCreds): Connector {
  return {
    id: `razorpay:${app.toLowerCase().replace(/\s+/g, "-")}`,
    app,
    provider: "razorpay",
    parserType: "razorpay",
    mode: "auto",
    isConfigured: () => Boolean(creds?.keyId && creds?.keySecret),
    async fetch(period: string): Promise<FetchResult> {
      if (!creds?.keyId || !creds?.keySecret) throw new Error(`Razorpay not configured for ${app}`);
      const { fromSec, toSec } = monthRange(period);
      const auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
      const all: RzpPayment[] = [];
      for (let skip = 0; ; skip += PAGE) {
        const url = `https://api.razorpay.com/v1/payments?from=${fromSec}&to=${toSec}&count=${PAGE}&skip=${skip}`;
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) throw new Error(`Razorpay API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as { items?: RzpPayment[] };
        const items = data.items ?? [];
        all.push(...items);
        if (items.length < PAGE) break;
      }
      const aoa = mapRazorpayPayments(all);
      return { aoa, count: aoa.length - 1, source: `Razorpay (${app})` };
    },
  };
}

// ---- Gateway Settlements: Razorpay commission (194H) + bank reconciliation, per app ----
// Separate Razorpay account per app → commission is sliced by which app's keys we query.
// Read-only (GET only); creds via RAZORPAY_<APP>_KEY_ID/SECRET in .env (never in code/committed).

/** One Razorpay settlement batch: a single UTR that lands as one bank credit. Amounts in ₹. */
export interface RzpSettlement {
  id: string; // "setl_..."
  utr: string; // bank UTR — the bank-reconciliation match key
  amount: number; // net amount settled to the bank (₹)
  fees: number; // Razorpay commission charged for the batch (₹) — the 194H taxable base
  tax: number; // GST charged on that commission (₹)
  status: string; // created | processed | failed  (only "processed" reaches the bank)
  createdAt: number; // unix seconds
}

export interface RazorpaySettlements {
  app: string;
  period: string; // "YYYY-MM"
  settlements: RzpSettlement[];
  commission: number; // Σ fees → 194H commission taxable (2%, deposit code 1006)
  gstOnCommission: number; // Σ tax
  netSettled: number; // Σ amount (reconciles to the month's bank credits for this app)
  source: string;
}

const SETTLE_PAGE = 100;
const paiseToRupees = (n: number) => (n ?? 0) / 100;

/**
 * Razorpay gateway settlements for a month. Reads /v1/settlements (batch level): each settlement
 * carries the bank UTR, net amount, total fee (commission) and tax (GST-on-fee). Σ fees + Σ tax
 * over the month is the 194H commission taxable + its GST; the per-settlement {utr, amount} rows
 * reconcile against the bank statement. Same Basic-auth + per-app-creds pattern as the payments
 * fetch above. The dashboard "Monthly Tax Invoice" total should tie out to commission + gstOnCommission.
 */
export async function fetchRazorpaySettlements(
  app: string,
  creds: RazorpayCreds | undefined,
  period: string,
): Promise<RazorpaySettlements> {
  if (!creds?.keyId || !creds?.keySecret) throw new Error(`Razorpay not configured for ${app}`);
  const { fromSec, toSec } = monthRange(period);
  const auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");

  interface RawSettlement {
    id: string;
    amount: number;
    fees: number;
    tax: number;
    utr: string;
    status: string;
    created_at: number;
  }
  const raw: RawSettlement[] = [];
  for (let skip = 0; ; skip += SETTLE_PAGE) {
    const url = `https://api.razorpay.com/v1/settlements?from=${fromSec}&to=${toSec}&count=${SETTLE_PAGE}&skip=${skip}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Razorpay settlements ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { items?: RawSettlement[] };
    const items = data.items ?? [];
    raw.push(...items);
    if (items.length < SETTLE_PAGE) break;
  }

  const settlements: RzpSettlement[] = raw.map((s) => ({
    id: s.id,
    utr: s.utr,
    amount: paiseToRupees(s.amount),
    fees: paiseToRupees(s.fees),
    tax: paiseToRupees(s.tax),
    status: s.status,
    createdAt: s.created_at,
  }));
  const commission = settlements.reduce((a, s) => a + s.fees, 0);
  const gstOnCommission = settlements.reduce((a, s) => a + s.tax, 0);
  const netSettled = settlements.reduce((a, s) => a + s.amount, 0);
  return { app, period, settlements, commission, gstOnCommission, netSettled, source: `Razorpay settlements (${app})` };
}

// ---- Razorpay commission (194H) — payment-level ----
// IMPORTANT: for our Razorpay accounts the SETTLEMENT object carries fees=tax=0 (verified live, May-2026:
// Thedal/Sudar/Unman all settle gross, fees=0). Razorpay debits its charge on each PAYMENT instead:
//   payment.fee = total charged INCLUDING GST,  payment.tax = the GST portion within that fee.
// So the 194H commission (GST-exclusive taxable) = Σ(fee − tax) over captured payments in the month,
// and the GST-on-commission = Σ tax. This is a PAYMENT-DATE basis (the only place the fee is exposed);
// the settlement/net figures for bank reconciliation still come from fetchRazorpaySettlements above.

export interface RazorpayCommission {
  app: string;
  period: string;
  basis: "payment-date";
  capturedCount: number;
  grossVolume: number;   // Σ payment.amount (₹)
  grossFee: number;      // Σ payment.fee (GST-INCLUSIVE) — what Razorpay actually debited
  gst: number;           // Σ payment.tax — GST portion within the fee
  commission: number;    // grossFee − gst → 194H taxable (GST-EXCLUSIVE)
  byMethod: Record<string, { count: number; fee: number }>; // fee (incl GST) by method (upi/card/…)
  zeroFeeCount: number;  // captured payments Razorpay charged ₹0 fee on (e.g. zero-MDR UPI)
  source: string;
}

interface RzpPaymentFee extends RzpPayment {
  fee?: number; // paise, incl GST
  tax?: number; // paise, GST portion
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Razorpay commission for a month from captured payments (fee is at payment level; see note above). */
export async function fetchRazorpayCommission(
  app: string,
  creds: RazorpayCreds | undefined,
  period: string,
): Promise<RazorpayCommission> {
  if (!creds?.keyId || !creds?.keySecret) throw new Error(`Razorpay not configured for ${app}`);
  const { fromSec, toSec } = monthRange(period);
  const auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");

  // Payment pagination is skip-based (order-stable), so pages can be fetched CONCURRENTLY in batches
  // rather than one-at-a-time — a month with thousands of payments (e.g. Sudar 5k+) must finish well
  // inside the MCP client's request timeout. Fetch BATCH pages at once; stop when a short/empty page
  // appears (end reached → later skips are empty).
  const BATCH = 8;
  const fetchPage = async (skip: number): Promise<RzpPaymentFee[]> => {
    const url = `https://api.razorpay.com/v1/payments?from=${fromSec}&to=${toSec}&count=${PAGE}&skip=${skip}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Razorpay payments ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { items?: RzpPaymentFee[] }).items ?? [];
  };
  const captured: RzpPaymentFee[] = [];
  for (let skip = 0, done = false; !done; skip += BATCH * PAGE) {
    const pages = await Promise.all(Array.from({ length: BATCH }, (_, j) => fetchPage(skip + j * PAGE)));
    for (const items of pages) {
      for (const p of items) if (p.status === "captured") captured.push(p);
      if (items.length < PAGE) done = true;
    }
  }

  const rupees = (n?: number) => (n ?? 0) / 100;
  let grossVolume = 0, grossFee = 0, gst = 0, zeroFeeCount = 0;
  const byMethod: Record<string, { count: number; fee: number }> = {};
  for (const p of captured) {
    grossVolume += rupees(p.amount);
    const fee = rupees(p.fee);
    grossFee += fee;
    gst += rupees(p.tax);
    if ((p.fee ?? 0) === 0) zeroFeeCount++;
    const mk = p.method ?? "unknown";
    const b = byMethod[mk] ?? { count: 0, fee: 0 };
    b.count += 1; b.fee += fee;
    byMethod[mk] = b;
  }
  for (const k of Object.keys(byMethod)) byMethod[k].fee = round2(byMethod[k].fee);

  return {
    app, period, basis: "payment-date",
    capturedCount: captured.length,
    grossVolume: round2(grossVolume),
    grossFee: round2(grossFee),
    gst: round2(gst),
    commission: round2(grossFee - gst),
    byMethod, zeroFeeCount,
    source: `Razorpay payments (${app})`,
  };
}
