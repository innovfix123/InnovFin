import type { AOA } from "@/gst-core/gstr1";
import type { Connector, FetchResult } from "./types";

export interface AppDbCreds {
  /** Connection URL, e.g. mysql://user:pass@host:3306/db */
  url: string;
  /**
   * SELECT returning invoice-wise sales for the period. Must produce a `Taxable Value`
   * column (optionally `Invoice Value`, `Invoice No`), with two `?` placeholders bound to
   * the IST month [from, to] datetimes. Example:
   *   SELECT id AS `Invoice No`, taxable AS `Taxable Value`, gross AS `Invoice Value`
   *   FROM sales WHERE status='success' AND created_at BETWEEN ? AND ?
   */
  query?: string;
}

/** IST month boundary strings 'YYYY-MM-DD HH:MM:SS' for the query's date filter. */
function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const mm = String(m).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${mm}-01 00:00:00`, to: `${y}-${mm}-${String(lastDay).padStart(2, "0")} 23:59:59` };
}

/** DB rows (array of objects) → AOA with a header row, so the invoice-wise parser consumes it. */
function rowsToAOA(rows: Record<string, unknown>[]): AOA {
  if (rows.length === 0) return [[]];
  const cols = Object.keys(rows[0]);
  const aoa: AOA = [cols];
  for (const r of rows) aoa.push(cols.map((c) => r[c] as string | number | null));
  return aoa;
}

export function appDbConnector(app: string, creds?: AppDbCreds): Connector {
  const envName = app.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    id: `appdb:${app.toLowerCase().replace(/\s+/g, "-")}`,
    app,
    provider: "appdb",
    parserType: "invoicewise",
    mode: "auto",
    isConfigured: () => Boolean(creds?.url && creds?.query),
    async fetch(period: string): Promise<FetchResult> {
      if (!creds?.url) throw new Error(`App-DB not configured for ${app} (set APPDB_${envName}_URL)`);
      if (!creds.query) throw new Error(`App-DB for ${app}: no query set (APPDB_${envName}_QUERY) — must return a 'Taxable Value' column with two ? placeholders for [from,to].`);
      const { from, to } = monthBounds(period);
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection(creds.url);
      try {
        const [rows] = await conn.query(creds.query, [from, to]);
        const aoa = rowsToAOA(rows as Record<string, unknown>[]);
        return { aoa, count: Math.max(0, aoa.length - 1), source: `App-DB (${app})` };
      } finally {
        await conn.end();
      }
    },
  };
}
