import { APP_ORDER, APP_DEFAULTS } from "@/gst-core/gstr1";
import type { Connector, Provider } from "./types";
import { razorpayConnector, type RazorpayCreds } from "./razorpay";
import { cashfreeConnector, type CashfreeCreds } from "./cashfree";
import { appDbConnector, type AppDbCreds } from "./appdb";

export type { Connector, Provider, FetchResult } from "./types";

/**
 * Which source auto-feeds each app (chosen to match each app's validated parser type).
 * Hima/Sudar/Thedal/Only Care/Unman auto-fetch; Bangalore Connect (PhonePe) is a manual
 * upload. Bank statements + GSTR-2B are also manual.
 */
const WIRING: Record<string, Provider> = {
  "Hima": "appdb",                 // dashboard invoice-wise
  "Sudar": "razorpay",
  "Thedal": "razorpay",
  "Bangalore Connect": "manual",   // PhonePe — manual upload
  "Only Care": "cashfree",
  "Unman": "razorpay",             // Razorpay API (app DB available too — cross-check later)
};

/** "Only Care" -> "ONLY_CARE" for env var names. */
function envKey(app: string): string {
  return app.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function razorpayCreds(app: string): RazorpayCreds | undefined {
  const k = envKey(app);
  const keyId = process.env[`RAZORPAY_${k}_KEY_ID`];
  const keySecret = process.env[`RAZORPAY_${k}_KEY_SECRET`];
  return keyId && keySecret ? { keyId, keySecret } : undefined;
}
function cashfreeCreds(app: string): CashfreeCreds | undefined {
  const k = envKey(app);
  const appId = process.env[`CASHFREE_${k}_APP_ID`];
  const secretKey = process.env[`CASHFREE_${k}_SECRET_KEY`];
  return appId && secretKey ? { appId, secretKey } : undefined;
}
/**
 * Default per-app SQL (version-controlled & validated). `APPDB_{APP}_QUERY` overrides it.
 * Hima: completed coin-pack purchases across both gateways → invoice-wise taxable. The pack
 * price is GST-inclusive, so taxable = price/1.18. `checked=1` lets PhonePe use its
 * (checked,datetime) index. Validated vs the May 2026 filing (₹5,92,91,912 taxable /
 * 307,104 invoices) to 0.023%.
 */
const DEFAULT_APPDB_QUERY: Record<string, string> = {
  "Hima":
    "SELECT price/1.18 AS `Taxable Value`, price AS `Invoice Value` FROM (" +
    " SELECT c.price AS price FROM phonepe_payments p JOIN coins c ON c.id=p.coin_id" +
    " WHERE p.checked=1 AND p.status=1 AND p.datetime>=:from AND p.datetime<=:to" +
    " UNION ALL" +
    " SELECT c.price AS price FROM cashfree_payments p JOIN coins c ON c.id=p.coin_id" +
    " WHERE p.status=1 AND p.datetime>=:from AND p.datetime<=:to" +
    ") x",
};

function appDbCreds(app: string): AppDbCreds | undefined {
  const url = process.env[`APPDB_${envKey(app)}_URL`];
  if (!url) return undefined;
  return { url, query: process.env[`APPDB_${envKey(app)}_QUERY`] || DEFAULT_APPDB_QUERY[app] };
}

/** The auto-fetch connector for an app, or null when the app is a manual upload. */
export function getConnector(app: string): Connector | null {
  switch (WIRING[app] ?? "manual") {
    case "razorpay": return razorpayConnector(app, razorpayCreds(app));
    case "cashfree": return cashfreeConnector(app, cashfreeCreds(app));
    case "appdb": return appDbConnector(app, appDbCreds(app));
    default: return null;
  }
}

export interface SalesSource {
  app: string;
  hsn: number;
  provider: Provider;
  mode: "auto" | "manual";
  configured: boolean;
}

/** The Step-1 sales plan: each app, its source, and whether it's ready / needs manual upload. */
export function getSalesPlan(): SalesSource[] {
  return APP_ORDER.map((app) => {
    const c = getConnector(app);
    return {
      app,
      hsn: APP_DEFAULTS[app].hsn,
      provider: (WIRING[app] ?? "manual") as Provider,
      mode: c ? "auto" : "manual",
      configured: c ? c.isConfigured() : false,
    };
  });
}
