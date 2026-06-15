import { describe, it, expect } from "vitest";
import { parseGstr2b } from "./gstr2b";
import type { AOA } from "@/gst-core/gstr1";

describe("parseGstr2b", () => {
  it("reads 4(A)(5) ITC from the ITC Available summary + B2B invoices", () => {
    const sheets: Record<string, AOA> = {
      "ITC Available": [
        ["FORM GSTR-2B"],
        ["S.no.", "Heading", "GSTR-3B table", "Integrated Tax  (₹)", "Central Tax (₹)", "State/UT Tax (₹)", "Cess  (₹)"],
        ["I", "All other ITC ...", "4(A)(5)", 3698718.48, 120094.85, 120094.85, 0],
        ["II", "ISD", "4(A)(4)", 0, 0, 0, 0],
      ],
      "ITC not available": [
        ["x", "y", "GSTR-3B table", "IGST", "CGST", "SGST"],
        ["I", "...", "4(D)(2)", 0, 0, 0, 0],
      ],
      "ITC Reversal": [
        ["x", "y", "GSTR-3B table", "IGST", "CGST", "SGST"],
        ["I", "...", "4(B)(2)", 0, 0, 0, 0],
      ],
      "GSTR - 2B - B2B": [
        ["Goods and Services Tax"],
        ["GSTIN of supplier", "Trade/Legal name", "a", "b", "c", "d", "e", "Invoice number", "type", "date", "Invoice Value", "PoS", "RCM", "Taxable Value", "IGST", "CGST", "SGST", "Cess"],
        ["29AAICP2912R1ZR", "CASHFREE", "Available", "PG", "194H", "0.02", "sec", "CF/26-27/5391", "Regular", "30/04/2026", 3307.46, "KA", "No", 2802.93, 0, 252.26, 252.26, 0],
        ["33AABCZ7555P1ZM", "ZOCKET", "Available", "Ad", "194C", "0.02", "sec", "26-27/APR/100", "Regular", "03/04/2026", 1050000, "KA", "No", 889830.51, 160169.49, 0, 0, 0],
      ],
    };
    const r = parseGstr2b(sheets);

    expect(r.itcAvailable.igst).toBeCloseTo(3698718.48, 2);
    expect(r.itcAvailable.cgst).toBeCloseTo(120094.85, 2);
    expect(r.itcAvailable.sgst).toBeCloseTo(120094.85, 2);
    expect(r.itcReversed.igst).toBe(0);
    expect(r.itcIneligible.igst).toBe(0);

    expect(r.invoices).toHaveLength(2);
    expect(r.invoices[0].gstin).toBe("29AAICP2912R1ZR");
    expect(r.invoices.find((i) => i.gstin === "33AABCZ7555P1ZM")?.igst).toBeCloseTo(160169.49, 2);
    expect(r.itcAvailable.taxable).toBeCloseTo(2802.93 + 889830.51, 2);
  });
});
