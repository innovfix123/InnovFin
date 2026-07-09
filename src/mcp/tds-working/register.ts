/**
 * InnovFix internal Section-192/392 salary register — the system-of-record for the assembled TDS
 * working. This is seed data held BY the TDS Working MCP, never read from any app DB (salary is not
 * app-scoped — it is InnovFix-internal, alongside the directors/freelancers registers that will live
 * here too). The tax math is not here: rows are fed employee-by-employee to tds-core.computeSalaryTds.
 *
 * Locked to the filed May-2026 salary challan: two employees on gross ₹18,00,000 under the NEW regime
 * → ₹12,567 each → ₹25,134/month total. See compute.ts (FILED_ANCHOR) and register.test.ts.
 *
 * Each row carries exactly the three inputs computeSalaryTds needs — employee, gross annual salary,
 * opted regime — so a wrong regime can never silently under/over-deduct. `pan` is recorded for the
 * register's completeness only; the 206AA no-PAN floor is not modelled for salary here (both filed
 * employees have PAN on file, on the NEW regime), so it is intentionally left off.
 */
import type { TaxRegime } from "@/tds-core";

export interface SalaryEmployee {
  /** Stable slug, used for the optional `employee` filter (also matches on display name). */
  id: string;
  name: string;
  /** Gross annual salary (pre-standard-deduction). The register may pre-net Chapter-VI-A here. */
  grossAnnual: number;
  regime: TaxRegime;
  pan?: string;
  note?: string;
}

/** The financial year the encoded rates (tds-core) and this register apply to. */
export const REGISTER_FY = "2026-27";

/**
 * The two InnovFix employees on the Section-192 register for FY 2026-27. Anchored to the filed
 * May-2026 challan (₹12,567 each). Add directors/freelancers registers alongside this later.
 */
export const SALARY_REGISTER: SalaryEmployee[] = [
  { id: "nandha", name: "Nandha", grossAnnual: 1800000, regime: "NEW" },
  { id: "bala", name: "Bala", grossAnnual: 1800000, regime: "NEW" },
];

/** Resolve an optional free-text employee filter to the matching register rows (by id or name substring). */
export function selectEmployees(query?: string): SalaryEmployee[] {
  if (!query || !query.trim()) return SALARY_REGISTER;
  const q = query.trim().toLowerCase();
  return SALARY_REGISTER.filter((e) => e.id === q || e.name.toLowerCase().includes(q));
}
