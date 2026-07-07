/**
 * End-to-end harness (NOT a unit test — hits the LIVE gateway settlement APIs).
 * Runs the 194H pipeline for a month TWO ways:
 *   (1) settlement-fee only (no invoice) — the reconciliation view; won't match the filed anchor.
 *   (2) invoice-basis (the two validated filed invoice figures via invoiceLines) + a carry-forward
 *       example — the AUTHORITATIVE filed view, with the settlement-fee drift shown per line.
 * The filed RUPEE anchor (₹26,865.70) is intentionally NOT asserted (invoice figures for all gateways
 * + PhonePe are needed). Exits non-zero only on a pipeline/fetch failure.
 * Run: npx tsx src/mcp/gateway-settlements/check-anchor.ts [YYYY-MM]
 */
import { computeCommission } from "./compute";
import type { ManualLine } from "./settlements";
import type { CarryForward } from "./compute";
import { monthLabel } from "./util";

(async () => {
  const period = process.argv[2] ?? "2026-05";

  // (1) Settlement-fee only — the reconciliation cross-check (different basis from the filing).
  const est = await computeCommission(period);
  console.log(`\n=== 194H — ${monthLabel(period)} — settlement-fee view (reconciliation only) ===`);
  for (const l of est.lines) {
    const v = l.taxable194H == null ? `(pending — ${l.note})` : `settlement-fee ₹${l.settlementDerived?.commission} → 194H(est) ₹${l.tds194H}  [${l.taxableBasis}]`;
    console.log(`  ${l.app}/${l.gateway}: ${v}`);
  }
  console.log(`  Σ settlement-fee ₹${est.summary.settlementCommission}   Σ 194H(est) ₹${est.summary.tds194H}`);

  // (2) Invoice basis — the validated filed invoice figures (Only Care + Thedal) + April carry-forward.
  const invoiceLines: ManualLine[] = [
    { app: "Only Care", gateway: "cashfree", taxable: 12695.67, invoiceRef: "FILED-OC-MAY26" },
    { app: "Thedal", gateway: "razorpay", taxable: 1084.42, invoiceRef: "FILED-THEDAL-MAY26" },
  ];
  const carryForward: CarryForward[] = [
    { fromPeriod: "2026-04", shortfall: 6000, monthsLate: 2, ratePerMonth: 0.01, note: "April 194H short-deposit, cleared in May" },
  ];
  const r = await computeCommission(period, undefined, { invoiceLines, carryForward });

  console.log(`\n=== 194H — ${monthLabel(period)} — invoice basis (authoritative) ===`);
  for (const l of r.lines) {
    if (l.taxable194H == null) { console.log(`  ${l.app}/${l.gateway}: (pending — ${l.note})`); continue; }
    const recon = l.reconciliation ? `  (settlement ₹${l.reconciliation.settlementCommission}, drift ${l.reconciliation.driftPct}%)` : "";
    console.log(`  ${l.app}/${l.gateway}: taxable ₹${l.taxable194H} [${l.taxableBasis}] → 194H ₹${l.tds194H}${recon}`);
  }
  console.log(`\n  Σ taxable ₹${r.summary.taxable194H}   Σ 194H ₹${r.summary.tds194H}`);

  console.log(`\n  ── filed-anchor reconciliation (invoice basis; reference, NOT locked) ──`);
  console.log(`  filed May-2026 194H total: ₹${r.regression.anchorTotal}`);
  for (const pl of r.regression.perLine) {
    const verdict = pl.matches == null ? "" : pl.matches ? " ✅" : ` ⚠ drift ₹${pl.drift}`;
    console.log(`    ${pl.app}/${pl.gateway}: filed ₹${pl.filedTds}  vs computed ₹${pl.computedTds} [${pl.basis}]${verdict}`);
  }

  if (r.carryForward && r.deposit) {
    console.log(`\n  ── carry-forward + deposit (194H) ──`);
    for (const e of r.carryForward.entries) console.log(`    ${e.fromPeriod} shortfall ₹${e.shortfall} + interest ₹${e.interest} (${e.ratePerMonth * 100}%×${e.months}mo) = ₹${e.total}`);
    console.log(`    current-month 194H ₹${r.deposit.currentMonth194H} + carry-forward ₹${r.carryForward.totalCarryForward} = TOTAL TO DEPOSIT ₹${r.deposit.totalToDeposit}`);
  }

  console.log(`\n✅ pipeline ran. Supply the GSTR-2B invoice figures for every gateway (+ PhonePe) to reconcile the full ₹26,865.70; confirm with Shoyab before locking.`);
})().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(2); });
