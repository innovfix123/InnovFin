/**
 * Reconciliations — the forward/backward/cross checks Shoyab does by hand before filing,
 * so a mismatch is caught automatically instead of slipping into the portal.
 *
 *  - Forward:  GSTR-1 total  ==  GSTR-3B Table 3.1(a)   (Master Reference §6.1)
 *  - Backward: GSTR-3B internal invariants (3.1 total, Table 4 ITC, Table 6.1, RCM-in-cash, challan)
 *  - Cross:    books purchase register  vs  GSTR-2B B2B  (Master Reference §6.2)
 *
 * Pure functions; every check carries expected/actual/diff so the UI can show "0 difference".
 */

import type { Gstr3bResult } from "./gstr3b";

/** Rupee tolerance — money math is full-precision, display rounds to paise. */
const TOL = 0.02;

export interface Check {
  label: string;
  expected: number;
  actual: number;
  diff: number;
  ok: boolean;
}

export interface ReconReport {
  checks: Check[];
  ok: boolean;
}

function chk(label: string, expected: number, actual: number, tol = TOL): Check {
  const diff = actual - expected;
  return { label, expected, actual, diff, ok: Math.abs(diff) <= tol };
}

const HEADS = ["igst", "cgst", "sgst"] as const;

export interface Gstr1Totals {
  taxable: number;
  cgst: number;
  sgst: number;
  igst?: number;
}

/** Forward check — GSTR-3B Table 3.1(a) must equal the GSTR-1 total to the rupee. */
export function reconcileGstr1Vs3b(g1: Gstr1Totals, g3: Gstr3bResult): ReconReport {
  const a = g3.table31.outwardTaxable;
  const checks = [
    chk("3.1(a) taxable = GSTR-1 taxable", g1.taxable, a.taxable),
    chk("3.1(a) IGST = GSTR-1 IGST", g1.igst ?? 0, a.igst),
    chk("3.1(a) CGST = GSTR-1 CGST", g1.cgst, a.cgst),
    chk("3.1(a) SGST = GSTR-1 SGST", g1.sgst, a.sgst),
  ];
  return { checks, ok: checks.every((c) => c.ok) };
}

/** Backward / consistency check — the 3B working must be internally coherent. */
export function reconcileGstr3bInternal(g3: Gstr3bResult): ReconReport {
  const { table31: t31, table4: t4, table61: t61, cashChallan: cc } = g3;
  const checks: Check[] = [];

  for (const h of HEADS) checks.push(chk(`3.1 total ${h.toUpperCase()} = outward + RCM`, t31.outwardTaxable[h] + t31.rcmLiability[h], t31.total[h]));
  for (const h of HEADS) checks.push(chk(`4(A) ITC available ${h.toUpperCase()} = RCM + 2B`, t4.itcRcm[h] + t4.itcOther[h], t4.totalAvailable[h]));
  for (const h of HEADS) checks.push(chk(`6.1 ${h.toUpperCase()}: liability = ITC used + cash`, t61[h].liability, t61[h].itcUsed + t61[h].cash));
  // RCM must be paid in cash, never offset by ITC (Sec 49(4)).
  for (const h of HEADS) checks.push(chk(`RCM ${h.toUpperCase()} paid in cash (not offset)`, t31.rcmLiability[h], cc.rcm[h]));

  const cashSum = HEADS.reduce((a, h) => a + t61[h].cash, 0);
  checks.push(chk("Challan = Σ(6.1 cash) + late fee + interest", cashSum + cc.lateFee + cc.interest, cc.total.grandTotal));

  return { checks, ok: checks.every((c) => c.ok) };
}

export interface PurchaseInvoice {
  gstin: string;
  invoiceNo: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface PurchaseRecon {
  matched: Array<{ key: string; taxDiff: number }>;
  /** In the books but not in GSTR-2B → ITC at risk; chase the supplier. */
  inBooksNotIn2b: PurchaseInvoice[];
  /** In GSTR-2B but not booked → record the bill. */
  in2bNotInBooks: PurchaseInvoice[];
  ok: boolean;
}

const invKey = (i: PurchaseInvoice) => `${i.gstin}|${i.invoiceNo}`.toUpperCase().replace(/\s+/g, "");
const taxOf = (i: PurchaseInvoice) => i.igst + i.cgst + i.sgst;

/** Cross check — match the books purchase register against GSTR-2B B2B invoices. */
export function reconcilePurchasesVs2b(books: PurchaseInvoice[], twoB: PurchaseInvoice[]): PurchaseRecon {
  const bMap = new Map(books.map((i) => [invKey(i), i]));
  const tMap = new Map(twoB.map((i) => [invKey(i), i]));
  const matched: Array<{ key: string; taxDiff: number }> = [];
  const inBooksNotIn2b: PurchaseInvoice[] = [];
  const in2bNotInBooks: PurchaseInvoice[] = [];

  for (const [k, b] of bMap) {
    const t = tMap.get(k);
    if (t) matched.push({ key: k, taxDiff: taxOf(t) - taxOf(b) });
    else inBooksNotIn2b.push(b);
  }
  for (const [k, t] of tMap) if (!bMap.has(k)) in2bNotInBooks.push(t);

  const ok = inBooksNotIn2b.length === 0 && in2bNotInBooks.length === 0 && matched.every((m) => Math.abs(m.taxDiff) <= TOL);
  return { matched, inBooksNotIn2b, in2bNotInBooks, ok };
}
