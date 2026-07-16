import { describe, it, expect } from "vitest";
import type { Gstr2bResult } from "@/lib/gstr2b";
import { buildEstimate, evaluateFlags, evaluateLine, reconcileVsActual, toPurchaseInvoices } from "./compute";
import { toRegistryInvoice } from "./source";
import { readWorkbook } from "./factory";
import type { RegistryInvoice } from "./types";

/** A clean intra-state (29-Karnataka) invoice; override per test. */
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

const codes = (i: RegistryInvoice) => evaluateFlags(i).map((f) => f.code);

describe("evaluateFlags — the eligibility layer", () => {
  it("clean intra-state invoice (CGST+SGST) carries no flags → headline", () => {
    expect(evaluateFlags(inv())).toEqual([]);
    const l = evaluateLine(inv());
    expect(l.included).toBe(true);
    expect(l.itcTotal).toBe(180);
  });

  it("clean inter-state invoice (IGST) carries no flags", () => {
    expect(codes(inv({ vendorGstin: "27AAACX1234F1Z5", igst: 180, cgst: null, sgst: null }))).toEqual([]);
  });

  it("missing vendor GSTIN → NO_GSTIN", () => {
    expect(codes(inv({ vendorGstin: null }))).toContain("NO_GSTIN");
  });

  it("malformed GSTIN → INVALID_GSTIN; a 99… OIDAR registration is called out as import/RCM", () => {
    expect(codes(inv({ vendorGstin: "NOT-A-GSTIN" }))).toContain("INVALID_GSTIN");
    const flags = evaluateFlags(inv({ vendorGstin: "9924USA29003OSI" }));
    const f = flags.find((x) => x.code === "INVALID_GSTIN");
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/OIDAR|non-resident/i);
  });

  it("Innovfix's own GSTIN as vendor (the real extraction error in the registry) → OWN_GSTIN", () => {
    expect(codes(inv({ vendorGstin: "29AAICI1603A1Z3" }))).toContain("OWN_GSTIN");
  });

  it("billed to someone else's GSTIN → BUYER_MISMATCH; billed to our own → clean", () => {
    expect(codes(inv({ buyerGstin: "27AAACR5055K1Z7" }))).toContain("BUYER_MISMATCH");
    expect(codes(inv({ buyerGstin: "29AAICI1603A1Z3" }))).toEqual([]);
  });

  it("foreign-currency invoice → FOREIGN_CURRENCY (import of service, RCM — never in 2B B2B)", () => {
    const c = codes(inv({ currency: "USD", cgst: null, sgst: null, total: 100 }));
    expect(c).toContain("FOREIGN_CURRENCY");
    expect(c).toContain("NO_TAX_BREAKUP"); // no heads extracted either
  });

  it("no CGST/SGST/IGST extracted → NO_TAX_BREAKUP (nothing to count yet)", () => {
    expect(codes(inv({ cgst: null, sgst: null }))).toContain("NO_TAX_BREAKUP");
  });

  it("charged heads must fit the vendor state: inter-state CGST/SGST and intra-state IGST → HEAD_MISMATCH", () => {
    expect(codes(inv({ vendorGstin: "27AAACX1234F1Z5" }))).toContain("HEAD_MISMATCH"); // 27 charging CGST/SGST
    expect(codes(inv({ igst: 50 }))).toContain("HEAD_MISMATCH");                        // 29 charging IGST too
  });

  it("17(5) blocked-credit suspects route to review — by SAC prefix and by vendor-name keyword", () => {
    expect(codes(inv({ hsnSac: "996331" }))).toContain("BLOCKED_17_5");                 // catering SAC
    expect(codes(inv({ vendorName: "Sky Catering Services" }))).toContain("BLOCKED_17_5");
  });

  it("RCM-notified suspects route to review — by SAC prefix and by vendor-name keyword", () => {
    expect(codes(inv({ hsnSac: "996511" }))).toContain("RCM_SUSPECT");                  // GTA SAC
    expect(codes(inv({ vendorName: "Mahaveer Logistics Pvt Ltd" }))).toContain("RCM_SUSPECT");
  });
});

