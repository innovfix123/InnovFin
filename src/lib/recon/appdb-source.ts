import { istFromNaive, isInMonthIST, type Txn } from "./types";

/**
 * App DB → normalised transactions. STRICTLY READ-ONLY.
 *
 * Two views of the same database, and the difference between them is the whole story:
 *
 *   fetchAppDbFiled()  runs the EXACT query production files with (APPDB_<APP>_QUERY from .env).
 *                      This is what our GSTR-1 currently contains — bugs included. It is the
 *                      baseline we reconcile the gateways against, so it must not be "improved".
 *
 *   fetchAppDbAll()    a recon-only SELECT that removes the two filters the production query
 *                      applies, in order to SEE what they are hiding:
 *                        • JOIN coins → LEFT JOIN, so a payment with no coin pack still appears.
 *                          (An autopay/mandate charge has no coin pack, so the inner join deletes
 *                          it — that is the SBC_* revenue missing from the filed return.)
 *                        • no status/checked filter, so we can see the 11 gateway-confirmed
 *                          payments the app left at status=0, and the 1 row at status=1 that no
 *                          gateway ever confirmed.
 *
 * Nothing here writes. Every statement is asserted to be a bare SELECT before it is sent.
 */

/** Hard guard: this module may only ever issue a read. */
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|GRANT|SET|CALL|LOAD)\b/i;

export function assertReadOnly(sql: string): void {
  const s = sql.trim();
  if (!/^SELECT\b/i.test(s)) throw new Error("recon/appdb: refusing to run a statement that is not a SELECT");
  if (FORBIDDEN.test(s)) throw new Error("recon/appdb: refusing to run a statement containing a write keyword");
  if (s.includes(";")) throw new Error("recon/appdb: refusing to run a multi-statement query");
}

