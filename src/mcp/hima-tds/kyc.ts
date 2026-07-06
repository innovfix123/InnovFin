/**
 * Hima app-side KYC / verification signals (read-only). Answers "can we pay this creator?" —
 * PAN captured & PaySprint-checked, bank account penny-drop verified — plus a shared-PAN
 * data-quality flag. Sourced live from himaapp through the SELECT-only `tdsapp_ro` login:
 *   - kyc_verifications_v : one row per PaySprint verification event, split by verification_type
 *     ('pan_verification' | 'bank_verification'), status 'success'|'failure', reason on failures,
 *     plus the creator's pan + app pan_status carried on the row.
 *
 * This ONE view replaces Only Care's three tables (pay_sprint / kyc_documents / bank_accounts):
 * Hima logs both the PAN check and the bank penny-drop in the same table, keyed by verification_type.
 * (Perumal deliberately withheld the raw account numbers / IFSC / holder names — bank_verification_logs,
 * despite the name, is a payout-webhook/reversal log, not a KYC table — so we only ever see the
 * verified STATUS + PAN here.)
 *
 * Shape notes locked against the live view (verified read-only 2026-07-06):
 *   - pan_verification is only ever logged on SUCCESS (no failure rows) → absence of a
 *     pan_verification success = "never successfully PAN-verified" (not "failed").
 *   - bank_verification logs BOTH success and failure; failure `reason` is a QA hint
 *     ("Invalid IFSC code", "Name does not match PAN card", "24 hour cooldown active", …).
 *   - pan_status (VALID/INVALID/NULL) is the app KYC flag, per-row and mostly NULL — we surface the
 *     latest known non-null value per creator.
 *
 * COMPLIANCE BOUNDARY: this is app-onboarding verification, NOT the TDS-rate PAN status. It must
 * NEVER feed the 206AA operative/inoperative rate branch — that stays sourced from TRACES/PaySprint
 * *compliance* status (see pan-provider.ts, tds-core). A PaySprint pan_verification 'success' only
 * confirms the PAN exists and the name matches; it does not return operative/inoperative. These
 * flags are reference / QA only.
 */
import { getHimaConnection } from "./db";

export interface HimaKycRow {
  creatorId: string;                  // kyc_verifications_v.creator_id
  pan: string | null;                 // latest PAN seen for the creator (pan_verification wins)
  panStatus: string | null;           // app KYC flag VALID/INVALID/null — NOT TRACES, never feeds the rate
  panVerified: boolean;               // has a pan_verification 'success' row
  panChecks: number;                  // count of pan_verification rows
  panLastAt: string | null;           // 'YYYY-MM-DD HH:MM:SS' (IST) of the last PAN check
  bankVerified: boolean;              // has a bank_verification 'success' row (penny-drop passed)
  bankChecks: number;                 // count of bank_verification rows (success + failure)
  bankFailures: number;               // count of bank_verification 'failure' rows
  bankLastAt: string | null;          // 'YYYY-MM-DD HH:MM:SS' (IST) of the last bank check (any status)
  lastBankFailureReason: string | null; // reason on the most recent bank failure (QA hint)
  panSharedByCreators: number;        // distinct creators sharing this PAN (>1 ⇒ data-quality flag)
  fullyVerified: boolean;             // pan present AND panVerified AND bankVerified
  flags: string[];                    // human-readable data-quality flags (empty = clean)
}

export interface KycLookup {
  creatorIds?: string[];
  pans?: string[];
}

// One row per verification event → aggregate per creator. GROUP_CONCAT(... ORDER BY ...) picks the
// "best" single value (we only ever read element 1 via SUBSTRING_INDEX, so the default 1024-byte
// group_concat_max_len never truncates it); NULLs are skipped by GROUP_CONCAT, so `pan`/`panStatus`
// resolve to the latest non-null, and `lastBankFailureReason` ignores success rows automatically.
// 0x1f (ASCII unit separator) can't occur inside a PAN / reason, so it's a safe join delimiter.
const BASE_SELECT = `
SELECT
  k.creator_id AS creatorId,
  SUBSTRING_INDEX(GROUP_CONCAT(k.pan
    ORDER BY (k.verification_type = 'pan_verification') DESC, k.datetime DESC SEPARATOR 0x1f), 0x1f, 1) AS pan,
  SUBSTRING_INDEX(GROUP_CONCAT(k.pan_status
    ORDER BY k.datetime DESC SEPARATOR 0x1f), 0x1f, 1) AS panStatus,
  SUM(k.verification_type = 'pan_verification') AS panChecks,
  MAX(k.verification_type = 'pan_verification' AND k.status = 'success') AS panVerified,
  DATE_FORMAT(MAX(CASE WHEN k.verification_type = 'pan_verification' THEN k.datetime END), '%Y-%m-%d %H:%i:%s') AS panLastAt,
  SUM(k.verification_type = 'bank_verification') AS bankChecks,
  SUM(k.verification_type = 'bank_verification' AND k.status <> 'success') AS bankFailures,
  MAX(k.verification_type = 'bank_verification' AND k.status = 'success') AS bankVerified,
  DATE_FORMAT(MAX(CASE WHEN k.verification_type = 'bank_verification' THEN k.datetime END), '%Y-%m-%d %H:%i:%s') AS bankLastAt,
  SUBSTRING_INDEX(GROUP_CONCAT(
    CASE WHEN k.verification_type = 'bank_verification' AND k.status <> 'success' THEN k.reason END
    ORDER BY k.datetime DESC SEPARATOR 0x1f), 0x1f, 1) AS lastBankFailureReason
FROM kyc_verifications_v k`;

