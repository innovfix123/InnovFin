/**
 * Section 192 salary TDS — renumbered Section 392(1) under the Income-tax Act 2025 (app-agnostic math).
 * Unlike 194C/194H (a flat rate on a taxable base, see rate.ts), salary TDS is the employee's whole
 * annual income-tax liability spread ÷12: slabs → 87A rebate → 4% H&E cess → monthly deduction.
 *
 * Encoded for FY 2026-27 (AY 2027-28):
 *  - NEW regime: ₹75,000 standard deduction; slabs below; 87A rebate up to ₹60,000 when taxable ≤ ₹12L
 *    (so salary up to ₹12.75L pays nil), with statutory marginal relief just above ₹12L.
 *  - OLD regime: ₹50,000 standard deduction; slabs below; 87A rebate up to ₹12,500 when taxable ≤ ₹5L
 *    (a hard cliff — no marginal relief in the old regime).
 *  - 4% Health & Education cess applies to salary (192/392) — it does NOT apply to 194C/194H, which is
 *    why cess lives here and not in rate.ts.
 *
 * NOT modelled (out of scope for the current register; flagged, never silently under-deducted):
 *  - Surcharge (kicks in above ₹50L taxable) — result carries a flag so it can't slip through.
 *  - Chapter-VI-A / house-property adjustments — inputs are gross salary + regime only, by design;
 *    a richer register can pre-net those into `grossSalary` before calling.
 *
 * Locked (see salary.test.ts): gross ₹18,00,000 / NEW → ₹12,567/month; two such employees → ₹25,134,
 * matching the filed May-2026 salary challan. Inputs come from the internal salary register
 * (employee, gross, regime) seeded in the TDS Working MCP — never from any app DB.
 * Money stays full-precision; only the monthly challan figure is rounded (to the nearest rupee).
 */
import type { TaxRegime } from "./types";

/** Health & Education cess on the income tax (salary/192 only, not 194C/194H). */
export const CESS_RATE = 0.04;

/** A marginal slab: `rate` applies to income between the previous slab's ceiling and `upTo`. */
interface Slab {
  upTo: number; // inclusive ceiling of this band; Infinity for the top slab
  rate: number;
}

/** NEW-regime slabs, FY 2026-27 (verified: ₹17,25,000 taxable → ₹1,45,000 income tax). */
const NEW_REGIME_SLABS: Slab[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 0.05 },
  { upTo: 1200000, rate: 0.1 },
  { upTo: 1600000, rate: 0.15 },
  { upTo: 2000000, rate: 0.2 },
  { upTo: 2400000, rate: 0.25 },
  { upTo: Infinity, rate: 0.3 },
];

/** OLD-regime slabs (unchanged basic-exemption structure), FY 2026-27. */
const OLD_REGIME_SLABS: Slab[] = [
  { upTo: 250000, rate: 0 },
  { upTo: 500000, rate: 0.05 },
  { upTo: 1000000, rate: 0.2 },
  { upTo: Infinity, rate: 0.3 },
];

interface RegimeConfig {
  standardDeduction: number;
  slabs: Slab[];
  /** 87A: rebate up to `max` when taxable ≤ `threshold`. */
  rebate: { threshold: number; max: number };
  /** Taxable income above which NEW-regime 87A marginal relief applies; null = no marginal relief (OLD). */
  marginalReliefFloor: number | null;
}

const REGIME: Record<TaxRegime, RegimeConfig> = {
  NEW: { standardDeduction: 75000, slabs: NEW_REGIME_SLABS, rebate: { threshold: 1200000, max: 60000 }, marginalReliefFloor: 1200000 },
  OLD: { standardDeduction: 50000, slabs: OLD_REGIME_SLABS, rebate: { threshold: 500000, max: 12500 }, marginalReliefFloor: null },
};

/** Progressive tax across marginal slabs. Full precision — never rounded here. */
function taxFromSlabs(taxable: number, slabs: Slab[]): number {
  let tax = 0;
  let lower = 0;
  for (const { upTo, rate } of slabs) {
    if (taxable <= lower) break;
    tax += (Math.min(taxable, upTo) - lower) * rate;
    lower = upTo;
  }
  return tax;
}

export interface SalaryTdsOutcome {
  regime: TaxRegime;
  grossSalary: number;
  standardDeduction: number;
  taxableIncome: number;
  grossTax: number;      // income tax from the slabs, BEFORE 87A rebate
  rebate87A: number;     // amount wiped by 87A (0 above the threshold)
  marginalRelief: number; // NEW-regime relief just above ₹12L (0 otherwise)
  incomeTax: number;     // after rebate + marginal relief, BEFORE cess
  cess: number;          // 4% H&E cess on incomeTax
  totalTax: number;      // annual liability = incomeTax + cess
  monthlyTds: number;    // totalTax ÷ 12, rounded to the nearest rupee → the challan figure
  flags: string[];
}

/**
 * Monthly Section-192/392 TDS for one employee, from gross annual salary + opted regime.
 * The register carries the regime per employee — it is required (never assumed), so a wrong regime
 * can never silently under/over-deduct.
 */
export function computeSalaryTds(grossSalary: number, regime: TaxRegime): SalaryTdsOutcome {
  const cfg = REGIME[regime];
  if (!cfg) throw new Error(`computeSalaryTds: unknown regime "${regime}" — expected "NEW" or "OLD"`);

  const flags: string[] = [];
  const standardDeduction = Math.min(cfg.standardDeduction, Math.max(grossSalary, 0));
  const taxableIncome = Math.max(grossSalary - standardDeduction, 0);

  const grossTax = taxFromSlabs(taxableIncome, cfg.slabs);

  // 87A: rebate wipes the tax (capped at `max`) when taxable is within the threshold.
  const rebate87A = taxableIncome <= cfg.rebate.threshold ? Math.min(grossTax, cfg.rebate.max) : 0;
  let incomeTax = grossTax - rebate87A;

  // NEW-regime marginal relief: just above ₹12L, tax cannot exceed the income earned over the floor.
  let marginalRelief = 0;
  if (cfg.marginalReliefFloor !== null && taxableIncome > cfg.marginalReliefFloor) {
    const excessOverFloor = taxableIncome - cfg.marginalReliefFloor;
    if (incomeTax > excessOverFloor) {
      marginalRelief = incomeTax - excessOverFloor;
      incomeTax = excessOverFloor;
    }
  }

  const cess = incomeTax * CESS_RATE;
  const totalTax = incomeTax + cess;
  const monthlyTds = Math.round(totalTax / 12);

  if (taxableIncome > 5000000) {
    flags.push("taxable > ₹50L: surcharge (10/15/25%) not modelled — confirm before filing");
  }

  return {
    regime, grossSalary, standardDeduction, taxableIncome,
    grossTax, rebate87A, marginalRelief, incomeTax, cess, totalTax, monthlyTds, flags,
  };
}
