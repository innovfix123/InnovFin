/**
 * Section 201(1A) interest (app-agnostic math). The carry-forward STATE lives in the
 * TDS Working MCP; this only computes the amount.
 *  - 1%/month:   failure to deduct (deductible → deducted).
 *  - 1.5%/month: deducted-not-deposited (deducted → deposited).
 *  - "month or PART thereof" → any partial calendar month counts as a whole one.
 */
export const RATE_NOT_DEDUCTED = 0.01;
export const RATE_NOT_DEPOSITED = 0.015;

/** Interest = amount × ratePerMonth × ceil(months). 0 when amount or months ≤ 0. */
export function interest201_1A(amount: number, months: number, ratePerMonth: number = RATE_NOT_DEPOSITED): number {
  if (amount <= 0 || months <= 0) return 0;
  return amount * ratePerMonth * Math.ceil(months);
}

/**
 * Count of months "or part thereof" between two dates, per the 201(1A) convention:
 * every calendar month touched counts. So a deposit one day past a month-end is TWO months
 * (the classic gotcha). Returns 0 when `to` is not after `from`.
 */
export function monthsOrPart(from: Date, to: Date): number {
  if (to <= from) return 0;
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1;
}
