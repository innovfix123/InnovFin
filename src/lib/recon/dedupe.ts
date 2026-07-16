import type { Txn } from "./types";

/**
 * Order-ID deduplication — the rule that the June-2026 edge cases forced on us.
 *
 * Two independent facts make this mandatory, and they pull in opposite directions:
 *
 *  1. The SAME order id appears on MULTIPLE rows. Both the app DB (TXN_DUP_A, counted
 *     twice at ₹299) and PhonePe's OWN files duplicate rows — TXN_RETRY_A and
 *     TXN_CARD_A each appear twice in the settlement report with identical amount and
 *     UTR. Summing rows naively over-counts on both sides.
 *
 *  2. PhonePe REUSES an order id across retries. TXN_RETRY_A is FAILED at 30-Jun
 *     23:59:47 and SUCCESS 16 seconds later at 01-Jul 00:00:03. So "keep the first row for
 *     each order" would keep the FAILED attempt and throw away the money that actually
 *     settled — the opposite of the truth.
 *
 * Hence: group by order id, and if ANY attempt succeeded, keep exactly ONE success (the latest);
 * otherwise drop the order entirely. Never "keep the first".
 *
 * A refunded payment counts as a success here: it WAS captured, so the supply happened. What to
 * do with the refund (net off, or credit note) is a presentation decision made downstream — not
 * a reason to delete the sale, which is the bug in the current Razorpay path.
 */

export type DropReason =
  | "duplicate-of-kept"
  | "failed-attempt-of-successful-order"
  | "all-attempts-failed";

export interface Dropped {
  txn: Txn;
  reason: DropReason;
}

/** Same order id, more than one SUCCESS, and the amounts disagree. Never expected — always report. */
export interface AmountConflict {
  orderId: string;
  amounts: number[];
}

export interface DedupeResult {
  kept: Txn[];
  /** Every row removed, with why. A dedupe that drops rows silently is how a leak goes unseen. */
  dropped: Dropped[];
  /** Order ids that appeared on more than one row (in either state). */
  duplicateOrderIds: string[];
  /** Duplicated successes whose amounts differ — a real double-charge would look like this. */
  amountConflicts: AmountConflict[];
}

const isSuccessful = (t: Txn) => t.status === "success" || t.status === "refunded";

export function dedupeByOrderId(txns: Txn[]): DedupeResult {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    const g = groups.get(t.orderId);
    if (g) g.push(t);
    else groups.set(t.orderId, [t]);
  }

  const kept: Txn[] = [];
  const dropped: Dropped[] = [];
  const duplicateOrderIds: string[] = [];
  const amountConflicts: AmountConflict[] = [];

  for (const [orderId, rows] of groups) {
    if (rows.length > 1) duplicateOrderIds.push(orderId);

    const successes = rows.filter(isSuccessful);
    const failures = rows.filter((t) => !isSuccessful(t));

    if (successes.length === 0) {
      for (const t of rows) dropped.push({ txn: t, reason: "all-attempts-failed" });
      continue;
    }

    // Latest success wins — this is what makes the 01-Jul retry beat the 30-Jun failure.
    // Sort is stable, so identical timestamps keep their original order and the choice is
    // deterministic across runs.
    const ordered = [...successes].sort((a, b) => a.txnTimeIST.localeCompare(b.txnTimeIST));
    const winner = ordered[ordered.length - 1];

    const distinct = [...new Set(successes.map((t) => t.amount))];
    if (distinct.length > 1) amountConflicts.push({ orderId, amounts: distinct });

    // Refunds may be recorded against any of the duplicate rows — carry the largest across so a
    // refund is never lost just because it landed on the row we discarded.
    const refunded = successes.reduce((a, t) => Math.max(a, t.refunded), 0);
    kept.push(refunded === winner.refunded ? winner : { ...winner, refunded });

    for (const t of successes) if (t !== winner) dropped.push({ txn: t, reason: "duplicate-of-kept" });
    for (const t of failures) dropped.push({ txn: t, reason: "failed-attempt-of-successful-order" });
  }

  return { kept, dropped, duplicateOrderIds, amountConflicts };
}

/** Σ gross of the kept rows, in ₹. */
export function grossOf(txns: Txn[]): number {
  return txns.reduce((a, t) => a + t.amount, 0);
}

/** Σ refunded across the kept rows, in ₹. */
export function refundedOf(txns: Txn[]): number {
  return txns.reduce((a, t) => a + t.refunded, 0);
}
