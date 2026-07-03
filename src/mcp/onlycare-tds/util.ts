/** Round to 2 dp (paise), float-safe. Money stays full-precision until display/challan. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "2026-05" → "May 2026" (workbook Month column). */
export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m] ?? m} ${y}`;
}

/** IST month bounds [from, nextMonthStart) as 'YYYY-MM-DD HH:MM:SS' for paid_at filtering. */
export function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const mm = String(m).padStart(2, "0");
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { from: `${y}-${mm}-01 00:00:00`, to: `${ny}-${String(nm).padStart(2, "0")}-01 00:00:00` };
}
