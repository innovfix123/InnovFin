import { describe, it, expect } from "vitest";
import { computeGstr3b, sumTriplet, type Gstr3bInput } from "./gstr3b";

// Real April 2026 filing inputs (from the Master Reference / filed workings).
const april: Gstr3bInput = {
  period: "2026-04",
  outward: { taxable: 51061813.11, cgst: 4595563.18, sgst: 4595563.18 },
  rcm: {
    foreign: { taxable: 2144988, igst: 386097.84 },
    rent: { taxable: 102500, cgst: 9225, sgst: 9225 },
  },
  itc2b: { taxable: 21898928.96, igst: 3698718.48, cgst: 120094.85, sgst: 120094.85 },
};

describe("GSTR-3B — April 2026 golden master (₹52,52,218.18 challan)", () => {
  const r = computeGstr3b(april);

  it("Table 3.1 totals (outward + RCM)", () => {
    expect(sumTriplet(r.table31.total)).toBeCloseTo(9595674.2, 2);
    expect(r.table31.rcmLiability.igst).toBeCloseTo(386097.84, 2);
    expect(r.table31.total.cgst).toBeCloseTo(4604788.18, 2);
  });

  it("Table 4 ITC available = 2B + RCM", () => {
    expect(sumTriplet(r.table4.totalAvailable)).toBeCloseTo(4343456.02, 2);
    expect(r.table4.totalAvailable.igst).toBeCloseTo(4084816.32, 2);
  });

  it("Rule 88A: full surplus IGST credit split 50:50", () => {
    expect(r.offsetDetail.igstUsedForIgst).toBeCloseTo(0, 2); // RCM IGST is cash-only
    expect(r.offsetDetail.igstCrossToCgst).toBeCloseTo(2042408.16, 2);
    expect(r.offsetDetail.igstCrossToSgst).toBeCloseTo(2042408.16, 2);
  });

  it("Table 6.1: ITC used and cash per head", () => {
    expect(r.table61.igst.cash).toBeCloseTo(386097.84, 2);
    expect(r.table61.cgst.itcUsed).toBeCloseTo(2171728.01, 2);
    expect(r.table61.cgst.cash).toBeCloseTo(2433060.17, 2);
    expect(r.table61.sgst.cash).toBeCloseTo(2433060.17, 2);
  });

  it("Cash challan breakup ties to ₹52,52,218.18", () => {
    expect(r.cashChallan.rcm.total).toBeCloseTo(404547.84, 2);     // RCM mandatory cash
    expect(r.cashChallan.regular.total).toBeCloseTo(4847670.34, 2); // regular after ITC
    expect(r.cashChallan.total.grandTotal).toBeCloseTo(5252218.18, 2);
  });
});

describe("GSTR-3B — invariants", () => {
  it("RCM liability is never offset by ITC (always paid in cash)", () => {
    const r = computeGstr3b(april);
    // RCM cash equals the RCM liability exactly
    expect(r.cashChallan.rcm.igst).toBeCloseTo(april.rcm.foreign.igst, 2);
    expect(r.cashChallan.rcm.cgst).toBeCloseTo(april.rcm.rent.cgst, 2);
  });

  it("adds late fee + interest into the grand total", () => {
    const r = computeGstr3b({ ...april, lateFee: 1000, interest: 500 });
    expect(r.cashChallan.total.grandTotal).toBeCloseTo(5252218.18 + 1500, 2);
  });
});
