import type { AOA } from "@/gst-core/gstr1";
import type { Connector, FetchResult } from "./types";

export interface CashfreeCreds {
  appId: string;
  secretKey: string;
  apiVersion?: string;
}

export interface ReconRow {
  event_type?: string;     // PAYMENT | REFUND | ...
  event_status?: string;   // SUCCESS | ...
  event_time?: string;     // payment timestamp (ISO IST) — the GST/payment-date basis
  settlement_date?: string;
  order_id?: string;
  order_amount?: number;   // gross (incl. GST)
  event_id?: string;
  event_amount?: number;         // gross amount of THIS event (₹)
  payment_group?: string;        // UPI | UPI_CREDIT_CARD | ... — the payment method
  payment_service_charge?: number; // per-transaction MDR (194H taxable, GST-EXCLUSIVE)
  payment_service_tax?: number;    // GST charged on that MDR
}

const RECON_URL = "https://api.cashfree.com/pg/settlement/recon";

/** Map filtered recon payments → the AOA the cashfree parser expects. */
export function mapCashfreeTxns(items: { order_id: string; amount: number; status: string }[]): AOA {
  const rows: AOA = [["Order Id", "Amount", "Transaction Status"]];
  for (const t of items) rows.push([t.order_id, t.amount, t.status]);
  return rows;
}

function isoIST(y: number, m: number, d: number, hh: number, mm: number, ss: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:${p(ss)}+05:30`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST to a Cashfree endpoint, retrying on 429 (rate limit) and 5xx with exponential backoff. */
async function cashfreePost(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  const MAX = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body });
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= MAX) return res; // give up — caller surfaces the status
    await res.body?.cancel().catch(() => {});
    await sleep(Math.min(8000, 500 * 2 ** attempt)); // 0.5s,1s,2s,4s,8s,8s
  }
}

export async function fetchWindow(creds: CashfreeCreds, start: string, end: string): Promise<ReconRow[]> {
  const headers = {
    "x-client-id": creds.appId,
    "x-client-secret": creds.secretKey,
    "x-api-version": creds.apiVersion ?? "2023-08-01",
    "Content-Type": "application/json",
  };
  const all: ReconRow[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 400; pages++) {
    const pagination: Record<string, unknown> = { limit: 1000 };
    if (cursor) pagination.cursor = cursor;
    const res = await cashfreePost(RECON_URL, headers, JSON.stringify({ filters: { start_date: start, end_date: end }, pagination }));
    if (!res.ok) throw new Error(`Cashfree recon ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = (await res.json()) as { data?: ReconRow[]; cursor?: string };
    all.push(...(d.data ?? []));
    if (!d.cursor || (d.data ?? []).length === 0) break;
    cursor = d.cursor;
  }
  return all;
}

export function cashfreeConnector(app: string, creds?: CashfreeCreds): Connector {
  return {
    id: `cashfree:${app.toLowerCase().replace(/\s+/g, "-")}`,
    app,
    provider: "cashfree",
    parserType: "cashfree",
    mode: "auto",
    isConfigured: () => Boolean(creds?.appId && creds?.secretKey),
    async fetch(period: string): Promise<FetchResult> {
      if (!creds?.appId || !creds?.secretKey) throw new Error(`Cashfree not configured for ${app}`);
      const [y, m] = period.split("-").map(Number);
      if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);

      // The recon API filters by SETTLEMENT date (max 30 days/query). A month's payments settle
      // within ~7 days, so we pull settlement windows spanning the month + tail, then keep rows
      // whose PAYMENT time (event_time) falls in the month — the validated GST basis.
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      const w1 = await fetchWindow(creds, isoIST(y, m, 1, 0, 0, 0), isoIST(y, m, Math.min(lastDay, 30), 23, 59, 59));
      const tail = lastDay >= 31 ? isoIST(y, m, 31, 0, 0, 0) : isoIST(ny, nm, 1, 0, 0, 0);
      const w2 = await fetchWindow(creds, tail, isoIST(ny, nm, 9, 23, 59, 59));

      const merged = new Map<string, ReconRow>();
      for (const x of [...w1, ...w2]) merged.set(`${x.event_id}|${x.event_type}`, x);

      const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
      const payments = [...merged.values()].filter(
        (x) => x.event_type === "PAYMENT" && x.event_status === "SUCCESS" &&
          typeof x.event_time === "string" && x.event_time.startsWith(monthPrefix),
      );

      const aoa = mapCashfreeTxns(payments.map((x) => ({ order_id: x.order_id ?? "", amount: x.order_amount ?? 0, status: "SUCCESS" })));
      return { aoa, count: payments.length, source: `Cashfree (${app})` };
    },
  };
}

