import { at, money, openCsv } from "./csv";
import { dedupeByOrderId, type DedupeResult } from "./dedupe";
import { istFromDmy, istFromNaive, isInMonthIST, pushAll, type Txn, type TxnStatus } from "./types";

/**
 * PhonePe → normalised transactions, from the merchant report CSVs.
 *
 * PhonePe has no API credentials in this environment (there is no PHONEPE_* var in .env), so this
 * is a FILE source. It is deliberately shaped so that a PhonePe API can be dropped in later by
 * replacing ONLY the row producer: everything downstream — normalisation, dedupe, month bounding,
 * the reconciliation engine — consumes `Txn` and neither knows nor cares where it came from.
 *
 * PhonePe ships FOUR report shapes, and they disagree with each other in ways that silently
 * corrupt a naive reader:
 *
 *   • FORWARD_TRANSACTION  — "Transaction Status" is SUCCESS / FAILED, dates 'YYYY-MM-DD HH:mm:ss'
 *   • SETTLEMENT_REPORT    — the same state is spelled COMPLETED, plus the settlement UTR + MDR
 *   • Merchant_Settlement  — dates are 'DD-MM-YYYY' (day first!) and there is no status column
 *   • REFUND_TRANSACTION   — reversals. (All three June files are header-only: PhonePe had ZERO
 *                            refunds in June-2026.)
 *
 * Two traps this deliberately avoids:
 *
 *  1. A blank UTR does not mean the payment failed. "Transaction UTR" in the forward file is a
 *     UPI-rail column, so every CARD payment has it empty. TXN_CARD_A (₹699, CARD) looked
 *     unsettled for exactly this reason and had in fact settled on 10-Jun (ref UTR_CARD_A).
 *     References therefore fall back across the UPI / card / bank columns, and a blank one is never
 *     treated as evidence of anything.
 *
 *  2. The exports OVERLAP and repeat rows. The same order appears across several files, and PhonePe
 *     duplicates rows even within one file. Everything goes through dedupeByOrderId().
 */

export type PhonePeFormat = "forward" | "settlement" | "monthly-settlement" | "refund" | "fee-invoice" | "unknown";

/** A file whose text is already in memory (e.g. an HTTP upload). */
export interface PhonePeFile {
  name: string;
  text: string;
}

/** A file read on demand. Use this for month exports: the texts total >400 MB and must not all be
 *  resident at once. Each is loaded, parsed to `Txn` (7 small fields), then released. */
export interface PhonePeLazyFile {
  name: string;
  read: () => string;
}

type AnyFile = PhonePeFile | PhonePeLazyFile;
const textOf = (f: AnyFile): string => ("text" in f ? f.text : f.read());

/** Which of PhonePe's report shapes is this? Decided from the header row, not the filename. */
export function detectFormat(headers: string[]): PhonePeFormat {
  const h = new Set(headers.map((s) => s.toLowerCase().replace(/[\s_]+/g, "")));
  const has = (...keys: string[]) => keys.every((k) => h.has(k.toLowerCase().replace(/[\s_]+/g, "")));

  if (has("totalrefundamount")) return "refund";
  if (has("invoiceno", "taxableamount")) return "fee-invoice"; // the MDR invoice — 194H, not sales
  if (has("merchantreferenceid", "bankreferenceno")) return "monthly-settlement";
  if (has("merchantorderid", "settlementutr")) return "settlement";
  if (has("merchantorderid", "transactionstatus")) return "forward";
  return "unknown";
}

function statusOf(raw: string): TxnStatus {
  const s = raw.trim().toUpperCase();
  if (s === "SUCCESS" || s === "COMPLETED") return "success";
  if (s === "FAILED" || s === "ERROR") return "failed";
  return "unknown";
}

export interface PhonePeParseResult {
  txns: Txn[];
  refunds: Record<string, number>;
  format: PhonePeFormat;
  rows: number;
}

/** Parse ONE PhonePe CSV into normalised rows. Streams; format is auto-detected from the HEADER,
 *  so a legitimately empty report (June's refund files) is identified rather than written off. */
