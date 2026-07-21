/**
 * Invoice line-item breakdown — parse the per-service charge rows out of a vendor invoice's raw text
 * so itc_invoices can show WHERE an invoice's taxable value comes from, not just its final tax heads.
 *
 * Deliberately FORMAT-SPECIFIC and best-effort: it recognises the Cashfree "TAX INVOICE" charge
 * table (the only structured-line vendor in hand) and returns null for anything else, so an
 * unrecognised invoice degrades to "no line items" rather than guessing. Pure: text in → breakdown
 * out. It only reads text already fetched via get_invoice and writes nothing — the estimate stays a
 * pure function of the registry.
 */
import { round2 } from "./util";
import type { InvoiceLineItem, LineItemBreakdown } from "./types";

const HSN_RE = /^\d{6}$/;             // 997158 / 997159
const RATE_RE = /^\d{1,2}\.\d{2}$/;   // 18.00 / 0.00
const QTY_RE = /^[\d,]+$/;            // 88614 / 173172 / 1   (integer, no decimals)
const AMOUNT_RE = /^[\d,]+\.\d{2}$/;  // 288,014.00 / 0.00 / 39,776,000.00
const ACCOUNT_ID_RE = /^account id:/i;
const TOTALS_RE = /^taxable sub ?total/i;

/** Cashfree groups its charges under these section headers, each followed by an "Account ID:" line. */
const CASHFREE_CATEGORIES = new Set(["PAYOUT", "SUBSCRIPTION", "PAYMENT GATEWAY", "PAN VERIFICATION"]);

const toNumber = (s: string): number => Number(s.replace(/,/g, ""));

/** A Cashfree tax invoice is recognisable by its charge-table columns + the taxable-subtotal label.
 *  (TOTALS_RE is `^`-anchored for the per-line scan below, so match the label un-anchored here.) */
function isCashfreeInvoice(text: string): boolean {
  return /transacted \(inr\)/i.test(text) && /charges \(inr\)/i.test(text) && /taxable sub ?total/i.test(text);
}

/** A section header word ("PAYMENT GATEWAY*" → "PAYMENT GATEWAY"), else null. */
const categoryHeader = (line: string): string | null => {
  const norm = line.replace(/\*+$/, "").trim().toUpperCase();
  return CASHFREE_CATEGORIES.has(norm) ? norm : null;
};

/**
 * Parse the Cashfree charge table. Each row is: [1+ description lines] then the fixed numeric block
 * HSN / GST% / QUANTITY / AMOUNT-TRANSACTED / CHARGES. `charge` (the last column) is the taxable fee
 * for the row; `amountTransacted` is the underlying transaction volume and is NOT taxable. Section
 * headers (PAYOUT/SUBSCRIPTION/…) tag each row's category and are told apart from an identically
 * named description row ("PAN Verification") by being immediately followed by an "Account ID:" line.
 */
function parseCashfree(text: string): InvoiceLineItem[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const items: InvoiceLineItem[] = [];
  let descBuf: string[] = [];
  let category: string | null = null;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (TOTALS_RE.test(line)) break; // reached the totals block — stop before it

    const header = categoryHeader(line);
    if (header && ACCOUNT_ID_RE.test(lines[i + 1] ?? "")) {
      category = header;
      descBuf = [];
      i += 1;
      continue;
    }
    if (ACCOUNT_ID_RE.test(line)) { i += 1; continue; }

    if (
      HSN_RE.test(line) && i + 4 < lines.length &&
      RATE_RE.test(lines[i + 1]) && QTY_RE.test(lines[i + 2]) &&
      AMOUNT_RE.test(lines[i + 3]) && AMOUNT_RE.test(lines[i + 4])
    ) {
      items.push({
        category,
        description: descBuf.join(" ").replace(/\s+/g, " ").trim(),
        hsnSac: line,
        gstRatePct: toNumber(lines[i + 1]),
        quantity: toNumber(lines[i + 2]),
        amountTransacted: toNumber(lines[i + 3]),
        charge: toNumber(lines[i + 4]),
      });
      descBuf = [];
      i += 5;
      continue;
    }

    descBuf.push(line);
    i += 1;
  }
  return items;
}

/** Roll the flat rows up into per-category subtotals + a reconciliation against the invoice taxable. */
function summarize(source: string, items: InvoiceLineItem[], taxableValue: number | null): LineItemBreakdown {
  const byCat = new Map<string, { lines: number; charge: number }>();
  let sum = 0;
  for (const it of items) {
    sum += it.charge;
    const key = it.category ?? "OTHER";
    const c = byCat.get(key) ?? { lines: 0, charge: 0 };
    c.lines += 1;
    c.charge += it.charge;
    byCat.set(key, c);
  }
  const taxableFromLines = round2(sum);
  return {
    source,
    count: items.length,
    items,
    byCategory: [...byCat.entries()]
      .map(([category, v]) => ({ category, lines: v.lines, charge: round2(v.charge) }))
      .sort((a, b) => b.charge - a.charge),
    taxableFromLines,
    // ₹1 slack: each row's charge is itself rounded on the PDF, so the sum drifts a few paise.
    reconcilesToTaxable: taxableValue == null ? null : Math.abs(taxableFromLines - taxableValue) <= 1,
  };
}

/**
 * The per-line composition behind an invoice's taxable value, or null when the format isn't one we
 * parse (the raw text still lives in the registry via get_invoice, so nothing is lost).
 */
export function parseLineItems(
  text: string | null | undefined,
  taxableValue: number | null = null,
): LineItemBreakdown | null {
  if (!text || !isCashfreeInvoice(text)) return null;
  const items = parseCashfree(text);
  if (items.length === 0) return null;
  return summarize("cashfree-tax-invoice", items, taxableValue);
}
