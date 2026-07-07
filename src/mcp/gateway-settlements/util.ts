/** Round to 2 dp (paise), float-safe. Money stays full-precision until display. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "2026-05" → "May 2026". */
export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m] ?? m} ${y}`;
}

/** Validate a YYYY-MM period string; throws on anything else. */
export function assertPeriod(period: string): void {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const m = Number(period.split("-")[1]);
  if (m < 1 || m > 12) throw new Error(`Invalid month in period "${period}"`);
}
