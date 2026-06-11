/**
 * GSTR-3B engine — Innovfix monthly net-tax + cash challan.
 * Validated against the April 2026 filing (challan ₹52,52,218.18) — see gstr3b.test.ts.
 *
 * Rules encoded (from the filed workings / Master Reference):
 *  - Outward is Karnataka intra-state B2C → IGST 0, CGST = SGST.
 *  - RCM (3.1d): foreign import of services → IGST 18%; unregistered rent → CGST + SGST 9%.
 *  - RCM tax is paid in CASH (Sec 49(4)) and becomes claimable ITC the SAME month.
 *  - Rule 88A: IGST credit → IGST output first; surplus IGST credit split 50:50 to CGST & SGST;
 *    then CGST↔CGST, SGST↔SGST. The RCM cash liability is NEVER offset by ITC.
 *
 * Money math stays in full precision; round only for display/challan.
 */

export interface TaxTriplet { igst: number; cgst: number; sgst: number; }

export interface Gstr3bInput {
  period: string; // "YYYY-MM"
  /** GSTR-1 B2C outward (igst defaults to 0). */
  outward: { taxable: number; cgst: number; sgst: number; igst?: number };
  rcm: {
    /** Import of services from foreign vendors → IGST. */
    foreign: { taxable: number; igst: number };
    /** Rent from unregistered landlords → CGST + SGST. */
    rent: { taxable: number; cgst: number; sgst: number };
  };
  /** GSTR-2B Table 4(A)(5) "All other ITC". */
  itc2b: { taxable: number; igst: number; cgst: number; sgst: number };
  /** Table 4(B) reversal, usually 0. */
  itcReversed?: TaxTriplet;
  lateFee?: number;
  interest?: number;
}

const Z: TaxTriplet = { igst: 0, cgst: 0, sgst: 0 };
const add3 = (a: TaxTriplet, b: TaxTriplet): TaxTriplet => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });
const sub3 = (a: TaxTriplet, b: TaxTriplet): TaxTriplet => ({ igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst });
const sum3 = (t: TaxTriplet): number => t.igst + t.cgst + t.sgst;

export interface Gstr3bResult {
  period: string;
  table31: {
    outwardTaxable: TaxTriplet & { taxable: number };
    zeroRated: TaxTriplet & { taxable: number };
    otherOutward: TaxTriplet & { taxable: number };
    rcmLiability: TaxTriplet & { taxable: number };
    nonGst: TaxTriplet & { taxable: number };
    total: TaxTriplet & { taxable: number };
  };
  table4: {
    importGoods: TaxTriplet; importServices: TaxTriplet;
    itcRcm: TaxTriplet; isd: TaxTriplet; itcOther: TaxTriplet;
    totalAvailable: TaxTriplet; reversed: TaxTriplet; net: TaxTriplet; ineligible: TaxTriplet;
  };
  table61: Record<"igst" | "cgst" | "sgst", { liability: number; itcUsed: number; cash: number }>;
  offsetDetail: {
    igstUsedForIgst: number; igstCrossToCgst: number; igstCrossToSgst: number;
    cgstOwnUsed: number; sgstOwnUsed: number;
  };
  cashChallan: {
    rcm: TaxTriplet & { total: number };
    regular: TaxTriplet & { total: number };
    lateFee: number; interest: number;
    total: TaxTriplet & { grandTotal: number };
  };
}

