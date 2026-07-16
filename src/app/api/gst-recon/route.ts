import { NextResponse } from "next/server";
import { fetchCashfreeTxns } from "@/lib/recon/cashfree-source";
import { fetchRazorpayTxns } from "@/lib/recon/razorpay-source";
import { parsePhonePeFiles, type PhonePeFile } from "@/lib/recon/phonepe-source";
import { fetchAppDbFiled, fetchAppDbAll } from "@/lib/recon/appdb-source";
import { reconcile, reconcileStatuses } from "@/lib/recon/reconcile";
import { cashfreeCreds, razorpayCreds, GATEWAYS } from "@/lib/recon/creds";
import { pushAll, type Txn } from "@/lib/recon/types";

export const runtime = "nodejs";

/**
 * GST reconciliation report — READ-ONLY, and deliberately NOT part of the filing path.
 *
 * This route reads the gateways and the app database and reports where they disagree. It does not
 * compute, alter or influence what we file: /api/sales is untouched and remains the sole source of
 * the GSTR-1 working. Enabling the gateway as the GST source is a separate, flagged decision that
 * has not been taken.
 *
 * Behind the portal login gate (src/proxy.ts matches every /api/* except login/logout).
 *
 * POST multipart/form-data:
 *   period            "2026-06"                 (required)
 *   app               "Hima"                    (required)
 *   file:phonepe      one or more report CSVs   (PhonePe has no API credentials)
 *   includeStatuses   "1" to also run the heavier unfiltered app-DB read  (DEFAULT: OFF)
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const period = String(form.get("period") ?? "");
  const app = String(form.get("app") ?? "");

  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: `Invalid period "${period}" (expected YYYY-MM)` }, { status: 400 });
  }
  if (!GATEWAYS[app]) {
    return NextResponse.json({ error: `Unknown app "${app}"`, known: Object.keys(GATEWAYS) }, { status: 400 });
  }

  const notes: string[] = [];
  const gatewayTxns: Txn[] = [];
  const gatewayOutOfMonth: Txn[] = [];

  try {
    for (const provider of GATEWAYS[app]) {
      if (provider === "cashfree") {
        const creds = cashfreeCreds(app);
        if (!creds) { notes.push(`Cashfree: no credentials for ${app} — skipped.`); continue; }
        const r = await fetchCashfreeTxns(app, creds, period);
        pushAll(gatewayTxns, r.txns);
        pushAll(gatewayOutOfMonth, r.outOfMonth);
        notes.push(`Cashfree: ${r.txns.length} in-month successes from ${r.raw} recon rows.`);
      }

      if (provider === "razorpay") {
        const creds = razorpayCreds(app);
        if (!creds) { notes.push(`Razorpay: no credentials for ${app} — skipped.`); continue; }
        const r = await fetchRazorpayTxns(app, creds, period);
        pushAll(gatewayTxns, r.txns);
        pushAll(gatewayOutOfMonth, r.outOfMonth);
        notes.push(`Razorpay: ${r.txns.length} in-month payments (${r.nonPayments} never became money).`);
      }

      if (provider === "phonepe") {
        // No PHONEPE_* credential exists, so PhonePe is a file source. If the caller uploads
        // nothing, say so LOUDLY — a silently absent gateway is exactly how a return goes short.
        const files: PhonePeFile[] = [];
        for (const [key, value] of form.entries()) {
          if (!key.startsWith("file:phonepe")) continue;
          if (value instanceof File && value.size > 0) files.push({ name: value.name, text: await value.text() });
        }
        if (files.length === 0) {
          notes.push(
            `⚠ PhonePe: NO FILES UPLOADED. ${app} collects through PhonePe and there is no API ` +
              `credential, so this report is INCOMPLETE — the PhonePe half of the month is absent.`,
          );
          continue;
        }
        const r = parsePhonePeFiles(files, period);
        pushAll(gatewayTxns, r.txns);
        pushAll(gatewayOutOfMonth, r.outOfMonth);
        notes.push(
          `PhonePe: ${r.txns.length} in-month successes from ${files.length} file(s) ` +
            `[${r.byFile.map((f) => `${f.format}:${f.rows}`).join(", ")}]; ` +
            `${r.dedupe.dropped.length} rows deduped away.`,
        );
      }
    }

    // What production files TODAY — the baseline we are reconciling against. Runs the live
    // APPDB_<APP>_QUERY verbatim; it is not "fixed" here, because the point is to measure it.
    let appDbTxns: Txn[] = [];
    try {
      const filed = await fetchAppDbFiled(app, period);
      appDbTxns = filed.txns;
      notes.push(`App DB: ${filed.txns.length} rows, ₹${filed.gross.toFixed(2)} gross (the production query).`);
    } catch (e) {
      notes.push(`App DB: not read — ${e instanceof Error ? e.message : String(e)}`);
    }

    const report = reconcile({ app, period, gatewayTxns, gatewayOutOfMonth, appDbTxns });

    // The unfiltered app-DB read is OFF by default. It drops the status/checked predicates, so it
    // may not use the (checked, datetime) index the production query was written to hit — a plain
    // SELECT, but potentially a slow one against a live database. Opt in explicitly.
    let statuses = null;
    if (String(form.get("includeStatuses") ?? "") === "1") {
      const all = await fetchAppDbAll(app, period);
      statuses = reconcileStatuses(gatewayTxns, all.rows);
      notes.push(`App DB (unfiltered): ${all.rows.length} rows, ${all.noCoinPack.length} with no coin pack.`);
    }

    return NextResponse.json({ report, statuses, notes });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), notes }, { status: 500 });
  }
}