describe("buildEstimate — bucketing + aggregation", () => {
  it("aggregates headline ITC by head and by vendor GSTIN; review bucket stays out of the headline", () => {
    const rows = [
      inv({ docId: "a1", invoiceNumber: "A-1", cgst: 90, sgst: 90 }),
      inv({ docId: "a2", invoiceNumber: "A-2", cgst: 10.05, sgst: 10.05, taxableValue: 111.67, total: 131.77 }),
      inv({ docId: "b1", invoiceNumber: "B-1", vendorGstin: "27AAACX1234F1Z5", igst: 180, cgst: null, sgst: null }),
      inv({ docId: "r1", invoiceNumber: "R-1", vendorGstin: null, cgst: 900, sgst: 900 }), // review: NO_GSTIN
    ];
    const { estimate } = buildEstimate(rows, { period: "2026-06" });

    expect(estimate.estimate.invoices).toBe(3);
    expect(estimate.estimate.vendors).toBe(2);
    expect(estimate.estimate.itc).toEqual({ igst: 180, cgst: 100.05, sgst: 100.05, cess: 0 });
    expect(estimate.estimate.itcTotal).toBe(380.1);
    expect(estimate.estimate.taxable).toBe(2111.67);

    const acme = estimate.estimate.byVendor.find((v) => v.gstin === "29AAACX1234F1Z5");
    expect(acme).toMatchObject({ invoices: 2, itcTotal: 200.1 });

    expect(estimate.underReview.invoices).toBe(1);
    expect(estimate.underReview.potentialItcTotal).toBe(1800);
    expect(estimate.underReview.byFlag.NO_GSTIN).toBe(1);
    // the flagged ₹1800 must NOT leak into the headline
    expect(estimate.estimate.itcTotal + estimate.underReview.potentialItcTotal).toBe(2180.1);
  });

  it("buckets by invoice date: other months are excluded, undated rows go to review as NO_DATE", () => {
    const rows = [
      inv({ docId: "in", invoiceNumber: "I-1" }),
      inv({ docId: "old", invoiceNumber: "O-1", invoiceDate: "2026-05-31" }),
      inv({ docId: "nd", invoiceNumber: "N-1", invoiceDate: null }),
    ];
    const { estimate, lines } = buildEstimate(rows, { period: "2026-06" });
    expect(estimate.registry).toMatchObject({ acceptedFetched: 3, inPeriod: 1, undated: 1, outOfPeriod: 1 });
    expect(lines).toHaveLength(2); // the May invoice is not part of this period's lines at all
    const nd = lines.find((l) => l.docId === "nd")!;
    expect(nd.included).toBe(false);
    expect(nd.flags.map((f) => f.code)).toContain("NO_DATE");
  });

  it("labels the output as an ESTIMATE and surfaces received_to + pending needs_review as caveats", () => {
    const { estimate } = buildEstimate([inv()], {
      period: "2026-06",
      receivedTo: "2026-07-03",
      needsReviewPending: { count: 4, totalInclGst: 12345.5 },
    });
    expect(estimate.basis).toMatch(/^ESTIMATE/);
    expect(estimate.eligibilityNote).toMatch(/pending Shoyab/i);
    expect(estimate.receivedTo).toBe("2026-07-03");
    expect(estimate.caveats.join(" ")).toMatch(/on or before 2026-07-03/);
    expect(estimate.caveats.join(" ")).toMatch(/4 invoice/);
  });
});

describe("toPurchaseInvoices — the bridge into gst-core's matcher", () => {
  it("maps matchable lines and reports why the rest can't join the GSTIN+number match", () => {
    const lines = [
      evaluateLine(inv()),
      evaluateLine(inv({ docId: "x1", vendorGstin: null })),
      evaluateLine(inv({ docId: "x2", invoiceNumber: null })),
    ];
    const { books, excluded } = toPurchaseInvoices(lines);
    expect(books).toEqual([{ gstin: "29AAACX1234F1Z5", invoiceNo: "INV-001", taxable: 1000, igst: 0, cgst: 90, sgst: 90 }]);
    expect(excluded.map((e) => e.reason)).toEqual(["no vendor GSTIN", "no invoice number"]);
  });
});

