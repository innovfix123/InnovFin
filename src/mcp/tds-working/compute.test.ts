import { describe, it, expect } from "vitest";
import { listSalary, salarySummary, FILED_ANCHOR } from "./compute";
import { SALARY_REGISTER } from "./register";

describe("listSalary — Section 192/393(1) register", () => {
  it("LOCKED: full register for May-2026 → 2 rows, ₹12,567 monthlyTds each", () => {
    const r = listSalary("2026-05");
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.regime).toBe("NEW");
      expect(row.grossSalary).toBe(1800000);
      expect(row.monthlyTds).toBe(12567);
    }
    expect(r.employeeCount).toBe(2);
    expect(r.totalMonthlyTds).toBe(25134);
    expect(r.flags).toEqual([]);
  });

  it("filters to one employee by id", () => {
    const r = listSalary("2026-05", { employee: "nandha" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].employee).toBe("Nandha");
    expect(r.totalMonthlyTds).toBe(12567);
  });

  it("filters to one employee by name substring (case-insensitive)", () => {
    const r = listSalary("2026-05", { employee: "BALA" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].employee).toBe("Bala");
  });

  it("flags an unmatched employee filter instead of silently returning nothing", () => {
    const r = listSalary("2026-05", { employee: "nobody" });
    expect(r.rows).toHaveLength(0);
    expect(r.flags.some((f) => f.includes('no register employee matched "nobody"'))).toBe(true);
  });

  it("flags a period outside the register's FY instead of silently misapplying rates", () => {
    const r = listSalary("2025-05"); // FY 2025-26, before the register's FY 2026-27
    expect(r.fy).toBe("2025-26");
    expect(r.flags.some((f) => f.includes("outside the register's FY"))).toBe(true);
  });
});

describe("salarySummary — Section 192 roll-up + filed-anchor reconciliation", () => {
  it("LOCKED: May-2026 total matches the filed salary challan (₹25,134)", () => {
    const s = salarySummary("2026-05");
    expect(s.employeeCount).toBe(2);
    expect(s.totalMonthlyTds).toBe(FILED_ANCHOR.totalMonthlyTds);
    expect(s.totalMonthlyTds).toBe(25134);
    expect(s.regression.ok).toBe(true);
    expect(s.byRegime.NEW.employees).toBe(2);
    expect(s.byRegime.NEW.monthlyTds).toBe(25134);
    expect(s.deposit.section).toBe("192");
    expect(s.deposit.form).toBe("24Q");
  });

  it("any in-FY month reproduces the same anchor (salaries are unchanged in-year)", () => {
    const s = salarySummary("2026-11");
    expect(s.regression.ok).toBe(true);
    expect(s.totalMonthlyTds).toBe(25134);
  });

  it("regression.ok is null (not false) outside the register's FY — the anchor doesn't apply there", () => {
    const s = salarySummary("2025-05");
    expect(s.regression.ok).toBeNull();
  });

  it("the register itself has exactly the two filed employees", () => {
    expect(SALARY_REGISTER.map((e) => e.name).sort()).toEqual(["Bala", "Nandha"]);
  });
});
