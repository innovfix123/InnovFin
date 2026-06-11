import type { AOA } from "@/gst-core/gstr1";
import { monthRange } from "./period";
import type { Connector, FetchResult } from "./types";

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}

export interface RzpPayment {
  id: string;
  amount: number; // paise
  status: string; // created | authorized | captured | refunded | failed
  created_at: number;
  method?: string;
}

/**
 * Map Razorpay payment objects → the AOA the razorpay parser expects.
 * Keep only CAPTURED payments (the consideration); amounts paise → ₹.
 * type="payment" so the parser includes them (settlement/fee rows never appear from /payments).
 */
export function mapRazorpayPayments(items: RzpPayment[]): AOA {
  const rows: AOA = [["entity_id", "type", "amount", "status", "created_at"]];
  for (const p of items) {
    if (p.status !== "captured") continue;
    rows.push([p.id, "payment", p.amount / 100, p.status, p.created_at]);
  }
  return rows;
}

const PAGE = 100;

export function razorpayConnector(app: string, creds?: RazorpayCreds): Connector {
  return {
    id: `razorpay:${app.toLowerCase().replace(/\s+/g, "-")}`,
    app,
    provider: "razorpay",
    parserType: "razorpay",
    mode: "auto",
    isConfigured: () => Boolean(creds?.keyId && creds?.keySecret),
    async fetch(period: string): Promise<FetchResult> {
      if (!creds?.keyId || !creds?.keySecret) throw new Error(`Razorpay not configured for ${app}`);
      const { fromSec, toSec } = monthRange(period);
      const auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
      const all: RzpPayment[] = [];
      for (let skip = 0; ; skip += PAGE) {
        const url = `https://api.razorpay.com/v1/payments?from=${fromSec}&to=${toSec}&count=${PAGE}&skip=${skip}`;
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) throw new Error(`Razorpay API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as { items?: RzpPayment[] };
        const items = data.items ?? [];
        all.push(...items);
        if (items.length < PAGE) break;
      }
      const aoa = mapRazorpayPayments(all);
      return { aoa, count: aoa.length - 1, source: `Razorpay (${app})` };
    },
  };
}
