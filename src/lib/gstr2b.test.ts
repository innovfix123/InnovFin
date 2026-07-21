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

  // The workbook that actually reaches us has been edited in Excel first: the CA inserts SIX
  // classification columns (Incharge / Availability / Service / Section / TDS Rate / New Section)
  // between the supplier name and the invoice details, and the portal splits its headers over two
  // rows. Reading fixed positions here silently produced garbage — "New Section" as the invoice
  // number, "Supply Attract Reverse Charge" ("No") as taxable 0, and the TAXABLE VALUE as IGST.
  const REAL_B2B_SHEET: AOA = [
    ["Goods and Services Tax  - GSTR-2B"],
    [],
    [],
    ["Taxable inward supplies received from registered persons"],
    ["GSTIN of supplier", "Trade/Legal name", "", "", "", "", "", "", "Invoice Details", "", "", "",
     "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "",
     "GSTR-1/1A/IFF/GSTR-5 Period"],
    ["", "", "Incharge", "Availability of invoice", "Service", "Section", "TDS Rate", "New Section",
     "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "",
     "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", ""],
    [],
    [],
    // Values are synthetic but deliberately all-distinct, so any column shift changes an assertion.
    ["29AAICP2912R1ZR", "CASHFREE PAYMENTS INDIA PRIVATE LIMITED", "", 0, "Payment Gateway", "194H",
     0.02, "393(1) [Sl. No. 1(ii)]", "CF/26-27/00001", "Regular", "30/06/2026", 118000, "Karnataka",
     "No", 100000, 0, 9000, 9000, 0, "Jun'26"],
  ];

  it("locates B2B columns by header text, not position, when the CA has inserted columns", () => {
    const r = parseGstr2b({
      "ITC Available": [["I", "All other ITC", "4(A)(5)", 0, 9000, 9000, 0]],
      B2B: REAL_B2B_SHEET,
    });
    expect(r.invoices).toHaveLength(1);
    const inv = r.invoices[0];
    expect(inv.invoiceNo).toBe("CF/26-27/00001"); // not "393(1) [Sl. No. 1(ii)]"
    expect(inv.taxable).toBeCloseTo(100000, 2);  // not 0 (parsed from "No")
    expect(inv.igst).toBe(0);                    // not the taxable value
    expect(inv.cgst).toBeCloseTo(9000, 2);
    expect(inv.sgst).toBeCloseTo(9000, 2);
    expect(inv.supplierName).toBe("CASHFREE PAYMENTS INDIA PRIVATE LIMITED");
    expect(inv.invoiceDate).toBe("30/06/2026");
  });

  it("cross-checks the B2B rows against the portal's own 4(A)(5) summary", () => {
    // Agreement between two independently-read parts of the workbook is the tripwire that catches
    // a column shift — without it a misparse is confident and silent.
    const r = parseGstr2b({
      "ITC Available": [["I", "All other ITC", "4(A)(5)", 0, 9000, 9000, 0]],
      B2B: REAL_B2B_SHEET,
    });
    expect(r.b2bTotals.matchesSummary).toBe(true);
    expect(r.b2bTotals.invoices).toBe(1);

    const shifted = parseGstr2b({
      "ITC Available": [["I", "All other ITC", "4(A)(5)", 999999, 0, 0, 0]],
      B2B: REAL_B2B_SHEET,
    });
    expect(shifted.b2bTotals.matchesSummary).toBe(false);
  });

  it("refuses to parse a B2B sheet whose money columns can't be identified", () => {
    expect(() => parseGstr2b({
      "ITC Available": [["I", "x", "4(A)(5)", 0, 0, 0, 0]],
      B2B: [
        ["GSTIN of supplier", "Trade/Legal name", "mystery", "columns", "here"],
        ["29AAICP2912R1ZR", "CASHFREE", 1, 2, 3],
      ],
    })).toThrow(/could not find column/i);
  });
});
