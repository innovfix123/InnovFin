import type { AOA } from "@/gst-core/gstr1";
import type { Connector, FetchResult } from "./types";

export interface CashfreeCreds {
  appId: string;
  secretKey: string;
  apiVersion?: string;
}

interface ReconRow {
  event_type?: string;     // PAYMENT | REFUND | ...
  event_status?: string;   // SUCCESS | ...
  event_time?: string;     // payment timestamp (ISO IST) — the GST basis
  settlement_date?: string;
  order_id?: string;
  order_amount?: number;   // gross (incl. GST)
  event_id?: string;
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

async function fetchWindow(creds: CashfreeCreds, start: string, end: string): Promise<ReconRow[]> {
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
    const res = await fetch(RECON_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ filters: { start_date: start, end_date: end }, pagination }),
    });
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
