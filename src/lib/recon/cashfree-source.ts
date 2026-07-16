import { fetchWindow, type CashfreeCreds, type ReconRow } from "@/lib/connectors/cashfree";
import { istFromOffsetIso, isInMonthIST, type Txn } from "./types";

/**
 * Cashfree → normalised transactions for a month, on a PAYMENT-date basis.
 *
 * The one thing this does that the app DB cannot: it reads EVERY payment_group.
 *
 * The production app-DB query joins `coins` on `coin_id`, so an autopay/mandate payment — which
 * has no coin pack — is silently deleted by the join. Those are real, settled revenue, and in the
 * reference month they were thousands of transactions (`SBC_*` payment groups) that never reached
 * GSTR-1. Not filtering on payment_group is the entire point of this source.
 *
 * Read-only: this issues the same GET-shaped recon POST the live commission code already uses.
 */

/**
 * Cashfree's recon API filters by SETTLEMENT date, so we sweep settlement-date windows and then
 * keep rows whose PAYMENT time (event_time) lands in the month. A month's payments settle within
 * ~7 days, hence the 9-day tail into the next month.
 *
 * Windows are DAILY, not one-per-month. Recon is cursor-paginated, so pages within a window are
 * strictly sequential — a single month-wide window for a high-volume app means ~180 round trips
 * back to back. The live 194H commission code (fetchCashfreePaymentCommission) hit exactly this
 * wall on Hima and moved to daily windows with bounded concurrency; this mirrors that, so the
 * windows parallelise even though their pages cannot.
 */
function windowsFor(period: string): [string, string][] {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = (yy: number, mm: number, dd: number, hh: number, mi: number, ss: number) =>
    `${yy}-${p(mm)}-${p(dd)}T${p(hh)}:${p(mi)}:${p(ss)}+05:30`;

  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;

  const days: [number, number, number][] = [];
  for (let d = 1; d <= lastDay; d++) days.push([y, m, d]);
  for (let d = 1; d <= 9; d++) days.push([ny, nm, d]); // the T+1/T+2 settlement tail
  return days.map(([yy, mm, dd]) => [iso(yy, mm, dd, 0, 0, 0), iso(yy, mm, dd, 23, 59, 59)]);
}

/**
 * Cashfree rate-limits the recon API aggressively, and a full Hima month is ~39 windows each
 * cursor-paginated over thousands of rows — a lot of requests. Keep concurrency low.
 *
 * The production fetcher already backs off on a 429, but only 6 times with an 8s ceiling (~24s
 * total), which is not enough under a SUSTAINED limit: pulling the month three times in an hour
 * earned a hard `429 rate_limit_error`. So this layer adds a second, much longer backoff on top.
 * Read-only or not, we are a guest on a live payment gateway.
 */
const CONCURRENCY = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fetchWindow + a long outer backoff, so a sustained rate limit waits rather than fails the run. */
async function fetchWindowResilient(
  creds: CashfreeCreds,
  start: string,
  end: string,
  onRetry?: (attempt: number, waitMs: number) => void,
): Promise<ReconRow[]> {
  const WAITS = [15_000, 45_000, 90_000, 180_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchWindow(creds, start, end);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("429") || attempt >= WAITS.length) throw e;
      onRetry?.(attempt + 1, WAITS[attempt]);
      await sleep(WAITS[attempt]);
    }
  }
}

export interface CashfreeTxnResult {
  txns: Txn[];
  /** Payments whose event_time fell OUTSIDE the month — reported, never silently dropped. */
  outOfMonth: Txn[];
  /** Refund events seen in the swept windows, keyed by order id (₹). */
  refundsByOrder: Record<string, number>;
  raw: number;
}

export interface CashfreeFetchOpts {
  /** Called as each daily window lands, so a long pull is observable rather than opaque. */
  onWindow?: (done: number, total: number) => void;
  /** Called when a 429 forces a wait, so a rate-limited run does not look like a hang. */
  onRateLimit?: (attempt: number, waitMs: number) => void;
}

/** Every SUCCESS payment Cashfree processed for `app` in `period`, plus refunds seen alongside. */
export async function fetchCashfreeTxns(
  app: string,
  creds: CashfreeCreds | undefined,
  period: string,
  opts: CashfreeFetchOpts = {},
): Promise<CashfreeTxnResult> {
  if (!creds?.appId || !creds?.secretKey) throw new Error(`Cashfree not configured for ${app}`);

  const windows = windowsFor(period);
  const merged = new Map<string, ReconRow>();
  let done = 0;
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    const batch = windows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(([s, e]) => fetchWindowResilient(creds, s, e, opts.onRateLimit)),
    );
    for (const rows of results) for (const r of rows) merged.set(`${r.event_id}|${r.event_type}`, r);
    done += batch.length;
    opts.onWindow?.(done, windows.length);
  }
  const rows = [...merged.values()];

  // Refunds first, so a payment can carry its own refund total.
  const refundsByOrder: Record<string, number> = {};
  for (const r of rows) {
    if (r.event_type !== "REFUND" || r.event_status !== "SUCCESS") continue;
    const id = r.order_id ?? "";
    if (!id) continue;
    refundsByOrder[id] = (refundsByOrder[id] ?? 0) + (r.event_amount ?? 0);
  }

  const txns: Txn[] = [];
  const outOfMonth: Txn[] = [];
  for (const r of rows) {
    if (r.event_type !== "PAYMENT" || r.event_status !== "SUCCESS") continue;
    if (typeof r.event_time !== "string" || !r.event_time) continue;

    const orderId = r.order_id ?? "";
    const refunded = refundsByOrder[orderId] ?? 0;
    const t: Txn = {
      orderId,
      amount: r.event_amount ?? r.order_amount ?? 0,
      status: refunded > 0 ? "refunded" : "success",
      txnTimeIST: istFromOffsetIso(r.event_time),
      source: "cashfree",
      method: r.payment_group ?? null,
      refunded,
      reference: null, // recon exposes no bank reference at payment level
    };
    (isInMonthIST(t.txnTimeIST, period) ? txns : outOfMonth).push(t);
  }

  return { txns, outOfMonth, refundsByOrder, raw: rows.length };
}
