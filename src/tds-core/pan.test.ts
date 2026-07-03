import { describe, it, expect } from "vitest";
import { entityTypeFromPan, classifyDeductee, isValidPan, isOwnPan, OWN_PAN } from "./pan";

describe("entityTypeFromPan", () => {
  it("individual (4th char P) → non-company, valid, no flags", () => {
    const r = entityTypeFromPan("ABCPE1234F");
    expect(r).toMatchObject({ valid: true, entity: "INDIVIDUAL", deducteeClass: "NON_COMPANY" });
    expect(r.flags).toEqual([]);
  });
  it("company (4th char C) → company head — real gateway PANs", () => {
    expect(entityTypeFromPan("AAICP2912R")).toMatchObject({ valid: true, entity: "COMPANY", deducteeClass: "COMPANY" }); // Cashfree
    expect(classifyDeductee("AACCF1132H")).toBe("COMPANY"); // PhonePe
  });
  it("firm (4th char F) → non-company", () => {
    expect(entityTypeFromPan("ABCFD1234E")).toMatchObject({ entity: "FIRM", deducteeClass: "NON_COMPANY" });
  });
  it("normalises case + surrounding whitespace", () => {
    expect(entityTypeFromPan("  abcpe1234f ")).toMatchObject({ pan: "ABCPE1234F", valid: true, entity: "INDIVIDUAL" });
  });
  it("missing PAN → flagged + invalid", () => {
    const r = entityTypeFromPan(null);
    expect(r.valid).toBe(false);
    expect(r.flags).toContain("missing PAN");
  });
  it("malformed PAN → flagged + invalid", () => {
    const r = entityTypeFromPan("ABC123");
    expect(r.valid).toBe(false);
    expect(r.flags.some((f) => f.startsWith("malformed"))).toBe(true);
  });
  it("unrecognised entity code → valid format but flagged UNKNOWN", () => {
    const r = entityTypeFromPan("ABCQE1234F"); // 'Q' is not a valid entity code
    expect(r.valid).toBe(true);
    expect(r.entity).toBe("UNKNOWN");
    expect(r.flags.some((f) => f.includes("entity code"))).toBe(true);
  });
});

describe("isValidPan / isOwnPan", () => {
  it("validates format", () => {
    expect(isValidPan("ABCPE1234F")).toBe(true);
    expect(isValidPan("ABCPE1234")).toBe(false);
  });
  it("flags Innovfix's own PAN (case-insensitive), not others", () => {
    expect(isOwnPan(OWN_PAN)).toBe(true);
    expect(isOwnPan("aaici1603a")).toBe(true);
    expect(isOwnPan("AAICP2912R")).toBe(false);
  });
});
