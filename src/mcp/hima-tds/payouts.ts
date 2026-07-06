/**
 * Hima creator-payout connector (read-only). Sources himaapp.tds_creator_payouts_v through the
 * durable SSH tunnel (hima-tunnel.service → local 3307) using the SELECT-only `tdsapp_ro` login.
 * The view is denormalized and pre-filtered to paid, so this is a flat SELECT — no joins, no
 * status filter. Query + column mapping locked against the live schema (verified 2026-07-04) and
 * the May-2026 figures (84,109 payouts / gross ₹2,66,68,647).
 *
 * NB — columns differ from Only Care's bank_withdrawal_requests, and one name COLLIDES:
 *   Only Care `amount` = GROSS, but Hima `amount` = NET. Hima's GROSS is `actual_amount`.
 *   → the TDS base is `actual_amount` (gross), never `amount`.
 */
import { getHimaConnection } from "./db";
import { monthBounds } from "./util";

export interface PayoutRow {
  creatorId: string;
  creatorName: string | null;  // app username (e.g. "Pavitra479")
  pan: string | null;
  panName: string | null;      // name-as-per-PAN carried on the payout row
  payoutRef: string;           // payout_id (bigint PK) — 100% unique, the dedup/idempotency key
  transferId: string | null;   // Cashfree transfer ref (unique when present; ~all non-null in May)
  paymentDate: string;         // 'YYYY-MM-DD' (IST-stored)
  grossAmount: number;         // actual_amount — the TDS base
  cashfreeFee: number | null;  // cf_service_charge — reference-only, NULL for May (like Only Care pre-Jun)
  netCredited: number | null;  // amount — net credited (populated)
}

// payout_id is the PK and 100% unique, so a flat SELECT yields exactly one row per payout —
// no GROUP BY and no joins (the view is already denormalized + paid-only).
const QUERY = `
SELECT
  creator_id                                 AS creatorId,
  creator_name                               AS creatorName,
  pan                                        AS pan,
  pan_name                                   AS panName,
  payout_id                                  AS payoutRef,
  transfer_id                                AS transferId,
  DATE_FORMAT(payment_date, '%Y-%m-%d')      AS paymentDate,
  actual_amount                              AS grossAmount,
  cf_service_charge                          AS cashfreeFee,
  amount                                     AS netCredited
FROM tds_creator_payouts_v
WHERE payment_date >= :from AND payment_date < :to
ORDER BY payment_date, payout_id`;

export async function fetchHimaPayouts(period: string): Promise<PayoutRow[]> {
  const { from, to } = monthBounds(period);
  const conn = await getHimaConnection({ namedPlaceholders: true });
  try {
    const [rows] = await conn.query(QUERY, { from, to });
    return (rows as Record<string, unknown>[]).map((r) => ({
      creatorId: String(r.creatorId),
      creatorName: r.creatorName == null ? null : String(r.creatorName),
      pan: r.pan == null ? null : String(r.pan),
      panName: r.panName == null ? null : String(r.panName),
      payoutRef: String(r.payoutRef),
      transferId: r.transferId == null ? null : String(r.transferId),
      paymentDate: String(r.paymentDate),
      grossAmount: Number(r.grossAmount),
      cashfreeFee: r.cashfreeFee == null ? null : Number(r.cashfreeFee),
      netCredited: r.netCredited == null ? null : Number(r.netCredited),
    }));
  } finally {
    await conn.end();
  }
}
