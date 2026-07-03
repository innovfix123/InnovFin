/**
 * tds-core — shared, app-agnostic TDS types.
 * No I/O and no app specifics: the words "creator"/"Onlycare"/"Hima" never appear here —
 * that lives in the per-app MCPs. Every TDS app imports this so the tax math is written once.
 */

/** TDS section we file under. Extend as new sections are encoded (each needs a rate + a code). */
export type Section = "194C" | "194H" | "194J";

/** Deductee entity inferred from the PAN's 4th character (income-tax PAN specification). */
export type DeducteeEntity =
  | "INDIVIDUAL" | "HUF" | "COMPANY" | "FIRM" | "AOP" | "TRUST"
  | "BOI" | "LOCAL_AUTHORITY" | "AJP" | "GOVERNMENT" | "UNKNOWN";

/** Challan major-head axis: COMPANY (head 0020) vs everyone else (head 0021). */
export type DeducteeClass = "COMPANY" | "NON_COMPANY";

/**
 * PAN operative/inoperative — sourced from PaySprint/TRACES, NEVER the app DB.
 * The only PAN-verification output that may influence a rate (drives the 206AA 20% branch);
 * the deductee's *name* must never affect any number.
 */
export type PanStatus = "OPERATIVE" | "INOPERATIVE" | "UNKNOWN";