// ---- Gateway Settlements: Cashfree commission (194H) + bank reconciliation, per app ----
// Cashfree exposes the fee at the SETTLEMENT-BATCH level (event_type=SETTLEMENT on /pg/settlements):
// service_charge = MDR (194H taxable, GST-EXCLUSIVE), service_tax = GST-on-fee, amount_settled = net
// credited to our bank, payment_amount = gross, settlement_utr = the bank-reconciliation key. One batch
// == one bank credit. Read-only (same PG creds as the recon connector above). Basis = settlement date
// (money that hit the bank in the month → directly bank-reconcilable), which we state explicitly.

/** One Cashfree settlement batch — lands as a single bank credit. All amounts ₹, GST-exclusive fee. */
export interface CfSettlement {
  settlementId: string;   // cf_settlement_id
  utr: string;            // settlement_utr — the bank-reconciliation match key
  grossVolume: number;    // payment_amount — gross processed in the batch
  commission: number;     // service_charge — MDR, the 194H taxable base (GST-exclusive)
  gstOnCommission: number;// service_tax — GST charged on that MDR
  net: number;            // amount_settled — what actually reached the bank
  settlementDate: string; // settlement_date (ISO IST) — the bank-credit date
  status: string;         // PAID | ...
}

export interface CashfreeSettlements {
  app: string;
  period: string;         // "YYYY-MM"
  basis: "settlement-date";
  settlements: CfSettlement[];
  commission: number;     // Σ service_charge → 194H taxable (2%, code 1006, head 0020)
  gstOnCommission: number;// Σ service_tax
  grossVolume: number;    // Σ payment_amount
  netSettled: number;     // Σ amount_settled — reconciles to the month's bank credits for this app
  source: string;
}

const SETTLE_URL = "https://api.cashfree.com/pg/settlements";
const num = (n: unknown): number => (typeof n === "number" && isFinite(n) ? n : 0);

/**
 * Cashfree gateway settlements for a month, on a settlement-date basis (bank-reconcilable). Pulls the
 * SETTLEMENT-batch rows settled within the month (windowed ≤30d/query, cursor-paginated, deduped on
 * cf_settlement_id) and sums service_charge (194H taxable) + service_tax (GST). The per-batch
 * {utr, net, settlementDate} rows line up against the bank statement's credits.
 */
