import { describe, it, expect } from "vitest";
import { renderEstimateReport, money } from "./report";
import { buildEstimate } from "./compute";
import type { RegistryInvoice } from "./types";

const inv = (o: Partial<RegistryInvoice> = {}): RegistryInvoice => ({
  docId: "d1",
  invoiceNumber: "INV-001",
  invoiceDate: "2026-06-05",
  receivedDate: "2026-06-06",
  vendorName: "Acme Tech",
  vendorGstin: "29AAACX1234F1Z5",
  buyerGstin: null,
  currency: "INR",
  taxableValue: 1000,
  igst: null,
  cgst: 90,
  sgst: 90,
  cess: null,
  total: 1180,
  hsnSac: "998313",
  sender: "billing@acme.example",
  ...o,
});

const render = (rows: RegistryInvoice[], opts = {}) => {
  const { estimate, lines } = buildEstimate(rows, { period: "2026-06", ...opts });
  return renderEstimateReport(estimate, lines);
};

describe("money", () => {
  it("formats rupees Indian-style and foreign currency with its ISO code", () => {
    expect(money(135113.82)).toBe("₹1,35,113.82");
    expect(money(240, "USD")).toBe("USD 240.00");
    expect(money(240, "USD")).not.toContain("₹");
  });
});

describe("renderEstimateReport", () => {
  it("leads with the period, the ESTIMATE basis, and ITC by head", () => {
    const r = render([inv()]);
    expect(r).toContain("# Estimated GSTR-2B — June 2026");
    expect(r).toMatch(/NOT the filed GSTR-2B/);
    expect(r).toContain("## ITC Available");
    expect(r).toContain("| CGST | ₹90.00 |");
    expect(r).toContain("**Total ITC** | **₹180.00**");
  });

  it("notes the point-in-time cut-off when one was applied", () => {
    expect(render([inv()], { receivedTo: "2026-07-03" })).toContain("as of 2026-07-03");
    expect(render([inv()])).not.toContain("as of");
  });

  it("breaks the headline down supplier-wise", () => {
    const r = render([inv(), inv({ docId: "d2", invoiceNumber: "B-1", vendorGstin: "27AAACX1234F1Z5", vendorName: "Beta Ltd", igst: 180, cgst: null, sgst: null })]);
    expect(r).toContain("## Supplier-wise");
    expect(r).toContain("Acme Tech");
    expect(r).toContain("Beta Ltd");
  });

  it("lists the review bucket with its exclusion reasons, and the potential ITC", () => {
    const r = render([inv(), inv({ docId: "r1", invoiceNumber: "R-1", vendorGstin: null, cgst: 900, sgst: 900 })]);
    expect(r).toMatch(/## Under review — excluded from the headline \(1\)/);
    expect(r).toContain("NO_GSTIN");
    expect(r).toContain("Potential additional ITC if review clears them: ₹1,800.00");
  });

  it("says so plainly when nothing was excluded", () => {
    expect(render([inv()])).toContain("Nothing excluded on eligibility grounds");
  });

  it("prints a USD review line with its currency code, never a rupee sign", () => {
    // The registry holds USD OIDAR receipts beside rupee bills; $20 must never render as ₹20.
    const r = render([inv({ docId: "u1", invoiceNumber: "US-1", currency: "USD", total: 20, cgst: null, sgst: null })]);
    expect(r).toContain("USD 20.00");
    expect(r).not.toContain("₹20.00");
  });

  it("keeps each pending currency separate in the not-yet-included line", () => {
    const r = render([inv()], { needsReviewPending: { count: 25, totalInclGst: 23600, foreignInclGst: { USD: 2877.6 } } });
    expect(r).toContain("25 invoices ≈ ₹23,600.00 + USD 2,877.60");
    expect(r).not.toContain("₹26,477");
  });

  it("renders the charge-wise breakup with the exempt row marked and a tie-back note", () => {
    const withLines = inv({ docId: "c1", taxableValue: 300 });
    const { estimate, lines } = buildEstimate([withLines], { period: "2026-06" });
    lines[0].lineItems = {
      source: "test", count: 2,
      items: [
        { category: "PG", description: "Gateway charges", hsnSac: "997158", gstRatePct: 18, quantity: 1, amountTransacted: 0, charge: 300 },
        { category: "PG", description: "Small card txns", hsnSac: "997159", gstRatePct: 0, quantity: 7, amountTransacted: 603, charge: 0 },
      ],
      byCategory: [{ category: "PG", lines: 2, charge: 300 }],
      taxableFromLines: 300, reconcilesToTaxable: true,
    };
    const r = renderEstimateReport(estimate, lines);
    expect(r).toContain("## Charge-wise breakup");
    expect(r).toContain("Gateway charges");
    expect(r).toContain("*(exempt)*");
    expect(r).toContain("**Total charges** | | | **₹300.00**");
    expect(r).toContain("Charge rows reconcile to the invoice taxable value.");
  });

  it("flags a charge breakup that does not tie back to the taxable value", () => {
    const { estimate, lines } = buildEstimate([inv()], { period: "2026-06" });
    lines[0].lineItems = {
      source: "test", count: 1,
      items: [{ category: null, description: "X", hsnSac: "997158", gstRatePct: 18, quantity: 1, amountTransacted: 0, charge: 5 }],
      byCategory: [], taxableFromLines: 5, reconcilesToTaxable: false,
    };
    expect(renderEstimateReport(estimate, lines)).toContain("do NOT reconcile");
  });

  it("omits the charge section entirely when no invoice layout was parsed", () => {
    expect(render([inv()])).not.toContain("## Charge-wise breakup");
  });

  it("carries the pending-Shoyab eligibility warning exactly once", () => {
    const r = render([inv()]);
    expect(r).toMatch(/pending Shoyab/i);
    expect(r).not.toContain("⚠ ⚠");
  });

  it("pluralises counts", () => {
    expect(render([inv()])).toContain("1 invoice · 1 vendor");
    expect(render([inv(), inv({ docId: "d2", invoiceNumber: "A-2" })])).toContain("2 invoices · 1 vendor");
  });
});
