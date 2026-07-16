/**
 * Gateway reconciliation layer.
 *
 * ADDITIVE. Nothing in the production GST path imports this. Enabling it to feed GSTR-1 is a
 * separate, flagged decision (Phase 4) that has NOT been taken.
 *
 * Why it exists: every app we source from its payment gateway reconciles to the rupee; the one
 * app we source from its own database (Hima) does not. This layer reads the gateways directly so
 * the two can be compared, and the difference explained, before anything about filing changes.
 */

export type { Txn, TxnSource, TxnStatus } from "./types";
export { istFromNaive, istFromDmy, istFromOffsetIso, istFromEpochSec, isInMonthIST } from "./types";

export { readCsv, col, money } from "./csv";
export type { Csv } from "./csv";
export { dedupeByOrderId, grossOf, refundedOf } from "./dedupe";
export type { DedupeResult, Dropped, DropReason, AmountConflict } from "./dedupe";

export { fetchCashfreeTxns } from "./cashfree-source";
export type { CashfreeTxnResult } from "./cashfree-source";

export { parsePhonePeCsv, parsePhonePeFiles, detectFormat } from "./phonepe-source";
export type { PhonePeFile, PhonePeFormat, PhonePeResult, PhonePeParseResult } from "./phonepe-source";

export { fetchRazorpayTxns } from "./razorpay-source";
export type { RazorpayTxnResult } from "./razorpay-source";

export { fetchAppDbFiled, fetchAppDbAll, assertReadOnly } from "./appdb-source";
export type { AppDbFiledResult, AppDbAllResult, AppDbRow } from "./appdb-source";
