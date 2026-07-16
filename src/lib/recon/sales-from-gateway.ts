import {
  GST_RATE, toLine, summarise, APP_ORDER,
  type Gstr1Line, type HsnRow, type Gstr1Total, type Measurement,
} from "@/gst-core/gstr1";
import { fetchCashfreeTxns } from "./cashfree-source";
import { fetchRazorpayTxns } from "./razorpay-source";
import { parsePhonePeFiles, type PhonePeFile } from "./phonepe-source";
import { dedupeByOrderId } from "./dedupe";
import { cashfreeCreds, razorpayCreds, GATEWAYS } from "./creds";
import { refundMode, type RefundMode } from "./flag";
import { pushAll, type Txn } from "./types";

/**
 * The GSTR-1 working, sourced from the payment gateways instead of the app database.
 *
 * ONLY REACHED WHEN GST_SALES_SOURCE=gateway, which is NOT SET. See ./flag.ts.
 *
 * Validated to the rupee against a reference month with `npm run recon:check`, which reproduces
 * independently-established anchors from the live gateways: the Cashfree totals exactly, the autopay
 * revenue the app database structurally cannot see, the payments it wrongly marked failed, and a
 * zero residual. The anchor values are internal — see the local anchors file that script reads.
 *
 * Returns the SAME response shape as /api/sales, so nothing downstream has to change.
 */

export interface GatewaySalesSource {
  app: string;
  mode: "auto" | "manual";
  status: "ok" | "pending" | "error";
  count?: number;
  taxable?: number;
  /** Gross refunded against this app's sales (₹). Presentation depends on refundMode. */
  refunds?: number;
  message?: string;
}

export interface GatewaySalesResult {
  period: string;
  lines: Gstr1Line[];
  hsnRows: HsnRow[];
  total: Gstr1Total;
  sources: GatewaySalesSource[];
  /** Which source produced this working. Always echoed, so a reader is never guessing. */
  basis: "gateway";
  refundMode: RefundMode;
}

/** Deduped gateway transactions → one GSTR-1 measurement. Pure; this is what the tests pin. */
export function measurementOf(txns: Txn[], mode: RefundMode, basis: string): Measurement {
  const deduped = dedupeByOrderId(txns).kept;
  const gross = deduped.reduce((a, t) => a + t.amount, 0);
  const refunded = deduped.reduce((a, t) => a + t.refunded, 0);

  // "net" subtracts the refund from the supply. "credit_note" leaves the supply whole and reports
  // the refund separately (Table 9B). In NEITHER case is the sale deleted.
  const value = mode === "net" ? gross - refunded : gross;

  return {
    taxable: value / (1 + GST_RATE),
    invoiceValueActual: value,
    count: deduped.length,
    serialMin: null,
    serialMax: null,
    basis,
  };
}

/** Σ refunded across deduped rows (₹). */
export function refundsOf(txns: Txn[]): number {
  return dedupeByOrderId(txns).kept.reduce((a, t) => a + t.refunded, 0);
}

/** PhonePe files for `app`, pulled off the multipart form (`file:phonepe:<App>` or `file:<App>`). */
async function phonepeFilesFor(app: string, form: FormData): Promise<PhonePeFile[]> {
  const out: PhonePeFile[] = [];
  for (const [key, value] of form.entries()) {
    const wanted = key === `file:${app}` || key.startsWith(`file:phonepe:${app}`) || key === "file:phonepe";
    if (!wanted) continue;
    if (value instanceof File && value.size > 0) out.push({ name: value.name, text: await value.text() });
  }
  return out;
}

/**
 * Compute the working for every app in APP_ORDER from its gateways.
 *
 * APP_ORDER is deliberately the SAME four apps production files today. Thedal and Bangalore Connect
 * are still unregistered; adding them changes what the return contains and is a separate decision.
 */
export async function computeGatewaySales(period: string, form: FormData): Promise<GatewaySalesResult> {
  const mode = refundMode();
  const lines: Gstr1Line[] = [];
  const sources: GatewaySalesSource[] = [];

  for (const app of APP_ORDER) {
    const providers = GATEWAYS[app] ?? [];
    const txns: Txn[] = [];
    const bases: string[] = [];
    let incomplete: string | null = null;

    try {
      for (const provider of providers) {
        if (provider === "cashfree") {
          const creds = cashfreeCreds(app);
          if (!creds) { incomplete = `Cashfree credentials missing for ${app}`; break; }
          const r = await fetchCashfreeTxns(app, creds, period);
          pushAll(txns, r.txns);
          bases.push(`Cashfree recon (payment-date, all payment_groups incl. SBC_* autopay)`);
        }

        if (provider === "razorpay") {
          const creds = razorpayCreds(app);
          if (!creds) { incomplete = `Razorpay credentials missing for ${app}`; break; }
          const r = await fetchRazorpayTxns(app, creds, period);
          pushAll(txns, r.txns);
          bases.push(`Razorpay payments (captured + refunded, order-id deduped)`);
        }

        if (provider === "phonepe") {
          // There is no PhonePe API credential. If nobody uploaded the month's reports we must
          // REFUSE to produce a line for this app — a silently absent gateway is how a return goes
          // crores short and nobody notices. Better a visible "pending" than a quiet lie.
          const files = await phonepeFilesFor(app, form);
          if (files.length === 0) {
            incomplete =
              `${app} collects through PhonePe and there is no API credential. ` +
              `Upload the month's PhonePe merchant reports — without them this app's working is INCOMPLETE.`;
            break;
          }
          const r = parsePhonePeFiles(files, period);
          pushAll(txns, r.txns);
          bases.push(`PhonePe merchant reports (${files.length} file(s), order-id deduped)`);
        }
      }

      if (providers.length === 0) {
        sources.push({ app, mode: "manual", status: "pending", message: "no gateway configured for this app" });
        continue;
      }
      if (incomplete) {
        // No line is emitted. The total is visibly short, and the reason is on screen.
        sources.push({ app, mode: "manual", status: "pending", message: incomplete });
        continue;
      }

      const meas = measurementOf(txns, mode, bases.join(" + "));
      const line = toLine(app, meas, {});
      lines.push(line);
      sources.push({
        app,
        mode: providers.includes("phonepe") ? "manual" : "auto",
        status: "ok",
        count: meas.count,
        taxable: line.taxable,
        refunds: refundsOf(txns),
      });
    } catch (e) {
      sources.push({ app, mode: "auto", status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const { hsnRows, total } = summarise(lines);
  return { period, lines, hsnRows, total, sources, basis: "gateway", refundMode: mode };
}
