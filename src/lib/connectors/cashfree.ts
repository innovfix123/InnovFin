import type { AOA } from "@/gst-core/gstr1";
import type { Connector, FetchResult } from "./types";

export interface CashfreeCreds {
  appId: string;
  secretKey: string;
  env?: "production" | "sandbox";
}

export interface CfTxn {
  order_id: string;
  amount: number;
  status: string;
}

/** Map Cashfree transactions → AOA the cashfree parser expects (it filters SUCCESS itself). */
export function mapCashfreeTxns(items: CfTxn[]): AOA {
  const rows: AOA = [["Order Id", "Amount", "Transaction Status"]];
  for (const t of items) rows.push([t.order_id, t.amount, t.status]);
  return rows;
}

export function cashfreeConnector(app: string, creds?: CashfreeCreds): Connector {
  return {
    id: `cashfree:${app.toLowerCase().replace(/\s+/g, "-")}`,
    app,
    provider: "cashfree",
    parserType: "cashfree",
    mode: "auto",
    isConfigured: () => Boolean(creds?.appId && creds?.secretKey),
    async fetch(): Promise<FetchResult> {
      if (!creds?.appId || !creds?.secretKey) throw new Error(`Cashfree not configured for ${app}`);
      // NOT WIRED YET: Cashfree has no single "list all payments in a date range" endpoint as clean
      // as Razorpay's. Once creds + API version are shared, wire the Settlements/Recon report
      // (headers: x-client-id, x-client-secret, x-api-version) → mapCashfreeTxns(). Fail loud until then.
      throw new Error(`Cashfree connector for ${app}: reporting endpoint not wired yet (pending creds + API version).`);
    },
  };
}
