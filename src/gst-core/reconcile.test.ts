import { describe, it, expect } from "vitest";
import { computeGstr3b, type Gstr3bInput } from "./gstr3b";
import { reconcileGstr1Vs3b, reconcileGstr3bInternal, reconcilePurchasesVs2b, type PurchaseInvoice } from "./reconcile";

const april: Gstr3bInput = {
  period: "2026-04",
  outward: { taxable: 51061813.11, cgst: 4595563.18, sgst: 4595563.18 },
  rcm: { foreign: { taxable: 2144988, igst: 386097.84 }, rent: { taxable: 102500, cgst: 9225, sgst: 9225 } },
  itc2b: { taxable: 21898928.96, igst: 3698718.48, cgst: 120094.85, sgst: 120094.85 },
};

describe("reconcile — April 2026 (validated working)", () => {
  const g3 = computeGstr3b(april);

  it("forward: GSTR-1 ↔ 3B Table 3.1(a) = 0 difference", () => {
    const r = reconcileGstr1Vs3b(april.outward, g3);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.label)).toContain("3.1(a) taxable = GSTR-1 taxable");
  });

  it("backward: all 3B internal invariants hold", () => {
    const r = reconcileGstr3bInternal(g3);
    expect(r.ok).toBe(true);
    // RCM is paid in cash, never offset
    expect(r.checks.find((c) => c.label.startsWith("RCM IGST"))?.ok).toBe(true);
    // challan ties out
    expect(r.checks.find((c) => c.label.startsWith("Challan"))?.ok).toBe(true);
  });

  it("catches a GSTR-1 vs 3B mismatch (₹100 off)", () => {
    const r = reconcileGstr1Vs3b({ ...april.outward, taxable: april.outward.taxable + 100 }, g3);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label.includes("taxable"))?.diff).toBeCloseTo(-100, 2);
  });
});

describe("reconcile — purchases vs GSTR-2B (Master Reference §6.2)", () => {
  it("flags in-books-not-in-2B, in-2B-not-in-books, and tax diffs", () => {
    const books: PurchaseInvoice[] = [
      { gstin: "29ABCDE1234F1Z5", invoiceNo: "A1", taxable: 1000, igst: 0, cgst: 90, sgst: 90 },
      { gstin: "29ZZZZZ9999Z1Z9", invoiceNo: "B2", taxable: 500, igst: 90, cgst: 0, sgst: 0 },
    ];
    const twoB: PurchaseInvoice[] = [
      { gstin: "29ABCDE1234F1Z5", invoiceNo: "A1", taxable: 1000, igst: 0, cgst: 90, sgst: 90 },
      { gstin: "29QQQQQ0000Q1Z0", invoiceNo: "C3", taxable: 200, igst: 36, cgst: 0, sgst: 0 },
    ];
    const r = reconcilePurchasesVs2b(books, twoB);
    expect(r.inBooksNotIn2b.map((i) => i.invoiceNo)).toEqual(["B2"]);
    expect(r.in2bNotInBooks.map((i) => i.invoiceNo)).toEqual(["C3"]);
    expect(r.matched).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it("ok when the books match GSTR-2B exactly", () => {
    const inv: PurchaseInvoice[] = [{ gstin: "29ABCDE1234F1Z5", invoiceNo: "A1", taxable: 1000, igst: 0, cgst: 90, sgst: 90 }];
    expect(reconcilePurchasesVs2b(inv, inv).ok).toBe(true);
  });
});
