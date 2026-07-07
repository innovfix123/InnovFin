import { describe, it, expect } from "vitest";
import { computeSalaryTds, CESS_RATE } from "./salary";

describe("computeSalaryTds — NEW regime, FY 2026-27 (Section 192 / 392(1))", () => {
  it("LOCKED: gross ₹18,00,000 → ₹12,567/month (filed May-2026 salary challan)", () => {
    const r = computeSalaryTds(1800000, "NEW");
    expect(r.standardDeduction).toBe(75000);
    expect(r.taxableIncome).toBe(1725000);
    expect(r.grossTax).toBeCloseTo(145000, 6); // verified slab total
    expect(r.rebate87A).toBe(0);               // taxable > ₹12L → no 87A
    expect(r.cess).toBeCloseTo(5800, 6);       // 4% H&E cess
    expect(r.totalTax).toBeCloseTo(150800, 6);
    expect(r.monthlyTds).toBe(12567);
  });

  it("LOCKED: two employees on ₹18,00,000 NEW → ₹25,134/month total", () => {
    const perEmployee = computeSalaryTds(1800000, "NEW").monthlyTds;
    expect(perEmployee * 2).toBe(25134);
  });

  it("87A wipes tax at the ₹12L taxable ceiling (gross ₹12.75L → nil TDS)", () => {
    const r = computeSalaryTds(1275000, "NEW"); // taxable 12,00,000
    expect(r.taxableIncome).toBe(1200000);
    expect(r.grossTax).toBeCloseTo(60000, 6);
    expect(r.rebate87A).toBeCloseTo(60000, 6);
    expect(r.monthlyTds).toBe(0);
  });

  it("marginal relief just above ₹12L: tax capped at the excess over the floor", () => {
    const r = computeSalaryTds(1285000, "NEW"); // taxable 12,10,000
    expect(r.grossTax).toBeCloseTo(61500, 6);       // 60,000 + 15% × 10,000
    expect(r.marginalRelief).toBeCloseTo(51500, 6); // relieved down to the ₹10,000 excess
    expect(r.incomeTax).toBeCloseTo(10000, 6);
    expect(r.totalTax).toBeCloseTo(10400, 6);       // + 4% cess
  });

  it("flags surcharge territory rather than silently under-deducting (> ₹50L taxable)", () => {
    const r = computeSalaryTds(6000000, "NEW");
    expect(r.flags.some((f) => f.includes("surcharge"))).toBe(true);
  });
});

describe("computeSalaryTds — OLD regime, FY 2026-27", () => {
  it("₹50,000 standard deduction and old slabs", () => {
    const r = computeSalaryTds(1800000, "OLD"); // taxable 17,50,000
    expect(r.standardDeduction).toBe(50000);
    expect(r.taxableIncome).toBe(1750000);
    // 5% (2.5–5L) + 20% (5–10L) + 30% (10–17.5L) = 12,500 + 1,00,000 + 2,25,000
    expect(r.grossTax).toBeCloseTo(337500, 6);
    expect(r.cess).toBeCloseTo(337500 * CESS_RATE, 6);
    expect(r.rebate87A).toBe(0);
  });

  it("87A rebate up to ₹12,500 when taxable ≤ ₹5L (hard cliff, no marginal relief)", () => {
    const r = computeSalaryTds(550000, "OLD"); // taxable 5,00,000
    expect(r.taxableIncome).toBe(500000);
    expect(r.grossTax).toBeCloseTo(12500, 6);
    expect(r.rebate87A).toBeCloseTo(12500, 6);
    expect(r.marginalRelief).toBe(0);
    expect(r.monthlyTds).toBe(0);
  });
});
