/**
 * PAN-status provider — TRACES-upload now, PaySprint drop-in later.
 * One interface; the swap is name-only and touches zero rate logic (resolveRate reads `status`,
 * never `name`). Without an upload, PANs come back UNKNOWN → resolveRate applies the statutory
 * rate and flags "unverified" (enough to lock the ₹2,086.85 anchor, which needs no names).
 */
import type { PanStatus } from "../../tds-core";

export interface PanStatusResult {
  pan: string;
  status: PanStatus;                          // drives the rate (206AA branch)
  name: string | null;                        // "name as per PAN" — workbook column only
  nameMasked: boolean;                        // TRACES → true, PaySprint → false
  validity: "VALID" | "INVALID" | "UNKNOWN";
  source: "traces-upload" | "paysprint" | "none";
}

export interface TracesRecord { pan: string; status?: string; name?: string; validity?: string }

export interface PanStatusProvider {
  source: "traces-upload" | "paysprint" | "none";
  verify(pans: string[]): Promise<Map<string, PanStatusResult>>;
}

function toStatus(s: string | undefined): PanStatus {
  if (!s) return "UNKNOWN";
  if (/inop/i.test(s)) return "INOPERATIVE";
  if (/\bop|operat|active|valid/i.test(s)) return "OPERATIVE";
  return "UNKNOWN";
}

/** Build a provider from a parsed TRACES bulk-verification export (or none). */
export function tracesUploadProvider(records?: TracesRecord[]): PanStatusProvider {
  const known = new Map<string, PanStatusResult>();
  for (const r of records ?? []) {
    const pan = (r.pan ?? "").trim().toUpperCase();
    if (!pan) continue;
    known.set(pan, {
      pan,
      status: toStatus(r.status),
      name: r.name ?? null,
      nameMasked: true,
      validity: /invalid/i.test(r.validity ?? "") ? "INVALID" : r.validity ? "VALID" : "UNKNOWN",
      source: "traces-upload",
    });
  }
  const hasData = known.size > 0;
  return {
    source: hasData ? "traces-upload" : "none",
    async verify(pans: string[]): Promise<Map<string, PanStatusResult>> {
      const out = new Map<string, PanStatusResult>();
      for (const p of pans) {
        const key = (p ?? "").trim().toUpperCase();
        if (!key) continue;
        out.set(key, known.get(key) ?? {
          pan: key, status: "UNKNOWN", name: null, nameMasked: true, validity: "UNKNOWN", source: "none",
        });
      }
      return out;
    },
  };
}
