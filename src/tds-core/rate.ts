/**
 * TDS rate master + the operative/inoperative rate resolution (app-agnostic).
 *
 * Encoded exactly (from the filed workings / spec):
 *  - 194C: 1% to individual/HUF, 2% to any other entity. (Creators are individuals → 1%.)
 *  - 194H: 2% on commission/processing fee. (Gateways are companies → head 0020.)
 *  - 206AA / inoperative PAN → a flat 20% is DEPOSITED, but the deductee still bears only the
 *    statutory rate; the company absorbs the excess (`companyLoss`) + 201(1A) interest.
 *
 * Validated (see rate.test.ts): Only Care May-2026 194C anchor ₹2,086.85 on ₹2,08,685.21;
 * filed May 194H lines (Cashfree–Only Care ₹253.91, Razorpay–Thedal ₹21.69).
 * Money stays full-precision; round only for display/challan.
 */
import type { DeducteeClass, DeducteeEntity, PanStatus, Section } from "./types";
import { entityTypeFromPan } from "./pan";

/** 206AA / inoperative-PAN flat deposit rate. */
export const INOPERATIVE_RATE = 0.2;

/** Statutory rate BEFORE any 206AA/inoperative override. */
export function statutoryRate(section: Section, entity: DeducteeEntity): number {
  switch (section) {
    case "194C":
      // 1% to individual/HUF; 2% to any other entity. UNKNOWN falls through to 1% (the creator
      // default) and is always flagged upstream, so a miskeyed PAN never silently over/under-deducts.
      return entity === "COMPANY" || entity === "FIRM" || entity === "AOP" || entity === "TRUST" ||
        entity === "BOI" || entity === "LOCAL_AUTHORITY" || entity === "AJP" || entity === "GOVERNMENT"
        ? 0.02 : 0.01;
    case "194H":
      return 0.02;
    case "194J":
      return 0.1;
    default:
      throw new Error(`statutoryRate: section "${section satisfies never}" not in the rate master`);
  }
}

/** Confirmed 2025 deposit codes. Only what's confirmed is encoded — never guess a code. */
export function depositCode(section: Section, cls: DeducteeClass): string {
  if (section === "194C" && cls === "NON_COMPANY") return "1023";
  if (section === "194H") return "1006"; // gateways are companies (head 0020)
  throw new Error(`depositCode: no confirmed 2025 code for ${section}/${cls} — confirm with Shoyab, don't guess`);
}

export interface RateInput {
  taxable: number;
  section: Section;
  pan: string | null | undefined;
  /** From PaySprint/TRACES. Only this (never a name) may influence the rate. */
  panStatus: PanStatus;
}

export interface RateOutcome {
  section: Section;
  code: string;               // deposit code (challan); "?" when not in the confirmed master
  deducteeClass: DeducteeClass;
  majorHead: "0020" | "0021";
  statutory: number;          // pre-206AA rate
  rateApplied: number;        // effective DEPOSIT rate (statutory, or 0.20 when forced)
  taxable: number;
  tdsDeposited: number;       // taxable × rateApplied → what the govt receives
  deducteeBorne: number;      // taxable × statutory → withheld from the payout (creator pipeline surfaces this as `creatorBorne`)
  companyLoss: number;        // tdsDeposited − deducteeBorne (0 unless forced to 20%)
  inoperative: boolean;
  flags: string[];
}

/**
 * The operative/inoperative branch, encoded once for every app.
 * IMPORTANT: the result depends ONLY on {section, PAN-derived entity, panStatus} — never a name.
 * That is what makes the PAN-status provider a drop-in: swapping TRACES→PaySprint only improves
 * the deductee *name* downstream and cannot move a single number here.
 */
export function resolveRate(input: RateInput): RateOutcome {
  const { taxable, section, panStatus } = input;
  const info = entityTypeFromPan(input.pan);
  const flags = [...info.flags];

  const statutory = statutoryRate(section, info.entity);

  // 206AA: inoperative PAN, or no/invalid PAN → flat 20% deposited (not grossed-up into the deductee).
  const forced20 = panStatus === "INOPERATIVE" || !info.valid;
  if (panStatus === "INOPERATIVE") flags.push("PAN inoperative → 20% flat; company absorbs the excess (+ 201(1A) interest)");
  if (!info.valid) flags.push("206AA: no/invalid PAN → 20%");
  if (info.valid && panStatus === "UNKNOWN") flags.push("PAN status unverified (PaySprint/TRACES) — assumed operative");

  const rateApplied = forced20 ? INOPERATIVE_RATE : statutory;
  const tdsDeposited = taxable * rateApplied;
  const deducteeBorne = taxable * statutory;
  const companyLoss = tdsDeposited - deducteeBorne;

  let code: string;
  try { code = depositCode(section, info.deducteeClass); }
  catch (e) { code = "?"; flags.push((e as Error).message); }

  return {
    section, code,
    deducteeClass: info.deducteeClass,
    majorHead: info.deducteeClass === "COMPANY" ? "0020" : "0021",
    statutory, rateApplied, taxable,
    tdsDeposited, deducteeBorne, companyLoss,
    inoperative: panStatus === "INOPERATIVE",
    flags,
  };
}
