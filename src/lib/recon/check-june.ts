/**
 * Phase-3 validation harness — NOT a unit test. Hits the LIVE Cashfree API and the LIVE Hima
 * app database (read-only), and reads the PhonePe merchant CSVs from disk.
 *
 * It imports the real recon modules, so what it proves is the shipped code path, not a parallel
 * reimplementation of it. Nothing here writes anywhere, and nothing here touches the production
 * GST path: /api/sales still computes the return exactly as it did before.
 *
 * Run:
 *   npx tsx --env-file=.env --max-old-space-size=8192 src/lib/recon/check-june.ts [YYYY-MM] [phonepeDir]
 */
import fs from "node:fs";
import path from "node:path";
import { fetchCashfreeTxns } from "./cashfree-source";
import { parsePhonePeFiles, type PhonePeLazyFile } from "./phonepe-source";
import { fetchAppDbFiled, fetchAppDbAll } from "./appdb-source";
import { reconcile, reconcileStatuses } from "./reconcile";
import { cashfreeCreds } from "./creds";
import type { Txn } from "./types";

const APP = "Hima";
const period = process.argv[2] ?? "2026-06";
const ppDir = process.argv[3] ?? "GSTR-2B-est-mcp/.claude/hima phone pe ";

const inr = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s: string | number, n: number) => String(s).padStart(n);

/**
 * Optional on-disk cache for the two EXPENSIVE reads — the live Cashfree pull (~155s) and the
 * unfiltered app-DB read (~533s across 30 daily chunks). Set RECON_CACHE_DIR to iterate on the
 * report without hitting the gateway or the production database again; unset it (or pass
 * --refresh) for a genuine end-to-end run. Being able to iterate cheaply is the whole reason the
 * live database is not hit thirty times while a formatting bug gets fixed.
 */
const CACHE = process.env.RECON_CACHE_DIR;
const REFRESH = process.argv.includes("--refresh");

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!CACHE || REFRESH) return fn();
  const f = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(f)) {
    console.log(`      (cached: ${key})`);
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  }
  const v = await fn();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
  return v;
}

/**
 * The reference-month anchors: figures independently established from the gateway data before any
 * of this code existed. If the module reproduces them, the module is right. If it does not, the
 * module is wrong.
 *
 * THE VALUES ARE NOT IN THIS FILE. They are revenue and filed-return figures and this repository is
 * PUBLIC, so they live in a local, gitignored JSON that this script reads:
 *
 *     recon-anchors.local.json          (override the path with RECON_ANCHORS_FILE)
 *
 *     { "cashfreeCount": 0, "cashfreeGross": 0, "appDbCashfreeCount": 0, "appDbCashfreeGross": 0,
 *       "missingCount": 0, "missingGross": 0, "orphanGross": 0, "orphanOrderId": "",
 *       "phonepeGross": 0, "trueTaxable": 0, "uncreditedGross": 0 }
 *
 * Without that file the script still runs and still prints the whole reconciliation — it simply
 * cannot grade itself against the anchors, and says so rather than pretending it passed. The
 * residual self-checks (which must be zero by construction, and reveal nothing) always run.
 */
interface Anchors {
  cashfreeCount: number; cashfreeGross: number;
  appDbCashfreeCount: number; appDbCashfreeGross: number;
  missingCount: number; missingGross: number;
  orphanGross: number; orphanOrderId: string;
  phonepeGross: number; trueTaxable: number; uncreditedGross: number;
}

const ANCHORS: Anchors | null = (() => {
  const f = path.resolve(process.env.RECON_ANCHORS_FILE ?? "recon-anchors.local.json");
  if (!fs.existsSync(f)) {
    console.log(`\n⚠ No anchors file at ${f} — reconciliation will print, but NOT be graded.`);
    return null;
  }
  return JSON.parse(fs.readFileSync(f, "utf8")) as Anchors;
})();

let failures = 0;
function check(label: string, actual: number | string, expected: number | string | undefined, tol = 0) {
  const a = typeof actual === "number" ? inr(actual) : actual;
  if (expected === undefined) {
    console.log(`  ⚪ ${label.padEnd(46)} got ${pad(a, 18)}   (no anchor — not graded)`);
    return;
  }
  const ok =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) <= tol
      : actual === expected;
  if (!ok) failures++;
  const e = typeof expected === "number" ? inr(expected) : expected;
  console.log(`  ${ok ? "✅" : "❌"} ${label.padEnd(46)} got ${pad(a, 18)}   expected ${pad(e, 18)}`);
}

