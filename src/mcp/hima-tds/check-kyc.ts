/**
 * Live check for the Hima KYC/verification data layer (hits the Hima DB via the tunnel — NOT a unit
 * test). Proves the kyc.ts module against the CANONICAL SQL (Perumal's two checks) for a month, so
 * it stays correct as the live data drifts (no hard-coded daily counts):
 *   1) "paid but not verified": every paid creator with no successful pan/bank verification is
 *      counted identically whether derived from the module (notFound + summary) or from raw SQL.
 *   2) shared PAN: a PAN used by >1 creator resolves to ≥2 rows and fires the shared-PAN flag.
 * Run: npx tsx src/mcp/hima-tds/check-kyc.ts [YYYY-MM]
 */
import { getHimaConnection } from "./db";
import { fetchHimaKyc, summariseHimaKyc } from "./kyc";
import { fetchHimaPayouts } from "./payouts";
import { monthBounds } from "./util";

const CANONICAL = `
WITH payc AS (
  SELECT DISTINCT creator_id FROM tds_creator_payouts_v
  WHERE payment_date >= :from AND payment_date < :to
)
SELECT
  (SELECT COUNT(*) FROM payc) AS mayCreators,
  (SELECT COUNT(*) FROM payc c WHERE NOT EXISTS (
     SELECT 1 FROM kyc_verifications_v k
     WHERE k.creator_id = c.creator_id AND k.verification_type = 'pan_verification' AND k.status = 'success')) AS paidNoPanVerified,
  (SELECT COUNT(*) FROM payc c WHERE NOT EXISTS (
     SELECT 1 FROM kyc_verifications_v k
     WHERE k.creator_id = c.creator_id AND k.verification_type = 'bank_verification' AND k.status = 'success')) AS paidNoBankVerified`;

(async () => {
  const period = process.argv[2] ?? "2026-05";
  const { from, to } = monthBounds(period);

  // 1) Canonical counts + a live shared PAN, straight from SQL.
  const conn = await getHimaConnection({ namedPlaceholders: true });
  let canon: Record<string, unknown>;
  let sharedPan: string | undefined;
  try {
    const [[c]] = (await conn.query(CANONICAL, { from, to })) as [Record<string, unknown>[], unknown];
    canon = c;
    const [sp] = (await conn.query(
      "SELECT pan FROM kyc_verifications_v WHERE pan IS NOT NULL GROUP BY pan HAVING COUNT(DISTINCT creator_id) > 1 LIMIT 1",
    )) as [Record<string, unknown>[], unknown];
    sharedPan = sp[0] ? String(sp[0].pan) : undefined;
  } finally {
    await conn.end();
  }

  // 2) Derive the same counts through the module (creators with NO kyc row = notFound, all unverified).
  const payouts = await fetchHimaPayouts(period);
  const creatorIds = [...new Set(payouts.map((p) => p.creatorId))];
  const rows = await fetchHimaKyc({ creatorIds });
  const summary = summariseHimaKyc(rows);
  const notFound = creatorIds.length - rows.length;
  const derivedNoPan = notFound + summary.panUnverified;
  const derivedNoBank = notFound + summary.bankUnverified;

  const reco = {
    mayCreators: { canonical: Number(canon.mayCreators), module: creatorIds.length },
    paidNoPanVerified: { canonical: Number(canon.paidNoPanVerified), module: derivedNoPan },
    paidNoBankVerified: { canonical: Number(canon.paidNoBankVerified), module: derivedNoBank },
    creatorsWithNoKycRow: notFound,
  };
  console.log(JSON.stringify({ period, reco, summary }, null, 2));

  const okReco =
    reco.mayCreators.canonical === reco.mayCreators.module &&
    reco.paidNoPanVerified.canonical === reco.paidNoPanVerified.module &&
    reco.paidNoBankVerified.canonical === reco.paidNoBankVerified.module;
  console.log(
    okReco
      ? `\n✅ RECONCILES — module matches canonical SQL: ${reco.mayCreators.module} paid creators, ${derivedNoPan} without a verified PAN, ${derivedNoBank} without a verified bank`
      : `\n❌ RECONCILIATION DRIFT — module vs canonical mismatch (see reco above)`,
  );

  // 3) Shared-PAN flag.
  let okShared = true;
  if (sharedPan) {
    const shRows = await fetchHimaKyc({ pans: [sharedPan] });
    okShared = shRows.length >= 2 && shRows.some((r) => r.panSharedByCreators > 1 && r.flags.some((f) => /shared/i.test(f)));
    console.log(
      okShared
        ? `✅ SHARED-PAN FLAG — a shared PAN resolves to ${shRows.length} creators and fires the flag`
        : `⚠️  shared PAN resolved to ${shRows.length} creator(s) — flag did not fire as expected`,
    );
  } else {
    console.log("ℹ️  no shared PAN found to exercise the flag");
  }

  process.exit(okReco && okShared ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(2); });