function envKey(app: string): string {
  return app.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** IST month bounds as MySQL DATETIME strings, matching the production connector exactly. */
function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const mm = String(m).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${mm}-01 00:00:00`, to: `${y}-${mm}-${String(lastDay).padStart(2, "0")} 23:59:59` };
}

/**
 * The recon-only query.
 *
 * ⚠ WE CANNOT READ THE BASE TABLES. Verified 2026-07-13: `gstapp_ro` holds SELECT on exactly two
 * objects — `gst_cashfree_sales_v` and `gst_phonepe_sales_v` — and nothing else. A query against
 * `phonepe_payments` fails with ER_TABLEACCESS_DENIED_ERROR. The views ARE the boundary.
 *
 * ⚠ AND THE VIEWS ARE LOSSY. Both expose `price` as int NOT NULL while `gst_phonepe_sales_v`
 * exposes `coin_id` as NULLABLE — a shape only an INNER JOIN to `coins` produces (a LEFT JOIN
 * would make `price` nullable). So a payment with no coin pack — every autopay/mandate charge —
 * is deleted INSIDE the view, below anything these credentials can see.
 *
 * The consequence is important and easy to get wrong: dropping the status/checked predicates
 * below reveals the rows the app DISBELIEVED (status=0), but it CANNOT reveal the rows the app
 * never recorded. Those are only visible from the gateway side — which is what reconcile()'s
 * `missing` report is for. See `coinlessVisible` on AppDbAllResult.
 *
 * (SHOW CREATE VIEW is also denied, so the INNER JOIN is inferred from column nullability rather
 * than read from the DDL. Getting the definition from the DBA would upgrade this to certainty.)
 *
 * Override per app with RECON_APPDB_<APP>_QUERY. Must return: order_id, dt, price, status, checked, gw
 */
const RECON_QUERY: Record<string, string> = {
  Hima:
    "SELECT order_id, dt, price, status, checked, gw FROM (" +
    " SELECT CONVERT(order_id USING utf8mb4) AS order_id, datetime AS dt, price, status, checked," +
    " CONVERT(gateway USING utf8mb4) AS gw FROM gst_phonepe_sales_v" +
    " WHERE datetime>=:from AND datetime<=:to" +
    " UNION ALL" +
    " SELECT CONVERT(order_id USING utf8mb4), datetime, price, status, NULL," +
    " CONVERT(gateway USING utf8mb4) FROM gst_cashfree_sales_v" +
    " WHERE datetime>=:from AND datetime<=:to" +
    ") x",
};

/** `dateStrings` keeps MySQL DATETIMEs as raw 'YYYY-MM-DD HH:mm:ss'. The DB stores IST wall-clock;
 * letting mysql2 build a JS Date would reinterpret it through the server's UTC timezone. */
async function connect(url: string) {
  const mysql = await import("mysql2/promise");
  const u = new URL(url);
  return mysql.createConnection({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    namedPlaceholders: true,
    dateStrings: true,
  });
}

export interface AppDbFiledResult {
  /** Exactly the rows production currently files. */
  txns: Txn[];
  taxable: number;
  gross: number;
}

/** What our GSTR-1 contains TODAY. Runs the production query verbatim — do not "fix" it here. */
export async function fetchAppDbFiled(app: string, period: string): Promise<AppDbFiledResult> {
  const k = envKey(app);
  const url = process.env[`APPDB_${k}_URL`];
  const query = process.env[`APPDB_${k}_QUERY`];
  if (!url) throw new Error(`App-DB not configured for ${app} (APPDB_${k}_URL)`);
  if (!query) throw new Error(`App-DB query not set for ${app} (APPDB_${k}_QUERY)`);
  assertReadOnly(query);

  const { from, to } = monthBounds(period);
  const conn = await connect(url);
  try {
    const [rows] = await conn.query(query, { from, to });
    const txns: Txn[] = [];
    let taxable = 0;
    let gross = 0;
    for (const r of rows as Record<string, unknown>[]) {
      const amount = Number(r["Invoice Value"] ?? 0);
      const tv = Number(r["Taxable Value"] ?? 0);
      taxable += tv;
      gross += amount;
      txns.push({
        orderId: String(r["Invoice No"] ?? ""),
        amount,
        status: "success", // the production query already filters to status=1
        txnTimeIST: istFromNaive(String(r["Invoice Date"] ?? "")),
        source: "appdb",
        method: (r["Gateway"] as string) ?? null,
        refunded: 0,
        reference: null,
      });
    }
    return { txns, taxable, gross };
  } finally {
    await conn.end();
  }
}

/** One app-DB payment row, unfiltered — the shape the production query hides. */
export interface AppDbRow {
  orderId: string;
  txnTimeIST: string;
  /** Coin-pack list price. NULL when the payment has no coin pack — i.e. the inner JOIN drops it. */
  price: number | null;
  status: number;
  checked: number | null;
  gateway: string;
  inMonth: boolean;
}

export interface AppDbAllResult {
  rows: AppDbRow[];
  /** Rows with no coin pack. See `coinlessVisible` — an EMPTY list here does NOT mean none exist. */
  noCoinPack: AppDbRow[];
  /**
   * Can this source see coin-less payments at all?
   *
   * FALSE for Hima, because the view inner-joins `coins` before we ever get the rows. When this is
   * false, `noCoinPack: []` means "I am blind to them", NOT "there are none" — and callers must not
   * report it as a clean result. Autopay revenue is only observable from the gateway side.
   */
  coinlessVisible: boolean;
}

/** Every [from, to] day-window in the period, as MySQL DATETIME strings. */
function dayWindows(period: string): { from: string; to: string }[] {
  const [y, m] = period.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: { from: string; to: string }[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dd = String(d).padStart(2, "0");
    out.push({ from: `${y}-${mm}-${dd} 00:00:00`, to: `${y}-${mm}-${dd} 23:59:59` });
  }
  return out;
}

export interface FetchAllOpts {
  /**
   * Read the month one DAY at a time (30 small queries) instead of one month-wide query.
   *
   * This is the gentler way to touch a live database. Each chunk carries a narrow `datetime` range
   * and returns ~1/30th of the rows, so no single statement holds the server for long. It matters
   * here because this query's cost CANNOT be verified up front: MySQL refuses to EXPLAIN a view
   * when the caller lacks rights on the underlying tables (ER_VIEW_NO_EXPLAIN), and `gstapp_ro`
   * holds SELECT on the two views and nothing else.
   */
  daily?: boolean;
  /** Called after each chunk, so a long read is observable rather than opaque. */
  onChunk?: (info: { from: string; to: string; rows: number; ms: number }) => void;
}

/**
 * Every payment row in the window regardless of status — recon only, READ-ONLY.
 *
 * ⚠ Heavier than the production query: it drops the `status`/`checked` predicates, so it may not
 * use the index the production query was written to hit. It is a plain SELECT and cannot mutate
 * anything — but prefer `{ daily: true }` against a live month.
 */
export async function fetchAppDbAll(
  app: string,
  period: string,
  opts: FetchAllOpts = {},
): Promise<AppDbAllResult> {
  const k = envKey(app);
  const url = process.env[`APPDB_${k}_URL`];
  const query = process.env[`RECON_APPDB_${k}_QUERY`] || RECON_QUERY[app];
  if (!url) throw new Error(`App-DB not configured for ${app} (APPDB_${k}_URL)`);
  if (!query) throw new Error(`No recon query for ${app} (set RECON_APPDB_${k}_QUERY)`);
  assertReadOnly(query);

  const windows = opts.daily ? dayWindows(period) : [monthBounds(period)];

  // One connection, many small statements — 30 connections would be the ruder option.
  const conn = await connect(url);
  const rows: AppDbRow[] = [];
  try {
    for (const w of windows) {
      const t0 = Date.now();
      const [raw] = await conn.query(query, w);
      const chunk = raw as Record<string, unknown>[];
      for (const r of chunk) {
        const txnTimeIST = istFromNaive(String(r.dt ?? ""));
        rows.push({
          orderId: String(r.order_id ?? ""),
          txnTimeIST,
          price: r.price == null ? null : Number(r.price),
          status: Number(r.status ?? 0),
          checked: r.checked == null ? null : Number(r.checked),
          gateway: String(r.gw ?? ""),
          inMonth: isInMonthIST(txnTimeIST, period),
        });
      }
      opts.onChunk?.({ from: w.from, to: w.to, rows: chunk.length, ms: Date.now() - t0 });
    }
    // The view's `price` is NOT NULL (inner join to `coins`), so this list is structurally always
    // empty for Hima. Reported alongside coinlessVisible=false so it is never read as "all clear".
    return { rows, noCoinPack: rows.filter((r) => r.price == null), coinlessVisible: false };
  } finally {
    await conn.end();
  }
}
