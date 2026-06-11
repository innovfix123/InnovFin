const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30

export interface MonthRange {
  fromMs: number;
  toMs: number;
  fromSec: number;
  toSec: number;
}

/**
 * IST month boundaries for a "YYYY-MM" period, expressed as UTC timestamps.
 * Transactions are recorded in IST, so the month runs from IST 00:00 on the 1st
 * to IST 23:59:59.999 on the last day (matching the validated workings).
 */
export function monthRange(period: string): MonthRange {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const fromMs = Date.UTC(y, m - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
  const toMs = Date.UTC(y, m, 1, 0, 0, 0) - IST_OFFSET_MS - 1;
  return { fromMs, toMs, fromSec: Math.floor(fromMs / 1000), toSec: Math.floor(toMs / 1000) };
}
