/**
 * Hima PAYOUT-disbursal charges connector (read-only) — the Cashfree fee for DISBURSING creator
 * payouts, i.e. the 194H commission base for the "Payouts Disbursed" invoice line (SEPARATE from the
 * payment-gateway MDR handled by the gateway-settlements MCP, and from the 194C on the payout amount).
 *
 * Source: `tds_creator_payouts_v.cf_service_charge` via the read-only tunnel (same as payouts.ts).
 * Hima has NO usable payout API (the Cashfree Payout key is IP-whitelisted + money-moving), so the
 * DB view is the source. `cf_service_charge` is populated ~Jul-2026 onward; for earlier months it is
 * null → feesPopulated is false and the caller should use the Cashfree payout invoice (e.g. the
 * "Payouts Disbursed" line of CF/26-27/…) for that month instead.
 *
 * Aggregate SELECT (COUNT/SUM) so a high-volume month (Hima ≈ 84k payouts) never streams row-by-row.
 */
import { getHimaConnection } from "./db";
import { monthBounds } from "./util";

export interface HimaPayoutCharges {
  period: string;
  paidCount: number; // payouts in the month
  feePopulatedCount: number; // rows carrying a non-null cf_service_charge
  cashfreeFees: number; // Σ cf_service_charge — the 194H payout-disbursal base
  grossPaid: number; // Σ actual_amount (gross payout volume)
  feesPopulated: boolean;
  source: string;
  note?: string;
}

const AGG_QUERY = `
SELECT
  COUNT(*)                                      AS n,
  COUNT(cf_service_charge)                       AS n_fee,
  ROUND(COALESCE(SUM(cf_service_charge), 0), 2)  AS sum_fee,
  ROUND(COALESCE(SUM(actual_amount), 0), 2)      AS sum_gross
FROM tds_creator_payouts_v
WHERE payment_date >= :from AND payment_date < :to`;

export async function fetchHimaPayoutCharges(period: string): Promise<HimaPayoutCharges> {
  const { from, to } = monthBounds(period);
  const conn = await getHimaConnection({ namedPlaceholders: true });
  try {
    const [rows] = await conn.query(AGG_QUERY, { from, to });
    const r = (rows as Record<string, unknown>[])[0] ?? {};
    const paidCount = Number(r.n ?? 0);
    const feePopulatedCount = Number(r.n_fee ?? 0);
    const cashfreeFees = Number(r.sum_fee ?? 0);
    const feesPopulated = feePopulatedCount > 0;
    return {
      period,
      paidCount,
      feePopulatedCount,
      cashfreeFees,
      grossPaid: Number(r.sum_gross ?? 0),
      feesPopulated,
      source: "Hima app DB (tds_creator_payouts_v.cf_service_charge)",
      note: !feesPopulated
        ? `cf_service_charge not yet populated for ${period} (the DB populates ~Jul-2026 onward) — use the Cashfree payout invoice's "Payouts Disbursed" line for this month's 194H disbursal base.`
        : feePopulatedCount < paidCount
          ? `Partial: only ${feePopulatedCount}/${paidCount} payouts carry cf_service_charge (backfill in progress) — the sum is understated; reconcile against the Cashfree payout invoice.`
          : undefined,
    };
  } finally {
    await conn.end();
  }
}
