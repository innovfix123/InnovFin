import type { AOA, Cell } from "@/gst-core/gstr1";
import { num } from "@/gst-core/gstr1";
import type { RcmExpense } from "@/gst-core/rcm";

function norm(s: Cell): string {
  return String(s ?? "").trim().toLowerCase();
}

export interface BankExpense {
  date: string;
  narration: string;
  amount: number;
}

/**
 * Parse a raw bank-statement sheet (HDFC or Yes Bank) into withdrawal/expense rows.
 * Detects the header by a Narration/Description column + a Withdrawal(s) column, so the
 * same function handles both layouts. Deposits/credits are ignored — RCM is about money
 * paid out. (Raw statements feed the AI categoriser; they are NOT the RCM source of truth.)
 */
export function parseBankStatement(aoa: AOA): BankExpense[] {
  let hr = -1, cNar = -1, cAmt = -1, cDate = -1;
  for (let i = 0; i < Math.min(aoa.length, 40); i++) {
    const cells = (aoa[i] || []).map(norm);
    const nar = cells.findIndex((c) => c === "narration" || c === "description");
    const amt = cells.findIndex((c) => c.includes("withdrawal"));
    if (nar >= 0 && amt >= 0) {
      hr = i; cNar = nar; cAmt = amt;
      cDate = cells.findIndex((c) => c.includes("date"));
      break;
    }
  }
  if (hr < 0) throw new Error("Bank statement: no header with a Narration/Description + Withdrawal column.");

  const out: BankExpense[] = [];
  for (let i = hr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const amount = num(row[cAmt]);
    const narration = String(row[cNar] ?? "").trim();
    if (isNaN(amount) || amount <= 0 || !narration) continue;
    out.push({ date: cDate >= 0 ? String(row[cDate] ?? "").trim() : "", narration, amount });
  }
  return out;
}

/**
 * Read an "Expense Categorisation" pivot — the validated RCM source of truth (Master
 * Reference §4.2) — and return the rows flagged "RCM Applicable" as {vendor, amount}.
 * Robust to column order: a row counts as RCM if any of its cells equals "RCM Applicable".
 * Feed the result to computeRcm() to get Table 3.1(d).
 */
export function parseRcmPivot(aoa: AOA): RcmExpense[] {
  let hr = -1, cCat = -1, cTotal = -1;
  for (let i = 0; i < Math.min(aoa.length, 30); i++) {
    const cells = (aoa[i] || []).map(norm);
    const cat = cells.findIndex((c) => c.includes("categorisation") || c.includes("categorization"));
    const tot = cells.findIndex((c) => c === "total" || c.includes("withdrawal") || c === "amount");
    if (cat >= 0 && tot >= 0) { hr = i; cCat = cat; cTotal = tot; break; }
  }
  if (hr < 0) throw new Error("RCM pivot: no header with an 'Expense Categorisation' + 'Total' column.");

  const out: RcmExpense[] = [];
  for (let i = hr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    if (!row.some((c) => norm(c) === "rcm applicable")) continue;
    const vendor = String(row[cCat] ?? "").trim();
    const amount = num(row[cTotal]);
    if (!vendor || isNaN(amount)) continue;
    out.push({ vendor, amount });
  }
  return out;
}