export function computeGstr3b(input: Gstr3bInput): Gstr3bResult {
  const lateFee = input.lateFee ?? 0;
  const interest = input.interest ?? 0;

  // ---- Table 3.1 ----
  const outward: TaxTriplet = { igst: input.outward.igst ?? 0, cgst: input.outward.cgst, sgst: input.outward.sgst };
  const rcm: TaxTriplet = { igst: input.rcm.foreign.igst, cgst: input.rcm.rent.cgst, sgst: input.rcm.rent.sgst };
  const rcmTaxable = input.rcm.foreign.taxable + input.rcm.rent.taxable;
  const totalOutward = add3(outward, rcm);

  // ---- Table 4 — ITC ----
  const itcRcm = rcm;                                                       // 4(A)(3): RCM paid → ITC same month
  const itcOther: TaxTriplet = { igst: input.itc2b.igst, cgst: input.itc2b.cgst, sgst: input.itc2b.sgst }; // 4(A)(5)
  const totalAvailable = add3(itcRcm, itcOther);
  const reversed = input.itcReversed ?? Z;
  const netItc = sub3(totalAvailable, reversed);

  // ---- Rule 88A offset of REGULAR outward liability (RCM is cash-only, excluded) ----
  const regLiab = outward; // regular outward (igst usually 0 for B2C)
  const igstUsedForIgst = Math.min(netItc.igst, regLiab.igst);
  const surplusIgst = netItc.igst - igstUsedForIgst;

  const cgstAfterOwn = Math.max(0, regLiab.cgst - netItc.cgst);
  const sgstAfterOwn = Math.max(0, regLiab.sgst - netItc.sgst);
  let igstCrossToCgst = Math.min(surplusIgst / 2, cgstAfterOwn);
  let igstCrossToSgst = Math.min(surplusIgst / 2, sgstAfterOwn);
  // spill any unused half to the other head
  let leftover = surplusIgst - igstCrossToCgst - igstCrossToSgst;
  if (leftover > 1e-9) {
    const addC = Math.min(leftover, cgstAfterOwn - igstCrossToCgst); igstCrossToCgst += addC; leftover -= addC;
    const addS = Math.min(leftover, sgstAfterOwn - igstCrossToSgst); igstCrossToSgst += addS; leftover -= addS;
  }
  const cgstOwnUsed = Math.min(netItc.cgst, regLiab.cgst);
  const sgstOwnUsed = Math.min(netItc.sgst, regLiab.sgst);

  const regCash: TaxTriplet = {
    igst: Math.max(0, regLiab.igst - igstUsedForIgst),
    cgst: Math.max(0, regLiab.cgst - cgstOwnUsed - igstCrossToCgst),
    sgst: Math.max(0, regLiab.sgst - sgstOwnUsed - igstCrossToSgst),
  };

  // ---- Cash challan = RCM (mandatory) + regular (after ITC) ----
  const rcmCash = rcm;
  const cash = add3(rcmCash, regCash);
  const grandTotal = sum3(cash) + lateFee + interest;

  const triTaxable = (t: TaxTriplet, taxable: number) => ({ taxable, ...t });

  return {
    period: input.period,
    table31: {
      outwardTaxable: triTaxable(outward, input.outward.taxable),
      zeroRated: triTaxable(Z, 0),
      otherOutward: triTaxable(Z, 0),
      rcmLiability: triTaxable(rcm, rcmTaxable),
      nonGst: triTaxable(Z, 0),
      total: triTaxable(totalOutward, input.outward.taxable + rcmTaxable),
    },
    table4: {
      importGoods: Z, importServices: Z,
      itcRcm, isd: Z, itcOther,
      totalAvailable, reversed, net: netItc, ineligible: Z,
    },
    table61: {
      igst: { liability: totalOutward.igst, itcUsed: igstUsedForIgst, cash: rcmCash.igst + regCash.igst },
      cgst: { liability: totalOutward.cgst, itcUsed: cgstOwnUsed + igstCrossToCgst, cash: rcmCash.cgst + regCash.cgst },
      sgst: { liability: totalOutward.sgst, itcUsed: sgstOwnUsed + igstCrossToSgst, cash: rcmCash.sgst + regCash.sgst },
    },
    offsetDetail: { igstUsedForIgst, igstCrossToCgst, igstCrossToSgst, cgstOwnUsed, sgstOwnUsed },
    cashChallan: {
      rcm: { ...rcmCash, total: sum3(rcmCash) },
      regular: { ...regCash, total: sum3(regCash) },
      lateFee, interest,
      total: { ...cash, grandTotal },
    },
  };
}

export { sum3 as sumTriplet };
