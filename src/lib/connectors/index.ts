import { APP_ORDER, APP_DEFAULTS } from "@/gst-core/gstr1";
import type { Connector, Provider } from "./types";
import { razorpayConnector, type RazorpayCreds } from "./razorpay";
import { cashfreeConnector, type CashfreeCreds } from "./cashfree";
import { appDbConnector, type AppDbCreds } from "./appdb";

export type { Connector, Provider, FetchResult } from "./types";

/**
 * Which source auto-feeds each app (chosen to match each app's validated parser type).
 * The rest (PhonePe → Bangalore Connect) is a manual upload. Bank + GSTR-2B are also manual.
 */
const WIRING: Record<string, Provider> = {
  "Hima": "appdb",                 // dashboard invoice-wise
  "Sudar": "razorpay",
  "Thedal": "razorpay",
  "Bangalore Connect": "manual",   // PhonePe — manual upload
  "Only Care": "cashfree",
  "Unman": "appdb",                // dashboard invoice-wise
};

/** "Bangalore Connect" -> "BANGALORE_CONNECT" for env var names. */
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
function appDbCreds(app: string): AppDbCreds | undefined {
  const url = process.env[`APPDB_${envKey(app)}_URL`];
  return url ? { url, query: process.env[`APPDB_${envKey(app)}_QUERY`] } : undefined;
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
