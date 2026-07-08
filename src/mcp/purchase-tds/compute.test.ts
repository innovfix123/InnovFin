import { describe, it, expect } from "vitest";
import { computeLine, computePurchaseTds, classifyInvoice } from "./index";
import type { PurchaseInvoice } from "./types";

function inv(over: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    invoiceNumber: "INV-1", vendorName: null, vendorGstin: null, hsnSac: null,
    taxableValue: 100000, total: 118000, invoiceDate: "2026-06-15", description: null, ...over,
  };
}

describe("purchase-tds — vendor override (spec §5)", () => {
  it("Zocket ad-spend (SAC 998361) → 194C, COMPANY 2%, head 0020, code 1024 (⚠)", () => {
    const l = computeLine(inv({ vendorGstin: "29AABCZ7555P1Z5", vendorName: "Zocket", hsnSac: "998361", taxableValue: 100000 }));
    expect(l.section).toBe("194C");
    expect(l.entityType).toBe("COMPANY");
    expect(l.rate).toBe(0.02);
    expect(l.majorHead).toBe("0020");
    expect(l.tds).toBeCloseTo(2000, 2);
    expect(l.newCode).toBe("1024");
    expect(l.classificationBasis).toBe("vendor-override");
    expect(l.flags.some((f) => f.includes("1024") && f.includes("UNCONFIRMED"))).toBe(true);
  });

  it("Zocket ads via keyword ('Meta Ads', no SAC) → 194C", () => {
    const l = computeLine(inv({ vendorGstin: "29AABCZ7555P1Z5", vendorName: "Zocket", description: "Meta Ads campaign June", hsnSac: null }));
    expect(l.section).toBe("194C");
  });

  it("Zocket subscription (keyword) → 194J(a) 2%", () => {
    const l = computeLine(inv({ vendorGstin: "29AABCZ7555P1Z5", vendorName: "Zocket", description: "Monthly subscription charges", hsnSac: null }));
    expect(l.section).toBe("194J(a)");
    expect(l.rate).toBe(0.02);
  });

  it("Zocket with no SAC/keyword → review (vendor spans sections)", () => {
    const c = classifyInvoice(inv({ vendorGstin: "29AABCZ7555P1Z5", vendorName: "Zocket", description: "invoice", hsnSac: null }));
    expect(c.section).toBeNull();
    expect(c.needsReview).toBe(true);
    expect(c.flags.some((f) => f.includes("spans sections"))).toBe(true);
  });

  it("Paysprint → 194J(a) 2%, COMPANY head 0020", () => {
    const l = computeLine(inv({ vendorGstin: "29AALCP6782E1Z5", vendorName: "Paysprint", taxableValue: 50000 }));
    expect(l.section).toBe("194J(a)");
    expect(l.rate).toBe(0.02);
    expect(l.majorHead).toBe("0020");
    expect(l.tds).toBeCloseTo(1000, 2);
  });

  it("CFO Angle → 194J(b) 10%, FIRM head 0021", () => {
    const l = computeLine(inv({ vendorGstin: "29AANFC0897L1Z5", vendorName: "CFO Angle", taxableValue: 100000 }));
    expect(l.section).toBe("194J(b)");
    expect(l.entityType).toBe("FIRM");
    expect(l.rate).toBe(0.1);
    expect(l.majorHead).toBe("0021");
    expect(l.tds).toBeCloseTo(10000, 2);
  });
});

