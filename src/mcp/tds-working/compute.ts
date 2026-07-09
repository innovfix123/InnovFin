/**
 * Assemble the Section-192/392 salary register for a month: feed each register row (gross, regime) to
 * tds-core.computeSalaryTds, roll the per-employee monthly TDS into a section total, and reconcile
 * against the filed anchor. No tax math lives here — it all comes from tds-core (slabs → 87A → cess ÷12).
 *
 * The monthly challan figure is constant across FY 2026-27 (salaries are unchanged in-year), so every
 * month in-FY reproduces the filed May-2026 total of ₹25,134; the anchor is asserted on that basis.
 */
import { computeSalaryTds, type TaxRegime } from "@/tds-core";
import { REGISTER_FY, SALARY_REGISTER, selectEmployees } from "./register";
import { assertPeriod, financialYear, monthLabel, round2 } from "./util";

/** The filed Section-192 anchor — May-2026 salary challan. Never let a change slip past this. */
export const FILED_ANCHOR = {
  period: "2026-05",
  fy: REGISTER_FY,
  perEmployeeMonthlyTds: 12567,
  employees: 2,
  totalMonthlyTds: 25134,
  note: "Filed May-2026 salary challan (Section 192 / 392(1)): 2 employees @ gross ₹18,00,000, NEW regime → ₹12,567 each.",
} as const;

const SECTION = "192 / 392(1)" as const;

export interface SalaryRow {
  id: string;
  employee: string;
  regime: TaxRegime;
  grossSalary: number;
  standardDeduction: number;
  taxableIncome: number;
  incomeTax: number;   // after 87A rebate + marginal relief, BEFORE cess
  cess: number;        // 4% H&E cess
  totalTax: number;    // annual liability = incomeTax + cess
  monthlyTds: number;  // totalTax ÷ 12, rounded — the challan figure
  flags: string[];
}

export interface SalaryRegister {
  period: string;
  month: string;
  fy: string;
  section: typeof SECTION;
  rows: SalaryRow[];
  employeeCount: number;
  totalMonthlyTds: number;
  flags: string[];
}

function buildRows(employeeFilter?: string): SalaryRow[] {
  return selectEmployees(employeeFilter).map((e) => {
    const r = computeSalaryTds(e.grossAnnual, e.regime);
    return {
      id: e.id,
      employee: e.name,
      regime: r.regime,
      grossSalary: r.grossSalary,
      standardDeduction: r.standardDeduction,
      taxableIncome: r.taxableIncome,
      incomeTax: round2(r.incomeTax),
      cess: round2(r.cess),
      totalTax: round2(r.totalTax),
      monthlyTds: r.monthlyTds,
      flags: r.flags,
    };
  });
}

/** The per-employee 192 register for a month (optionally filtered to one employee). */
export function listSalary(period: string, opts?: { employee?: string }): SalaryRegister {
  assertPeriod(period);
  const fy = financialYear(period);
  const flags: string[] = [];
  if (fy !== REGISTER_FY) {
    flags.push(`period ${period} falls in FY ${fy}, outside the register's FY ${REGISTER_FY} — the encoded slabs/register may not apply`);
  }
  const rows = buildRows(opts?.employee);
  if (opts?.employee && rows.length === 0) {
    flags.push(`no register employee matched "${opts.employee}" — known: ${SALARY_REGISTER.map((e) => e.name).join(", ")}`);
  }
  const totalMonthlyTds = rows.reduce((a, r) => a + r.monthlyTds, 0);
  return {
    period, month: monthLabel(period), fy, section: SECTION,
    rows, employeeCount: rows.length, totalMonthlyTds,
    flags: [...flags, ...rows.flatMap((r) => r.flags.map((f) => `${r.employee}: ${f}`))],
  };
}

export interface SalarySummary {
  period: string;
  month: string;
  fy: string;
  section: typeof SECTION;
  employeeCount: number;
  totalMonthlyTds: number;
  byRegime: Record<string, { employees: number; monthlyTds: number }>;
  deposit: { section: "192"; form: "24Q"; monthlyTds: number; note: string };
  filedReference: typeof FILED_ANCHOR;
  regression: { ok: boolean | null; expected: number; got: number; note: string };
  flags: string[];
}

/** Section roll-up across the whole register + the filed-anchor reconciliation. */
export function salarySummary(period: string): SalarySummary {
  const reg = listSalary(period); // always the full roster for the section total
  const byRegime: Record<string, { employees: number; monthlyTds: number }> = {};
  for (const r of reg.rows) {
    const b = (byRegime[r.regime] ??= { employees: 0, monthlyTds: 0 });
    b.employees += 1;
    b.monthlyTds += r.monthlyTds;
  }

  const inFy = reg.fy === REGISTER_FY;
  const got = reg.totalMonthlyTds;
  const regression = inFy
    ? { ok: got === FILED_ANCHOR.totalMonthlyTds, expected: FILED_ANCHOR.totalMonthlyTds, got, note: "vs the filed May-2026 salary challan (₹25,134)" }
    : { ok: null as boolean | null, expected: FILED_ANCHOR.totalMonthlyTds, got, note: `period is FY ${reg.fy}; the FY 2026-27 filed anchor does not apply` };

  return {
    period: reg.period, month: reg.month, fy: reg.fy, section: reg.section,
    employeeCount: reg.employeeCount, totalMonthlyTds: got, byRegime,
    deposit: { section: "192", form: "24Q", monthlyTds: got, note: "Monthly TDS deposited by challan; salary TDS is reported quarterly in Form 24Q." },
    filedReference: FILED_ANCHOR,
    regression,
    flags: reg.flags,
  };
}