export async function fetchCashfreeSettlements(
  app: string,
  creds: CashfreeCreds | undefined,
  period: string,
): Promise<CashfreeSettlements> {
  if (!creds?.appId || !creds?.secretKey) throw new Error(`Cashfree not configured for ${app}`);
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const headers = {
    "x-client-id": creds.appId,
    "x-client-secret": creds.secretKey,
    "x-api-version": creds.apiVersion ?? "2023-08-01",
    "Content-Type": "application/json",
  };

  interface RawBatch {
    event_type?: string; cf_settlement_id?: string; settlement_utr?: string;
    payment_amount?: number; service_charge?: number; service_tax?: number;
    amount_settled?: number; settlement_date?: string; status?: string;
  }
  const p = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Two settlement-date windows spanning the month (each ≤30 days, matching the recon window cap).
  const windows: [string, string][] = [
    [`${y}-${p(m)}-01T00:00:00+05:30`, `${y}-${p(m)}-16T00:00:00+05:30`],
    [`${y}-${p(m)}-16T00:00:00+05:30`, `${y}-${p(m)}-${p(lastDay)}T23:59:59+05:30`],
  ];

  const byId = new Map<string, RawBatch>();
  for (const [start_date, end_date] of windows) {
    let cursor: string | undefined;
    for (let pages = 0; pages < 400; pages++) {
      const pagination: Record<string, unknown> = { limit: 1000 };
      if (cursor) pagination.cursor = cursor;
      const res = await fetch(SETTLE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ filters: { start_date, end_date }, pagination }),
      });
      if (!res.ok) throw new Error(`Cashfree settlements ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const d = (await res.json()) as { data?: RawBatch[]; cursor?: string };
      for (const row of d.data ?? []) {
        if (row.event_type === "SETTLEMENT" && row.cf_settlement_id) byId.set(row.cf_settlement_id, row);
      }
      if (!d.cursor || (d.data ?? []).length === 0) break;
      cursor = d.cursor;
    }
  }

  const settlements: CfSettlement[] = [...byId.values()].map((s) => ({
    settlementId: s.cf_settlement_id ?? "",
    utr: s.settlement_utr ?? "",
    grossVolume: num(s.payment_amount),
    commission: num(s.service_charge),
    gstOnCommission: num(s.service_tax),
    net: num(s.amount_settled),
    settlementDate: s.settlement_date ?? "",
    status: s.status ?? "",
  }));
  const commission = settlements.reduce((a, s) => a + s.commission, 0);
  const gstOnCommission = settlements.reduce((a, s) => a + s.gstOnCommission, 0);
  const grossVolume = settlements.reduce((a, s) => a + s.grossVolume, 0);
  const netSettled = settlements.reduce((a, s) => a + s.net, 0);
  return { app, period, basis: "settlement-date", settlements, commission, gstOnCommission, grossVolume, netSettled, source: `Cashfree settlements (${app})` };
}

// ---- Cashfree commission (194H) — PAYMENT-date basis (recon, per-transaction MDR) ----
// The settlement-BATCH sum above (service_charge) is bank-reconcilable but timing-shifted: a batch
// settled in the month carries MDR for transactions PROCESSED across the month boundary (T+1/T+2), so
// it under/over-counts the month's true commission. The recon API exposes the fee at the TRANSACTION
// level — payment_service_charge (MDR, GST-EXCLUSIVE) + payment_service_tax (GST) keyed to event_time
// (the payment date) — which is the basis the monthly commission INVOICE is built on. So this sums the
// MDR of every payment PROCESSED in the month = the closest API-derived proxy for the invoice figure.

export interface CashfreePaymentCommission {
  app: string;
  period: string;               // "YYYY-MM"
  basis: "payment-date";
  txnCount: number;             // SUCCESS payments processed in the month
  grossVolume: number;          // Σ event_amount (₹, incl GST)
  commission: number;           // Σ payment_service_charge → 194H taxable (GST-EXCLUSIVE)
  gstOnCommission: number;      // Σ payment_service_tax
  byMethod: Record<string, { count: number; fee: number }>; // GST-excl MDR by payment_group
  zeroFeeCount: number;         // payments Cashfree charged ₹0 MDR on (zero-MDR UPI)
  source: string;
}

/**
 * Cashfree 194H commission for a month on a PAYMENT-date basis. The recon API filters by SETTLEMENT
 * date, so we sweep settlement-date windows spanning the month + a ~9-day tail (late-month payments
 * settle early next month) and keep rows whose PAYMENT time (event_time) is in the month. Windows are
 * DAILY and fetched with bounded concurrency — a high-volume app (Hima ≈ 166k May payments) finishes
 * well inside the MCP request timeout, where the single-window sequential pull would not.
 */
export async function fetchCashfreePaymentCommission(
  app: string,
  creds: CashfreeCreds | undefined,
  period: string,
): Promise<CashfreePaymentCommission> {
  if (!creds?.appId || !creds?.secretKey) throw new Error(`Cashfree not configured for ${app}`);
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;

  // One settlement-date window per day: the month's days + the first 9 of the next month (T+1/T+2 tail).
  const days: [number, number, number][] = [];
  for (let d = 1; d <= lastDay; d++) days.push([y, m, d]);
  for (let d = 1; d <= 9; d++) days.push([ny, nm, d]);
  const windows: [string, string][] = days.map(([yy, mm, dd]) => [isoIST(yy, mm, dd, 0, 0, 0), isoIST(yy, mm, dd, 23, 59, 59)]);

  // Bounded concurrency (recon is cursor-paginated per window, so windows parallelise but pages don't).
  // Cashfree rate-limits recon aggressively — keep this low; cashfreePost() backs off on any 429.
  const CONC = 3;
  const merged = new Map<string, ReconRow>();
  for (let i = 0; i < windows.length; i += CONC) {
    const batch = windows.slice(i, i + CONC);
    const results = await Promise.all(batch.map(([s, e]) => fetchWindow(creds, s, e)));
    for (const rows of results) for (const r of rows) merged.set(`${r.event_id}|${r.event_type}`, r);
  }

  const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
  const pays = [...merged.values()].filter(
    (r) => r.event_type === "PAYMENT" && r.event_status === "SUCCESS" &&
      typeof r.event_time === "string" && r.event_time.startsWith(monthPrefix),
  );

  let commission = 0, gstOnCommission = 0, grossVolume = 0, zeroFeeCount = 0;
  const byMethod: Record<string, { count: number; fee: number }> = {};
  for (const r of pays) {
    const fee = num(r.payment_service_charge);
    commission += fee;
    gstOnCommission += num(r.payment_service_tax);
    grossVolume += num(r.event_amount) || num(r.order_amount);
    if (fee === 0) zeroFeeCount++;
    const g = r.payment_group ?? "UNKNOWN";
    const mth = byMethod[g] ?? { count: 0, fee: 0 };
    mth.count++; mth.fee += fee;
    byMethod[g] = mth;
  }
  for (const g of Object.keys(byMethod)) byMethod[g].fee = Math.round((byMethod[g].fee + Number.EPSILON) * 100) / 100;

  return {
    app, period, basis: "payment-date",
    txnCount: pays.length,
    grossVolume, commission, gstOnCommission, byMethod, zeroFeeCount,
    source: `Cashfree recon — payment-date basis (${app})`,
  };
}
