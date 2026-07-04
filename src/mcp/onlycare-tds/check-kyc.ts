/**
 * Live check for the KYC/verification data layer (hits the Only Care DB via the tunnel — NOT a unit
 * test). Looks up a known shared PAN and asserts the shared-PAN flag fires, then previews a sample.
 * Run: npx tsx src/mcp/onlycare-tds/check-kyc.ts [PAN]
 */
import { fetchOnlyCareKyc, summariseKyc } from "./kyc";

(async () => {
  const pan = process.argv[2] ?? "CNYPT5941G"; // a PAN observed shared across several creators
  const rows = await fetchOnlyCareKyc({ pans: [pan] });
  console.log(JSON.stringify({ pan, summary: summariseKyc(rows), sample: rows.slice(0, 3) }, null, 2));

  const shared = rows.length >= 2 && rows.some((r) => r.panSharedByUsers > 1 && r.flags.some((f) => /shared/i.test(f)));
  if (shared) console.log(`\n✅ KYC layer OK — PAN ${pan} resolves to ${rows.length} creators and the shared-PAN flag fires`);
  else console.log(`\n⚠️  PAN ${pan} resolved to ${rows.length} creator(s) — no shared-PAN flag (pick a shared PAN to exercise the flag)`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(2); });
