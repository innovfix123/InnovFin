/**
 * PAN parsing & classification (app-agnostic).
 * 4th character → entity type; 'C' → company (challan head 0020), everyone else → non-company (0021).
 * Never throws; data-quality problems come back as `flags`, never silently swallowed.
 */
import type { DeducteeClass, DeducteeEntity } from "./types";

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** PAN 4th character → entity (income-tax PAN specification). */
const ENTITY_BY_CODE: Record<string, DeducteeEntity> = {
  P: "INDIVIDUAL", H: "HUF", C: "COMPANY", F: "FIRM", A: "AOP",
  T: "TRUST", B: "BOI", L: "LOCAL_AUTHORITY", J: "AJP", G: "GOVERNMENT",
};

export interface PanInfo {
  pan: string | null;            // normalised (trim + upper), or null if absent
  valid: boolean;                // well-formed 10-char PAN
  entity: DeducteeEntity;        // from 4th char (UNKNOWN if absent/malformed/unrecognised)
  deducteeClass: DeducteeClass;  // COMPANY iff 4th char is 'C'
  flags: string[];               // data-quality notes
}

/** Parse a PAN into entity/class + data-quality flags. */
export function entityTypeFromPan(pan: string | null | undefined): PanInfo {
  const flags: string[] = [];
  const raw = (pan ?? "").trim().toUpperCase();
  if (!raw) return { pan: null, valid: false, entity: "UNKNOWN", deducteeClass: "NON_COMPANY", flags: ["missing PAN"] };
  if (!PAN_RE.test(raw)) {
    flags.push(`malformed PAN "${raw}"`);
    return { pan: raw, valid: false, entity: "UNKNOWN", deducteeClass: "NON_COMPANY", flags };
  }
  const code = raw[3];
  const entity = ENTITY_BY_CODE[code] ?? "UNKNOWN";
  if (entity === "UNKNOWN") flags.push(`unrecognised PAN entity code "${code}"`);
  const deducteeClass: DeducteeClass = code === "C" ? "COMPANY" : "NON_COMPANY";
  return { pan: raw, valid: true, entity, deducteeClass, flags };
}

/** COMPANY (major head 0020) vs NON_COMPANY (0021). */
export function classifyDeductee(pan: string | null | undefined): DeducteeClass {
  return entityTypeFromPan(pan).deducteeClass;
}

/** Well-formed PAN? */
export function isValidPan(pan: string | null | undefined): boolean {
  return entityTypeFromPan(pan).valid;
}

/**
 * Innovfix's OWN PAN (the PAN inside GSTIN 29AAICI1603A1Z3). It leaks into gateway rows
 * (e.g. Razorpay) as a source data-entry error and must ALWAYS be flagged, never filed as a
 * deductee's PAN.
 */
export const OWN_PAN = "AAICI1603A";
export function isOwnPan(pan: string | null | undefined): boolean {
  return (pan ?? "").trim().toUpperCase() === OWN_PAN;
}
