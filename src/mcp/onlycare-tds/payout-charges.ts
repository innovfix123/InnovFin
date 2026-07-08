/**
 * Only Care PAYOUT-disbursal charges connector (read-only) — the Cashfree fee for DISBURSING creator
 * payouts, which is the 194H commission base for the "Payouts Disbursed" line (SEPARATE from the
 * payment-gateway MDR handled by the gateway-settlements MCP, and from the 194C on the payout amount).
 *
 * Source: the Only Care app's internal payouts API (ONLYCARE_INTERNAL_API_URL, Bearer token). The
 * app records `cashfree_fee` (194H base), `tds_deducted` (194C creator TDS already withheld),
 * `net_credited`, and `cashfree_transfer_id` (to cross-check the Cashfree tax invoice) per payout.
 * Fees are backfilled ~Jul-2026 onward; for earlier months the API returns them null → feesPopulated
 * is false and the caller should use the Cashfree payout invoice for that month instead.
 */
import { envVar } from "./env";
import { round2 } from "./util";

export interface OnlyCarePayoutDetailRow {
  id: string;
  cashfreeTransferId: string | null; // cross-check key vs the Cashfree invoice
  utr: string | null;
  status: string;
  paidAt: string | null;
  grossAmount: number;
  tdsDeducted: number | null; // 194C creator TDS
  cashfreeFee: number | null; // 194H payout-disbursal fee
  netCredited: number | null;
}

export interface OnlyCarePayoutCharges {
  period: string;
  from: string;
  to: string;
  paidCount: number;
  grossPaid: number;
  cashfreeFees: number; // Σ cashfree_fee — the 194H payout-disbursal base
  tdsDeducted: number; // Σ tds_deducted — 194C creator TDS the app already withheld
  netCredited: number;
  feesPopulated: boolean; // false when the app has not backfilled fees for the period (pre-~Jul-2026)
  source: string;
  note?: string;
  detail?: OnlyCarePayoutDetailRow[];
  detailTruncated?: boolean;
}

const num = (n: unknown): number => (typeof n === "number" && isFinite(n) ? n : 0);

function apiBase(): string {
  return (envVar("ONLYCARE_INTERNAL_API_URL") ?? "https://onlycare.in/api/internal/payouts").replace(/\/$/, "");
}

/** First → last calendar day of the month, inclusive (the internal API's `to` is inclusive). */
function monthDateRange(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const p = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(lastDay)}` };
}

interface PaidTotals { amount?: number; tds_deducted?: number; cashfree_fees?: number; net_credited?: number; count?: number }

export async function fetchOnlyCarePayoutCharges(period: string, opts?: { detail?: boolean }): Promise<OnlyCarePayoutCharges> {
  const token = envVar("ONLYCARE_INTERNAL_API_TOKEN");
  if (!token) throw new Error("ONLYCARE_INTERNAL_API_TOKEN is not set (see .env)");
  const { from, to } = monthDateRange(period);
  const wantDetail = opts?.detail === true;
  const url = `${apiBase()}?from=${from}&to=${to}${wantDetail ? "&detail=1" : ""}`;

  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Only Care internal payouts API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { range_totals?: { paid?: PaidTotals }; payouts?: Record<string, unknown>[]; payouts_truncated?: boolean };

  const paid = d.range_totals?.paid ?? {};
  const paidCount = num(paid.count);
  const cashfreeFees = round2(num(paid.cashfree_fees));
  // "populated" = there is a fee (or there were no payouts at all). Zero fee on real payouts = not backfilled.
  const feesPopulated = cashfreeFees > 0 || paidCount === 0;

  let detail: OnlyCarePayoutDetailRow[] | undefined;
  let detailTruncated: boolean | undefined;
  if (wantDetail && Array.isArray(d.payouts)) {
    detail = d.payouts.map((r) => ({
      id: String(r.id ?? ""),
      cashfreeTransferId: r.cashfree_transfer_id == null ? null : String(r.cashfree_transfer_id),
      utr: r.utr == null ? null : String(r.utr),
      status: String(r.status ?? ""),
      paidAt: r.paid_at == null ? null : String(r.paid_at),
      grossAmount: num(r.gross_amount),
      tdsDeducted: r.tds_deducted == null ? null : num(r.tds_deducted),
      cashfreeFee: r.cashfree_fee == null ? null : num(r.cashfree_fee),
      netCredited: r.net_credited == null ? null : num(r.net_credited),
    }));
    detailTruncated = d.payouts_truncated === true;
  }

  return {
    period, from, to,
    paidCount,
    grossPaid: round2(num(paid.amount)),
    cashfreeFees,
    tdsDeducted: round2(num(paid.tds_deducted)),
    netCredited: round2(num(paid.net_credited)),
    feesPopulated,
    source: "Only Care internal payouts API",
    note: feesPopulated
      ? undefined
      : `cashfree_fee not yet backfilled for ${period} (the app populates ~Jul-2026 onward) — use the Cashfree payout invoice for this month's 194H disbursal base.`,
    detail, detailTruncated,
  };
}