/** Look up app-side verification status for a set of Hima creators (by creator_id and/or PAN). */
export async function fetchHimaKyc(lookup: KycLookup): Promise<HimaKycRow[]> {
  const creatorIds = (lookup.creatorIds ?? []).map((s) => String(s).trim()).filter(Boolean);
  const pans = (lookup.pans ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (!creatorIds.length && !pans.length) return [];

  const where: string[] = [];
  const params: unknown[] = [];
  if (creatorIds.length) {
    where.push("k.creator_id IN (?)");
    params.push(creatorIds);
  }
  if (pans.length) {
    // Resolve PANs → creator_ids so we still aggregate ALL of that creator's rows (incl. null-pan ones).
    where.push("k.creator_id IN (SELECT creator_id FROM kyc_verifications_v WHERE pan IN (?))");
    params.push(pans);
  }
  const sql = `${BASE_SELECT}\nWHERE ${where.join(" OR ")}\nGROUP BY k.creator_id\nORDER BY k.creator_id`;

  const conn = await getHimaConnection();
  try {
    const [rows] = await conn.query(sql, params);
    const base = (rows as Record<string, unknown>[]).map(toRow);
    await attachSharedPanCounts(conn, base);
    return base;
  } finally {
    await conn.end();
  }
}

/** Fill panSharedByCreators for the resolved rows in one grouped query over the whole view. */
async function attachSharedPanCounts(
  conn: import("mysql2/promise").Connection,
  rows: HimaKycRow[],
): Promise<void> {
  const pans = [...new Set(rows.map((r) => r.pan).filter((p): p is string => Boolean(p)))];
  if (!pans.length) return;
  const [shared] = await conn.query(
    "SELECT pan, COUNT(DISTINCT creator_id) c FROM kyc_verifications_v WHERE pan IN (?) GROUP BY pan",
    [pans],
  );
  const byPan = new Map(
    (shared as Record<string, unknown>[]).map((r) => [String(r.pan), Number(r.c ?? 0)]),
  );
  for (const r of rows) {
    if (!r.pan) continue;
    r.panSharedByCreators = byPan.get(r.pan) ?? 1;
    if (r.panSharedByCreators > 1) {
      r.flags.push(`PAN shared by ${r.panSharedByCreators} creators — reconcile before filing`);
    }
  }
}

function toRow(r: Record<string, unknown>): HimaKycRow {
  const pan = r.pan == null ? null : String(r.pan);
  const panStatus = r.panStatus == null ? null : String(r.panStatus);
  const panChecks = Number(r.panChecks ?? 0);
  const panVerified = Number(r.panVerified ?? 0) === 1;
  const bankChecks = Number(r.bankChecks ?? 0);
  const bankFailures = Number(r.bankFailures ?? 0);
  const bankVerified = Number(r.bankVerified ?? 0) === 1;
  const lastBankFailureReason = r.lastBankFailureReason == null ? null : String(r.lastBankFailureReason);
  const fullyVerified = Boolean(pan) && panVerified && bankVerified;

  // panSharedByCreators + its flag are filled later by attachSharedPanCounts (needs a 2nd query).
  const flags: string[] = [];
  if (!pan) flags.push("No PAN on file");
  if (!panVerified) flags.push("PAN not verified in-app (no successful PaySprint PAN check)");
  if (!bankVerified) {
    flags.push(
      bankFailures > 0 && lastBankFailureReason
        ? `Bank not verified — last penny-drop failed: "${lastBankFailureReason}"`
        : "Bank not verified (no successful penny-drop)",
    );
  }
  if (panStatus === "INVALID") flags.push("App PAN status is INVALID");

  return {
    creatorId: String(r.creatorId),
    pan,
    panStatus,
    panVerified,
    panChecks,
    panLastAt: r.panLastAt == null ? null : String(r.panLastAt),
    bankVerified,
    bankChecks,
    bankFailures,
    bankLastAt: r.bankLastAt == null ? null : String(r.bankLastAt),
    lastBankFailureReason,
    panSharedByCreators: pan ? 1 : 0,
    fullyVerified,
    flags,
  };
}

/** Creator-level roll-up over a set of KYC rows (for tool summaries). */
export function summariseHimaKyc(rows: HimaKycRow[]): {
  creators: number; fullyVerified: number; panVerified: number; bankVerified: number;
  panUnverified: number; bankUnverified: number; noPan: number; invalidPan: number;
  sharedPan: number; flagged: number;
} {
  return {
    creators: rows.length,
    fullyVerified: rows.filter((r) => r.fullyVerified).length,
    panVerified: rows.filter((r) => r.panVerified).length,
    bankVerified: rows.filter((r) => r.bankVerified).length,
    panUnverified: rows.filter((r) => !r.panVerified).length,
    bankUnverified: rows.filter((r) => !r.bankVerified).length,
    noPan: rows.filter((r) => !r.pan).length,
    invalidPan: rows.filter((r) => r.panStatus === "INVALID").length,
    sharedPan: rows.filter((r) => r.panSharedByCreators > 1).length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
  };
}
