/**
 * Only Care app-side KYC / verification signals (read-only). Answers "can we pay this creator?" —
 * PAN captured & Paysprint-checked, KYC PAN document approved, bank account penny-drop verified —
 * plus a shared-PAN data-quality flag. Sourced live from onlycare_admin:
 *   - pay_sprint      → Paysprint PAN-verification call log (type='pan_verification', ₹1/call)
 *   - kyc_documents   → PAN document review (status APPROVED, verified_at)
 *   - bank_accounts   → is_verified (penny-drop) + pancard_number
 *
 * COMPLIANCE BOUNDARY: this is app-onboarding verification, NOT the TDS-rate PAN status. It must
 * NEVER feed the 206AA operative/inoperative rate branch — that stays sourced from TRACES/PaySprint
 * *compliance* status (see pan-provider.ts, tds-core/types.ts). Paysprint's pan_verification only
 * confirms the PAN exists and the name matches; it does not return operative/inoperative. So a
 * kyc_documents "APPROVED" is not the same as TRACES "operative" — these flags are reference/QA only.
 */
import { getOnlyCareConnection } from "./db";

export interface KycStatusRow {
  creatorId: string;              // users.id
  creatorName: string | null;     // users.name
  pan: string | null;             // primary/verified bank account's PAN (== the approved KYC PAN)
  paysprintChecks: number;        // count of Paysprint pan_verification calls for this user
  paysprintLastAt: string | null; // 'YYYY-MM-DD HH:MM:SS' (IST) of the last Paysprint check
  kycPanApproved: boolean;        // a PAN kyc_document reached status APPROVED
  kycVerifiedAt: string | null;   // 'YYYY-MM-DD HH:MM:SS' (IST) of that approval
  bankVerified: boolean;          // at least one bank account is_verified=1 (penny-drop)
  bankAccounts: number;           // how many bank accounts the creator has on file
  panSharedByUsers: number;       // distinct users sharing this PAN (>1 ⇒ data-quality flag)
  fullyVerified: boolean;         // pan present AND kycPanApproved AND bankVerified
  flags: string[];                // human-readable data-quality flags (empty = clean)
}

export interface KycLookup {
  userIds?: string[];
  pans?: string[];
}

// One PAN doc per user and (almost always) one bank account per user, so per-user aggregates are
// unambiguous. pan is taken from the verified/primary account; panSharedByUsers is a global count.
const BASE_SELECT = `
SELECT
  u.id                                       AS creatorId,
  u.name                                     AS creatorName,
  vb.pan                                     AS pan,
  COALESCE(ps.checks, 0)                     AS paysprintChecks,
  ps.lastAt                                  AS paysprintLastAt,
  COALESCE(kd.approved, 0)                   AS kycPanApproved,
  kd.verifiedAt                              AS kycVerifiedAt,
  COALESCE(vb.anyVerified, 0)                AS bankVerified,
  COALESCE(vb.accounts, 0)                   AS bankAccounts,
  COALESCE(sh.users, 0)                      AS panSharedByUsers
FROM users u
LEFT JOIN (
  SELECT user_id, COUNT(*) checks, DATE_FORMAT(MAX(datetime), '%Y-%m-%d %H:%i:%s') lastAt
  FROM pay_sprint WHERE type = 'pan_verification' GROUP BY user_id
) ps ON ps.user_id = u.id
LEFT JOIN (
  SELECT user_id, MAX(status = 'APPROVED') approved,
         DATE_FORMAT(MAX(CASE WHEN status = 'APPROVED' THEN verified_at END), '%Y-%m-%d %H:%i:%s') verifiedAt
  FROM kyc_documents WHERE document_type = 'PAN' GROUP BY user_id
) kd ON kd.user_id = u.id
LEFT JOIN (
  SELECT user_id, MAX(is_verified) anyVerified, COUNT(*) accounts,
         SUBSTRING_INDEX(
           GROUP_CONCAT(pancard_number ORDER BY is_verified DESC, is_primary DESC SEPARATOR ','), ',', 1
         ) pan
  FROM bank_accounts GROUP BY user_id
) vb ON vb.user_id = u.id
LEFT JOIN (
  SELECT pancard_number, COUNT(DISTINCT user_id) users
  FROM bank_accounts WHERE pancard_number IS NOT NULL GROUP BY pancard_number
) sh ON sh.pancard_number = vb.pan`;

/** Look up app-side verification status for a set of creators (by user id and/or PAN). */
export async function fetchOnlyCareKyc(lookup: KycLookup): Promise<KycStatusRow[]> {
  const userIds = (lookup.userIds ?? []).filter(Boolean);
  const pans = (lookup.pans ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (!userIds.length && !pans.length) return [];

  const where: string[] = [];
  const params: unknown[] = [];
  if (userIds.length) {
    where.push("u.id IN (?)");
    params.push(userIds);
  }
  if (pans.length) {
    where.push("u.id IN (SELECT user_id FROM bank_accounts WHERE pancard_number IN (?))");
    params.push(pans);
  }
  const sql = `${BASE_SELECT}\nWHERE ${where.join(" OR ")}\nORDER BY u.id`;

  const conn = await getOnlyCareConnection();
  try {
    const [rows] = await conn.query(sql, params);
    return (rows as Record<string, unknown>[]).map(toRow);
  } finally {
    await conn.end();
  }
}

function toRow(r: Record<string, unknown>): KycStatusRow {
  const pan = r.pan == null ? null : String(r.pan);
  const paysprintChecks = Number(r.paysprintChecks ?? 0);
  const kycPanApproved = Number(r.kycPanApproved ?? 0) === 1;
  const bankVerified = Number(r.bankVerified ?? 0) === 1;
  const panSharedByUsers = Number(r.panSharedByUsers ?? 0);
  const fullyVerified = Boolean(pan) && kycPanApproved && bankVerified;

  const flags: string[] = [];
  if (!pan) flags.push("No PAN on file");
  if (!kycPanApproved) flags.push("KYC PAN not approved");
  if (!bankVerified) flags.push("Bank account not verified (no penny-drop)");
  if (paysprintChecks === 0) flags.push("No Paysprint PAN check on record");
  if (panSharedByUsers > 1) flags.push(`PAN shared by ${panSharedByUsers} creators — reconcile before filing`);

  return {
    creatorId: String(r.creatorId),
    creatorName: r.creatorName == null ? null : String(r.creatorName),
    pan,
    paysprintChecks,
    paysprintLastAt: r.paysprintLastAt == null ? null : String(r.paysprintLastAt),
    kycPanApproved,
    kycVerifiedAt: r.kycVerifiedAt == null ? null : String(r.kycVerifiedAt),
    bankVerified,
    bankAccounts: Number(r.bankAccounts ?? 0),
    panSharedByUsers,
    fullyVerified,
    flags,
  };
}

/** Creator-level roll-up over a set of KYC rows (for tool summaries). */
export function summariseKyc(rows: KycStatusRow[]): {
  creators: number; fullyVerified: number; bankVerified: number; kycPanApproved: number;
  paysprintChecked: number; noPan: number; sharedPan: number; flagged: number;
} {
  return {
    creators: rows.length,
    fullyVerified: rows.filter((r) => r.fullyVerified).length,
    bankVerified: rows.filter((r) => r.bankVerified).length,
    kycPanApproved: rows.filter((r) => r.kycPanApproved).length,
    paysprintChecked: rows.filter((r) => r.paysprintChecks > 0).length,
    noPan: rows.filter((r) => !r.pan).length,
    sharedPan: rows.filter((r) => r.panSharedByUsers > 1).length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
  };
}