describe("purchase-tds — SAC map (spec §2)", () => {
  it("99836 → 194C (advertising)", () => expect(classifyInvoice(inv({ hsnSac: "99836" })).section).toBe("194C"));
  it("9982 → 194J(b) (professional)", () => expect(classifyInvoice(inv({ hsnSac: "9982" })).section).toBe("194J(b)"));
  it("998599 → 194C (contract, 9985)", () => expect(classifyInvoice(inv({ hsnSac: "998599" })).section).toBe("194C"));
  it("998313 → 194J(a) (IT technical)", () => expect(classifyInvoice(inv({ hsnSac: "998313" })).section).toBe("194J(a)"));
  it("bare 9983 range → 194J(a) but flagged ambiguous → review", () => {
    const c = classifyInvoice(inv({ hsnSac: "998319" }));
    expect(c.section).toBe("194J(a)");
    expect(c.needsReview).toBe(true);
  });
  it("non-99 code (HSN goods) → NONE, no TDS", () => {
    const l = computeLine(inv({ hsnSac: "8471", taxableValue: 100000 }));
    expect(l.section).toBe("NONE");
    expect(l.tds).toBe(0);
  });
});

describe("purchase-tds — 194C rate split via tds-core (spec §4)", () => {
  it("individual contractor (PAN 4th 'P') → 194C 1%, head 0021, code 1023 (confirmed, no ⚠)", () => {
    const l = computeLine(inv({ vendorGstin: "29ABCPE1234F1Z5", hsnSac: "9985", taxableValue: 100000 }));
    expect(l.section).toBe("194C");
    expect(l.entityType).toBe("INDIVIDUAL");
    expect(l.rate).toBe(0.01);
    expect(l.majorHead).toBe("0021");
    expect(l.newCode).toBe("1023");
    expect(l.tds).toBeCloseTo(1000, 2);
    expect(l.flags.some((f) => f.includes("UNCONFIRMED"))).toBe(false);
  });
});

describe("purchase-tds — data-quality guards (spec §4)", () => {
  it("vendor PAN == Innovfix own PAN → flag + review", () => {
    const l = computeLine(inv({ vendorGstin: "29AAICI1603A1Z3", vendorName: "Scholiverse", hsnSac: "9982" }));
    expect(l.needsReview).toBe(true);
    expect(l.flags.some((f) => f.includes("OWN PAN"))).toBe(true);
  });
  it("malformed GSTIN → PAN null, review", () => {
    const l = computeLine(inv({ vendorGstin: "BADGSTIN", hsnSac: "9982" }));
    expect(l.deducteePan).toBeNull();
    expect(l.needsReview).toBe(true);
  });
  it("no taxable value → tds null, review", () => {
    const l = computeLine(inv({ vendorGstin: "29AALCP6782E1Z5", vendorName: "Paysprint", taxableValue: null }));
    expect(l.tds).toBeNull();
    expect(l.needsReview).toBe(true);
  });
  it("no SAC / override / keyword → review, unclassified", () => {
    const c = classifyInvoice(inv({ vendorGstin: "29ABCPE1234F1Z5", description: "misc", hsnSac: null }));
    expect(c.section).toBeNull();
    expect(c.needsReview).toBe(true);
  });
});

describe("purchase-tds — thresholds (spec §6)", () => {
  it("single ₹20k 194J invoice < ₹30k annual → belowThreshold, no deduction yet", () => {
    const [l] = computePurchaseTds([inv({ vendorGstin: "29AALCP6782E1Z5", vendorName: "Paysprint", taxableValue: 20000 })]);
    expect(l.section).toBe("194J(a)");
    expect(l.belowThreshold).toBe(true);
    expect(l.flags.some((f) => f.includes("below") && f.includes("threshold"))).toBe(true);
  });
  it("two ₹20k invoices same vendor (FY aggregate ₹40k > ₹30k) → deductible", () => {
    const ls = computePurchaseTds([
      inv({ vendorGstin: "29AALCP6782E1Z5", vendorName: "Paysprint", taxableValue: 20000, invoiceDate: "2026-06-01" }),
      inv({ vendorGstin: "29AALCP6782E1Z5", vendorName: "Paysprint", taxableValue: 20000, invoiceDate: "2026-08-01" }),
    ]);
    expect(ls.every((l) => l.belowThreshold === false)).toBe(true);
  });
});