describe("reconcileVsActual — estimate vs the parsed portal 2B", () => {
  const twoB: Gstr2bResult = {
    itcAvailable: { igst: 180, cgst: 90, sgst: 90, taxable: 2000 },
    itcReversed: { igst: 0, cgst: 0, sgst: 0 },
    itcIneligible: { igst: 0, cgst: 0, sgst: 0 },
    invoices: [
      { gstin: "29AAACX1234F1Z5", invoiceNo: "INV-001", taxable: 1000, igst: 0, cgst: 90, sgst: 90 }, // matches, equal
      { gstin: "27AAACR5055K1Z7", invoiceNo: "Z-9", taxable: 1000, igst: 180, cgst: 0, sgst: 0 },     // only in 2B
    ],
  };

  it("splits the invoice match into matched / chase-the-supplier / book-it and diffs the 4(A)(5) heads", () => {
    const rows = [
      inv(), // in both, equal tax
      inv({ docId: "m2", invoiceNumber: "M-2", vendorGstin: "27AAACX1234F1Z5", igst: 500, cgst: null, sgst: null }), // in hand only
      inv({ docId: "ng", invoiceNumber: "N-G", vendorGstin: null }), // can't join the match
    ];
    const { lines } = buildEstimate(rows, { period: "2026-06" });
    const r = reconcileVsActual(lines, twoB, { period: "2026-06" });

    expect(r.invoiceMatch.matched).toBe(1);
    expect(r.invoiceMatch.matchedWithTaxDiff).toEqual([]);
    expect(r.invoiceMatch.inBooksNotIn2b.map((i) => i.invoiceNo)).toEqual(["M-2"]);
    expect(r.invoiceMatch.in2bNotInBooks.map((i) => i.invoiceNo)).toEqual(["Z-9"]);
    expect(r.invoiceMatch.ok).toBe(false);
    expect(r.excludedFromMatch.map((e) => e.docId)).toEqual(["ng"]);

    // headline: estimate (clean lines: INV-001 90/90 + M-2 igst 500) vs 2B 4(A)(5)
    expect(r.headline.estimate).toMatchObject({ igst: 500, cgst: 90, sgst: 90, invoices: 2 });
    expect(r.headline.actual2b).toMatchObject({ igst: 180, cgst: 90, sgst: 90, invoices: 2 });
    expect(r.headline.diff).toEqual({ igst: -320, cgst: 0, sgst: 0, total: -320 });
    expect(r.headline.ok).toBe(false);
    expect(r.basis).toMatch(/ACTUAL/);
  });

  it("a matched invoice whose supplier filed different tax shows up in matchedWithTaxDiff", () => {
    const { lines } = buildEstimate([inv({ cgst: 80, sgst: 80 })], { period: "2026-06" });
    const r = reconcileVsActual(lines, twoB, { period: "2026-06" });
    expect(r.invoiceMatch.matched).toBe(1);
    expect(r.invoiceMatch.matchedWithTaxDiff).toEqual([{ key: "29AAACX1234F1Z5|INV-001", taxDiff: 20 }]);
  });

  it("review-bucket lines still join the identity match (flags gate the claim, not 2B presence)", () => {
    // catering vendor → BLOCKED_17_5 review, but the supplier filed it — it must still match
    const { lines } = buildEstimate([inv({ vendorName: "Sky Catering Services" })], { period: "2026-06" });
    const r = reconcileVsActual(lines, twoB, { period: "2026-06" });
    expect(lines[0].included).toBe(false);
    expect(r.invoiceMatch.matched).toBe(1);
    expect(r.headline.estimate.invoices).toBe(0);            // not in the clean headline…
    expect(r.headline.estimateWithReview.invoices).toBe(1);  // …but in the upper bound
    expect(r.headline.estimateWithReview.cgst).toBe(90);
  });
});

describe("source mapping + workbook guard", () => {
  it("maps a canonical registry document (plain-value fields) into RegistryInvoice", () => {
    const doc = {
      doc_id: "abc",
      fields: {
        vendor_name: "Acme", vendor_gstin: "29AAACX1234F1Z5", invoice_number: "A-9",
        invoice_date: "2026-06-01", taxable_value: "1000", cgst: 90, sgst: 90, total: 1180,
        hsn_sac: 998313, currency: "INR",
      },
      source: { sender: "a@b.c", received_date: "2026-06-02" },
    };
    expect(toRegistryInvoice(doc)).toMatchObject({
      docId: "abc", vendorGstin: "29AAACX1234F1Z5", invoiceNumber: "A-9",
      taxableValue: 1000, cgst: 90, sgst: 90, igst: null, cess: null,
      hsnSac: "998313", receivedDate: "2026-06-02",
    });
  });

  it("readWorkbook only accepts paths inside the GSTR-2B-est-mcp drop folder", () => {
    expect(() => readWorkbook("src/lib/auth.ts")).toThrow(/drop folder/);
    expect(() => readWorkbook("/etc/passwd")).toThrow(/drop folder/);
    expect(() => readWorkbook("GSTR-2B-est-mcp/../.env")).toThrow(/drop folder/);
    expect(() => readWorkbook(undefined, undefined)).toThrow(/exactly one/);
    expect(() => readWorkbook("a", "b")).toThrow(/exactly one/);
    expect(readWorkbook(undefined, Buffer.from("hi").toString("base64")).toString()).toBe("hi");
  });
});
