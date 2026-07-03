import { describe, it, expect } from "vitest";
import { interest201_1A, monthsOrPart, RATE_NOT_DEDUCTED, RATE_NOT_DEPOSITED } from "./interest";

describe("interest201_1A", () => {
  it("1.5%/month default (deducted-not-deposited)", () => {
    expect(interest201_1A(1000, 3)).toBeCloseTo(45, 6);
  });
  it("1%/month for non-deduction", () => {
    expect(interest201_1A(1000, 3, RATE_NOT_DEDUCTED)).toBeCloseTo(30, 6);
  });
  it("part-month rounds up", () => {
    expect(interest201_1A(1000, 2.1)).toBeCloseTo(1000 * RATE_NOT_DEPOSITED * 3, 6);
  });
  it("zero for no delay / no amount", () => {
    expect(interest201_1A(1000, 0)).toBe(0);
    expect(interest201_1A(0, 5)).toBe(0);
  });
});

describe("monthsOrPart — calendar-month convention", () => {
  it("same month → 1", () => {
    expect(monthsOrPart(new Date(2026, 5, 7), new Date(2026, 5, 20))).toBe(1);
  });
  it("one day past a month-end → 2 (the gotcha)", () => {
    expect(monthsOrPart(new Date(2026, 5, 30), new Date(2026, 6, 8))).toBe(2);
  });
  it("to ≤ from → 0", () => {
    expect(monthsOrPart(new Date(2026, 5, 7), new Date(2026, 5, 7))).toBe(0);
  });
});