export function parsePhonePeCsv(text: string): PhonePeParseResult {
  const csv = openCsv(text);
  if (csv.headers.length === 0) return { txns: [], refunds: {}, format: "unknown", rows: 0 };

  const format = detectFormat(csv.headers);
  const txns: Txn[] = [];
  const refunds: Record<string, number> = {};
  let rows = 0;

  // The MDR invoice is the 194H commission side — it is NOT outward supply. Summing its
  // "Transaction Amount" into GSTR-1 would invent revenue that never existed.
  if (format === "fee-invoice" || format === "unknown") {
    for (const _ of csv.rows()) rows++;
    return { txns: [], refunds: {}, format, rows };
  }

  // Resolve every column ONCE, then read each row by index — no per-row object is ever built.
  const monthly = format === "monthly-settlement";
  const iOrder = monthly
    ? csv.index("MerchantReferenceId")
    : csv.index("Merchant Order Id", "Merchant Reference ID", "Merchant Reference Id");
  const iAmount = csv.index(monthly ? "Amount" : "Transaction Amount");
  const iDate = csv.index(monthly ? "TransactionDate" : "Transaction Date");
  const iStatus = csv.index("Transaction Status");
  const iType = csv.index(monthly ? "PaymentType" : "Payment Type");
  const iMethod = csv.index("Instrument");
  const iRefund = csv.index("Total Refund Amount");
  const iRefs = [
    csv.index("Settlement UTR"), csv.index("BankReferenceNo"), csv.index("Transaction UTR"),
    csv.index("UPI_UTR"), csv.index("Card_ARN"), csv.index("Card_BRN"), csv.index("ARN"), csv.index("BRN"),
  ].filter((i) => i >= 0);

  const referenceOf = (cells: string[]): string | null => {
    for (const i of iRefs) {
      const v = at(cells, i);
      if (v) return v;
    }
    return null;
  };

  for (const cells of csv.rows()) {
    rows++;
    const orderId = at(cells, iOrder);
    if (!orderId) continue;

    if (format === "refund") {
      if (statusOf(at(cells, iStatus)) !== "success") continue;
      const amt = money(at(cells, iRefund)) || money(at(cells, iAmount));
      refunds[orderId] = (refunds[orderId] ?? 0) + Math.abs(amt);
      continue;
    }

    const amt = money(at(cells, iAmount));
    const date = at(cells, iDate);
    if (!date) continue;

    // Settlement reports carry reversals inline; they are refunds, not sales.
    if (at(cells, iType).toUpperCase() === "REFUND") {
      refunds[orderId] = (refunds[orderId] ?? 0) + Math.abs(amt);
      continue;
    }

    txns.push({
      orderId,
      amount: amt,
      // A settlement report has no status column: every row in it is money that MOVED.
      status: monthly ? "success" : statusOf(at(cells, iStatus)),
      // 'DD-MM-YYYY' is DAY-first. Read as ISO, 06-07-2026 would become 6 July instead of 7 June
      // and land in the wrong return.
      txnTimeIST: monthly ? istFromDmy(date) : istFromNaive(date),
      source: "phonepe",
      method: at(cells, iMethod) || null,
      refunded: 0,
      reference: referenceOf(cells),
    });
  }

  return { txns, refunds, format, rows };
}

export interface PhonePeResult {
  /** Deduped SUCCESS transactions whose payment date is inside the month. */
  txns: Txn[];
  /** Deduped successes that fell OUTSIDE the month — surfaced, never silently dropped. */
  outOfMonth: Txn[];
  dedupe: DedupeResult;
  byFile: { name: string; format: PhonePeFormat; rows: number; txns: number }[];
  refunds: Record<string, number>;
}

/**
 * Parse a set of PhonePe report files into one deduped, month-bounded view.
 * Pass EVERY file for the period — overlapping exports are expected and handled.
 */
export function parsePhonePeFiles(files: AnyFile[], period: string): PhonePeResult {
  const all: Txn[] = [];
  const refunds: Record<string, number> = {};
  const byFile: PhonePeResult["byFile"] = [];

  for (const f of files) {
    // Scoped so the file's text is unreachable — and collectable — before the next one is read.
    const r = parsePhonePeCsv(textOf(f));
    byFile.push({ name: f.name, format: r.format, rows: r.rows, txns: r.txns.length });
    pushAll(all, r.txns); // NOT push(...r.txns) — see pushAll(); a 440k-row file overflows the stack
    for (const [id, amt] of Object.entries(r.refunds)) refunds[id] = (refunds[id] ?? 0) + amt;
  }

  // Attach refunds before dedupe so a refund survives whichever duplicate row is kept.
  for (const t of all) {
    const r = refunds[t.orderId];
    if (r) { t.refunded = r; t.status = "refunded"; }
  }

  const dedupe = dedupeByOrderId(all);
  const txns: Txn[] = [];
  const outOfMonth: Txn[] = [];
  for (const t of dedupe.kept) (isInMonthIST(t.txnTimeIST, period) ? txns : outOfMonth).push(t);

  return { txns, outOfMonth, dedupe, byFile, refunds };
}
