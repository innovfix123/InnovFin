import { describe, it, expect } from "vitest";
import { resolveRate, statutoryRate, depositCode, INOPERATIVE_RATE } from "./rate";

describe("resolveRate — 194C creators (operative/inoperative branch)", () => {
  it("operative individual → 1%, no company loss, non-company head + code 1023", () => {
    const r = resolveRate({ taxable: 100000, section: "194C", pan: "ABCPE1234F", panStatus: "OPERATIVE" });
    expect(r.rateApplied).toBe(0.01);
    expect(r.tdsDeposited).toBeCloseTo(1000, 6);
    expect(r.deducteeBorne).toBeCloseTo(1000, 6);
    expect(r.companyLoss).toBeCloseTo(0, 6);
    expect(r.majorHead).toBe("0021");
    expect(r.code).toBe("1023");
  });

  it("inoperative individual → deposit 20%, deductee still bears 1%, company eats 19%", () => {
    const r = resolveRate({ taxable: 100000, section: "194C", pan: "ABCPE1234F", panStatus: "INOPERATIVE" });
    expect(r.rateApplied).toBe(INOPERATIVE_RATE);
    expect(r.tdsDeposited).toBeCloseTo(20000, 6);
    expect(r.deducteeBorne).toBeCloseTo(1000, 6);
    expect(r.companyLoss).toBeCloseTo(19000, 6);
    expect(r.inoperative).toBe(true);
  });

  it("Only Care May-2026 194C anchor: ₹2,08,685.21 → ₹2,086.85 TDS (filed)", () => {
    const r = resolveRate({ taxable: 208685.21, section: "194C", pan: "ABCPE1234F", panStatus: "OPERATIVE" });
    expect(r.tdsDeposited).toBeCloseTo(2086.85, 2);
  });

  it("no PAN → 206AA flat 20%, flagged", () => {
    const r = resolveRate({ taxable: 1000, section: "194C", pan: null, panStatus: "UNKNOWN" });
    expect(r.rateApplied).toBe(0.2);
    expect(r.flags.some((f) => f.includes("206AA"))).toBe(true);
  });
});

describe("resolveRate — 194H gateway commission (validated vs filed May lines)", () => {
  it("Cashfree – Only Care: ₹12,695.67 fee → ₹253.91, company head 0020, code 1006", () => {
    const r = resolveRate({ taxable: 12695.67, section: "194H", pan: "AAICP2912R", panStatus: "OPERATIVE" });
    expect(r.rateApplied).toBe(0.02);
    expect(r.tdsDeposited).toBeCloseTo(253.91, 2);
    expect(r.majorHead).toBe("0020");
    expect(r.code).toBe("1006");
    expect(r.companyLoss).toBeCloseTo(0, 6);
  });
  it("Razorpay – Thedal: ₹1,084.42 fee → ₹21.69", () => {
    const r = resolveRate({ taxable: 1084.42, section: "194H", pan: "AAACR1234R", panStatus: "OPERATIVE" });
    expect(r.tdsDeposited).toBeCloseTo(21.69, 2);
  });
});

describe("statutoryRate / depositCode", () => {
  it("194C is 1% individual/HUF, 2% company/firm", () => {
    expect(statutoryRate("194C", "INDIVIDUAL")).toBe(0.01);
    expect(statutoryRate("194C", "HUF")).toBe(0.01);
    expect(statutoryRate("194C", "COMPANY")).toBe(0.02);
    expect(statutoryRate("194C", "FIRM")).toBe(0.02);
  });
  it("194H is 2%", () => expect(statutoryRate("194H", "COMPANY")).toBe(0.02));
  it("only confirmed deposit codes; refuses to guess", () => {
    expect(depositCode("194C", "NON_COMPANY")).toBe("1023");
    expect(depositCode("194H", "COMPANY")).toBe("1006");
    expect(() => depositCode("194C", "COMPANY")).toThrow(/confirm with Shoyab/);
  });
});
