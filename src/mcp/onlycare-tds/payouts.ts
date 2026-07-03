/**
 * Only Care creator-payout connector (read-only). Sources `onlycare_admin.bank_withdrawal_requests`
 * through the durable SSH tunnel (local 3308 → analyst@43.204.113.99:3306) using the `analytics_ro`
 * SELECT-only login. Query locked against the live schema + the filed May anchor (1,190 payouts).
 */
import { createConnection } from "mysql2/promise";
import { envVar } from "./env";
import { monthBounds } from "./util";

export interface PayoutRow {
  creatorId: string;
  creatorName: string | null;
  pan: string | null;
  panName: string | null;      // name on the bank/KYC record (NOT the PAN-verification name)
  payoutRef: string;           // payout_transfer_id — unique, the idempotency key
  paymentDate: string;         // 'YYYY-MM-DD' (IST)
  grossAmount: number;         // TDS base
  cashfreeFee: number | null;  // reference-only (NULL pre-Jun-2026)
  netCredited: number | null;  // reference-only
}

// payout_transfer_id is UNIQUE, so filtering by it (non-null) yields one row per real payout —
// no GROUP BY needed. Joins are 1:1 on primary keys, so no fan-out.
const QUERY = `
SELECT
  w.user_id                                  AS creatorId,
  u.name                                     AS creatorName,
  ba.pancard_number                          AS pan,
  ba.pancard_name                            AS panName,
  w.payout_transfer_id                       AS payoutRef,
  DATE_FORMAT(w.paid_at, '%Y-%m-%d')         AS paymentDate,
  w.amount                                   AS grossAmount,
  w.cashfree_processing_fees                 AS cashfreeFee,
  w.amount_credited                          AS netCredited
FROM bank_withdrawal_requests w
LEFT JOIN bank_accounts ba ON ba.id = w.bank_account_id
LEFT JOIN users u ON u.id = w.user_id
WHERE w.status = 'PAID' AND w.payout_status = 'SUCCESS'
  AND w.payout_transfer_id IS NOT NULL
  AND w.paid_at >= :from AND w.paid_at < :to
ORDER BY w.paid_at, w.payout_transfer_id`;

export async function fetchOnlyCarePayouts(period: string): Promise<PayoutRow[]> {
  const url = envVar("APPDB_ONLY_CARE_TDS_URL");
  if (!url) throw new Error("APPDB_ONLY_CARE_TDS_URL is not set (see .env)");
  const { from, to } = monthBounds(period);
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    namedPlaceholders: true,
  });
  try {
    const [rows] = await conn.query(QUERY, { from, to });
    return (rows as Record<string, unknown>[]).map((r) => ({
      creatorId: String(r.creatorId),
      creatorName: r.creatorName == null ? null : String(r.creatorName),
      pan: r.pan == null ? null : String(r.pan),
      panName: r.panName == null ? null : String(r.panName),
      payoutRef: String(r.payoutRef),
      paymentDate: String(r.paymentDate),
      grossAmount: Number(r.grossAmount),
      cashfreeFee: r.cashfreeFee == null ? null : Number(r.cashfreeFee),
      netCredited: r.netCredited == null ? null : Number(r.netCredited),
    }));
  } finally {
    await conn.end();
  }
}
