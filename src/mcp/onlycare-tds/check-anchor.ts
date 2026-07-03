/**
 * End-to-end harness (NOT a unit test — hits the live Only Care DB via the tunnel).
 * Runs the full pipeline for May 2026 and asserts the filed ₹2,086.85 anchor, then emits the workbook.
 * Run: npx tsx src/mcp/onlycare-tds/check-anchor.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeOnlyCareTds } from "./compute";
import { buildSec194CNonCompany } from "./workbook";
import { REPO_ROOT } from "./env";

(async () => {
  const period = process.argv[2] ?? "2026-05";
  const r = await computeOnlyCareTds(period);
  console.log(JSON.stringify({
    period, panSource: r.panSource, subtotal: r.subtotal, regression: r.regression,
    flagsSummary: r.flagsSummary, sampleRows: r.rows.slice(0, 3),
  }, null, 2));

  const outDir = resolve(REPO_ROOT, "OnlyCare-TDS-mcp/out");
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, `Sec_194C_NonCompany_${period}.xlsx`);
  writeFileSync(path, buildSec194CNonCompany(period, r.rows));
  console.log(`\nworkbook: ${path} (${r.rows.length} rows)`);

  if (r.regression.ok) console.log(`\n✅ ANCHOR MATCH — computed TDS ₹${r.subtotal.tds} = filed ₹${r.regression.anchorTds}`);
  else console.log(`\n❌ DRIFT — ${JSON.stringify(r.regression)}`);
  process.exit(r.regression.ok === false ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(2); });
