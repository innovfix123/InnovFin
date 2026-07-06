/**
 * End-to-end harness (NOT a unit test — hits the live Hima DB via the tunnel).
 * Runs the full pipeline for a month, checks the DB STRUCTURAL anchor (payout/creator/taxable
 * counts, verified live + stable), prints the filed-anchor reconciliation, and emits the workbook.
 * The filed RUPEE anchor is intentionally NOT asserted yet — see compute.ts (gross gap + 206AA method).
 * Run: npx tsx src/mcp/hima-tds/check-anchor.ts [YYYY-MM]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeHimaTds } from "./compute";
import { buildSec194CNonCompany } from "./workbook";
import { REPO_ROOT } from "./env";

// DB structural anchors — verified live 2026-07-04 (read-only). Guards the fetch/mapping pipeline
// against regressions independently of the (still-open) filed rupee anchor.
const DB_ANCHOR: Record<string, { payouts: number; creators: number; taxable: number }> = {
  "2026-05": { payouts: 84109, creators: 9958, taxable: 26668647 },
};

(async () => {
  const period = process.argv[2] ?? "2026-05";
  const r = await computeHimaTds(period);
  console.log(JSON.stringify({
    period, panSource: r.panSource, subtotal: r.subtotal, regression: r.regression,
    filedReference: r.filedReference, flagsSummary: r.flagsSummary, sampleRows: r.rows.slice(0, 3),
  }, null, 2));

  const outDir = resolve(REPO_ROOT, "Hima-TDS-mcp/out");
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, `Sec_194C_NonCompany_${period}.xlsx`);
  writeFileSync(path, buildSec194CNonCompany(period, r.rows));
  console.log(`\nworkbook: ${path} (${r.rows.length} rows)`);

  const a = DB_ANCHOR[period];
  let structuralOk = true;
  if (a) {
    structuralOk = r.subtotal.payouts === a.payouts && r.subtotal.creators === a.creators && Math.round(r.subtotal.taxable) === a.taxable;
    if (structuralOk) {
      console.log(`\n✅ DB STRUCTURAL ANCHOR MATCH — ${a.payouts} payouts / ${a.creators} creators / ₹${a.taxable} taxable`);
    } else {
      console.log(`\n❌ DB STRUCTURAL DRIFT — got ${r.subtotal.payouts}/${r.subtotal.creators}/₹${Math.round(r.subtotal.taxable)}, expected ${a.payouts}/${a.creators}/₹${a.taxable}`);
    }
  }

  if (r.filedReference) {
    const fr = r.filedReference;
    console.log(`\nℹ️  FILED-ANCHOR RECONCILIATION (not yet locked):`);
    console.log(`   filed (flat 1%):      gross ₹${fr.filedGross}  →  TDS ₹${fr.filedTds}`);
    console.log(`   our gross×1%:         ₹${r.subtotal.grossTimesOnePct}   (gross gap vs filed ₹${Math.round(r.subtotal.taxable - fr.filedGross)})`);
    console.log(`   our 206AA-deposited:  ₹${r.subtotal.tds}   (company-loss ₹${r.subtotal.companyLoss}, no-PAN rows ${r.subtotal.noPanCount}, inoperative ${r.subtotal.inoperativeCount})`);
    console.log(`   → ${fr.note}`);
  }

  process.exit(structuralOk ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(2); });