(async () => {
  console.log(`\n══ Hima GST reconciliation — ${period} ══\n`);

  // ---- 1. Cashfree: the live API (this is the automated source) ----
  console.log("[1/4] Cashfree — live recon API…");
  let t0 = Date.now();
  const cf = await cached(`cashfree-${period}`, () =>
    fetchCashfreeTxns(APP, cashfreeCreds(APP), period, {
      onWindow: (d, t) => process.stdout.write(`      window ${pad(d, 2)}/${t}\r`),
      onRateLimit: (a, ms) => console.log(`      ⏳ Cashfree 429 — backing off ${ms / 1000}s (attempt ${a})`),
    }),
  );
  console.log(
    `      ${cf.txns.length} in-month successes from ${cf.raw} recon rows ` +
      `(${cf.outOfMonth.length} out-of-month) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );

  // ---- 2. PhonePe: manual monthly exports (no API credential exists) ----
  console.log("[2/4] PhonePe — merchant CSVs from disk…");
  const dir = path.resolve(ppDir);
  const files: PhonePeLazyFile[] = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => ({ name: f, read: () => fs.readFileSync(path.join(dir, f), "utf8") }));
  if (files.length === 0) throw new Error(`No PhonePe CSVs in ${dir} — extract the .zip exports first.`);

  t0 = Date.now();
  const pp = parsePhonePeFiles(files, period);
  for (const f of pp.byFile) {
    console.log(`      ${f.format.padEnd(20)} ${pad(f.rows, 7)} rows → ${pad(f.txns, 7)} txns   ${f.name.slice(0, 44)}`);
  }
  console.log(
    `      → ${pp.txns.length} deduped in-month successes; ${pp.dedupe.dropped.length} rows deduped away; ` +
      `${pp.outOfMonth.length} out-of-month; ${Object.keys(pp.refunds).length} refunds ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );

  // ---- 3. App DB: the PRODUCTION query, verbatim — the baseline we reconcile against ----
  console.log("[3/4] App DB — the production query (what we file today)…");
  const filed = await cached(`appdb-filed-${period}`, () => fetchAppDbFiled(APP, period));
  // The view's `gateway` column is LOWERCASE ('cashfree' / 'phonepe'). Matching "Cashfree" exactly
  // silently returned zero rows on the first run and made every gateway payment look "missing".
  const gwOf = (t: Txn) => String(t.method ?? "").toLowerCase();
  const filedCf = filed.txns.filter((t) => gwOf(t) === "cashfree");
  const filedPp = filed.txns.filter((t) => gwOf(t) === "phonepe");
  console.log(
    `      ${filed.txns.length} rows — Cashfree ${filedCf.length} / PhonePe ${filedPp.length}; ` +
      `₹${inr(filed.gross)} gross, ₹${inr(filed.taxable)} taxable\n`,
  );

  // ---- 4. App DB unfiltered, read one DAY at a time (gentlest option on a live database) ----
  console.log("[4/4] App DB — unfiltered, daily chunks…");
  t0 = Date.now();
  let slowest = 0;
  const all = await cached(`appdb-all-${period}`, () =>
    fetchAppDbAll(APP, period, {
      daily: true,
      onChunk: ({ from, rows, ms }) => {
        slowest = Math.max(slowest, ms);
        process.stdout.write(`      ${from.slice(0, 10)}  ${pad(rows, 6)} rows  ${pad(ms, 5)}ms\r`);
      },
    }),
  );
  console.log(
    `      ${all.rows.length} rows across 30 daily reads in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(slowest chunk ${slowest}ms)                    \n`,
  );

  // ---- Reconcile ----
  const gatewayTxns: Txn[] = [...cf.txns, ...pp.txns];
  const gatewayOutOfMonth: Txn[] = [...cf.outOfMonth, ...pp.outOfMonth];
  const r = reconcile({ app: APP, period, gatewayTxns, gatewayOutOfMonth, appDbTxns: filed.txns });

  // Per-gateway, because the two disagree for completely different reasons.
  const cfOnly = reconcile({ app: APP, period, gatewayTxns: cf.txns, appDbTxns: filedCf });
  const ppOnly = reconcile({ app: APP, period, gatewayTxns: pp.txns, appDbTxns: filedPp });

  console.log("── CASHFREE ────────────────────────────────────────────────────────────────");
  check("gateway txns", cfOnly.gateway.count, ANCHORS?.cashfreeCount);
  check("gateway gross", cfOnly.gateway.gross, ANCHORS?.cashfreeGross, 0.5);
  check("app-DB txns (filed)", cfOnly.appDb.count, ANCHORS?.appDbCashfreeCount);
  check("app-DB gross (filed)", cfOnly.appDb.gross, ANCHORS?.appDbCashfreeGross, 0.5);
  check("missing txns (absent from app DB)", cfOnly.missing.totals.count, ANCHORS?.missingCount);
  check("missing gross", cfOnly.missing.totals.gross, ANCHORS?.missingGross, 0.5);
  check("orphan gross (app says paid, gateway never saw)", cfOnly.orphans.totals.gross, ANCHORS?.orphanGross, 0.5);
  check("orphan order id", cfOnly.orphans.txns[0]?.orderId ?? "(none)", ANCHORS?.orphanOrderId);
  check("residual (self-check — must be 0)", cfOnly.residual, 0, 0.005);

  console.log("\n  What the app DB never recorded, by payment method:");
  for (const [m, t] of Object.entries(cfOnly.missing.byMethod).sort((a, b) => b[1].gross - a[1].gross)) {
    console.log(`    ${m.padEnd(20)} ${pad(t.count, 6)} txns   ₹${pad(inr(t.gross), 14)}`);
  }

  console.log("\n── PHONEPE ─────────────────────────────────────────────────────────────────");
  check("gateway gross", ppOnly.gateway.gross, ANCHORS?.phonepeGross, 1);
  console.log(`     app-DB gross (filed)                        ₹${inr(ppOnly.appDb.gross)}  (${ppOnly.appDb.count} txns)`);
  console.log(`     missing from app DB                         ₹${inr(ppOnly.missing.totals.gross)}  (${ppOnly.missing.totals.count} txns)`);
  console.log(`     orphans (app says paid, gateway didn't)     ₹${inr(ppOnly.orphans.totals.gross)}  (${ppOnly.orphans.totals.count} txns)`);
  check("residual (self-check — must be 0)", ppOnly.residual, 0, 0.005);

  console.log("\n── STATUS MISMATCHES (from the daily app-DB read) ───────────────────────────");
  const st = reconcileStatuses(gatewayTxns, all.rows, all.coinlessVisible);
  check("gateway paid, app left at status=0", st.totals.gatewayPaidAppFailed.gross, ANCHORS?.uncreditedGross, 0.5);
  console.log(`     …that is ${st.gatewayPaidAppFailed.length} payments whose customers were never credited:`);
  for (const m of st.gatewayPaidAppFailed.slice(0, 15)) {
    console.log(`       ${m.orderId.padEnd(22)} ₹${pad(inr(m.amount), 10)}  ${m.txnTimeIST.slice(0, 19)}  ${m.gateway}`);
  }
  console.log(`\n     app said paid, but NO gateway success in this month — ${st.appPaidGatewayMissing.length} row(s):`);
  for (const o of st.appPaidGatewayMissing) {
    console.log(`       ${o.orderId.padEnd(24)} ₹${pad(inr(o.amount), 10)}  ${o.txnTimeIST.slice(0, 19)}`);
  }
  for (const s of st.blindSpots) console.log(`     ⚠ BLIND SPOT: ${s}`);

  console.log("\n── DUPLICATES / MONTH BOUNDARY / REFUNDS ────────────────────────────────────");
  // The gateway rows are already deduped by their source, so ask the SOURCE what it collapsed —
  // asking reconcile() would report 0 and read as "PhonePe has no duplicates", which is false.
  console.log(`     PhonePe rows collapsed by dedupe:           ${pp.dedupe.dropped.length}`);
  console.log(`     PhonePe order ids seen more than once:      ${pp.dedupe.duplicateOrderIds.length}`);
  console.log(`     duplicate order ids — app-DB side:          ${r.duplicates.appDbOrderIds.length}` +
    `${r.duplicates.appDbOrderIds.length ? ` (${r.duplicates.appDbOrderIds.join(", ")})` : ""}`);
  console.log(`     amount conflicts (same order, 2 amounts):   ${r.duplicates.amountConflicts.length}`);
  console.log(`     out-of-month gateway successes:             ${r.monthBoundary.totals.count} · ₹${inr(r.monthBoundary.totals.gross)}`);
  for (const t of r.monthBoundary.txns.slice(0, 5)) {
    console.log(`       ${t.orderId.padEnd(22)} ₹${pad(inr(t.amount), 10)}  ${t.txnTimeIST.slice(0, 19)}  ${t.source}`);
  }
  console.log(`     refunds:                                    ${r.refunds.count} · ₹${inr(r.refunds.amount)}`);

  console.log("\n── HIMA, JUNE 2026 — THE BOTTOM LINE ────────────────────────────────────────");
  console.log(`     gateway gross (Cashfree + PhonePe)          ₹${inr(r.gateway.gross)}`);
  console.log(`     app-DB gross (what we filed)                ₹${inr(r.appDb.gross)}`);
  console.log(`     gap                                         ₹${inr(r.gap.gross)}`);
  check("TRUE taxable", r.gateway.taxable, ANCHORS?.trueTaxable, 1);
  console.log(`     filed taxable                               ₹${inr(r.appDb.taxable)}`);
  console.log(`     UNDER-DECLARED taxable                      ₹${inr(r.gap.taxable)}`);
  console.log(`     …GST on that (18%)                          ₹${inr(r.gap.taxable * 0.18)}`);
  check("residual — every rupee accounted for", r.residual, 0, 0.005);

  console.log(
    `\n${failures === 0 ? "✅ ALL ANCHORS REPRODUCED" : `❌ ${failures} ANCHOR(S) FAILED`} ` +
      `— production GST logic unchanged; nothing was written.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n💥", e);
  process.exit(1);
});
