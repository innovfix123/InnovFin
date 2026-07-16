import { monthRange } from "@/lib/connectors/period";
import type { RazorpayCreds } from "@/lib/connectors/razorpay";
import { istFromEpochSec, isInMonthIST, pushAll, type Txn, type TxnStatus } from "./types";

/**
 * Razorpay → normalised transactions for a month.
 *
 * The one thing this does that the production path cannot: it KEEPS REFUNDED SALES.
 *
 * `mapRazorpayPayments()` (src/lib/connectors/razorpay.ts) begins
 *     if (p.status !== "captured") continue;
 * so a fully-refunded payment — status "refunded" — is deleted outright and the original supply
 * vanishes from GSTR-1 entirely. That is wrong under every reading: the supply happened. Whether
 * the refund is netted off or reported as a Table-9B credit note is a presentation question,
 * decided downstream; it is not a licence to delete the sale.
 *
 * It also reads `amount_refunded`, which catches PARTIAL refunds. Those keep status "captured",
 * so they are completely invisible today — nothing anywhere in the current pipeline knows a
 * partial refund happened.
 *
 * (In the reference month Sudar had a handful of fully-refunded payments — small in value, but
 * they vanish from the return entirely under the current path.)
 *
 * Read-only: GET /v1/payments only.
 */

interface RzpRaw {
  id: string;
  order_id?: string | null;
  amount: number;           // paise
  amount_refunded?: number; // paise
  status: string;           // created | authorized | captured | refunded | failed
  created_at: number;       // unix seconds, UTC
  method?: string;
}

const PAGE = 100;

function statusOf(raw: string, refunded: number): TxnStatus {
  if (raw === "refunded") return "refunded";
  if (raw === "captured") return refunded > 0 ? "refunded" : "success";
  if (raw === "failed") return "failed";
  return "unknown"; // created / authorized — money not taken
}

export interface RazorpayTxnResult {
  txns: Txn[];
  outOfMonth: Txn[];
  /** Rows Razorpay returned that never became money (created / authorized / failed). */
  nonPayments: number;
  raw: number;
}

/** Every payment Razorpay saw for `app` in `period` — captured AND refunded, never silently dropped. */
export async function fetchRazorpayTxns(
  app: string,
  creds: RazorpayCreds | undefined,
  period: string,
): Promise<RazorpayTxnResult> {
  if (!creds?.keyId || !creds?.keySecret) throw new Error(`Razorpay not configured for ${app}`);
  const { fromSec, toSec } = monthRange(period);
  const auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");

  const all: RzpRaw[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const url = `https://api.razorpay.com/v1/payments?from=${fromSec}&to=${toSec}&count=${PAGE}&skip=${skip}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Razorpay API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const items = ((await res.json()) as { items?: RzpRaw[] }).items ?? [];
    pushAll(all, items);
    if (items.length < PAGE) break;
  }

  const txns: Txn[] = [];
  const outOfMonth: Txn[] = [];
  let nonPayments = 0;

  for (const p of all) {
    const refunded = (p.amount_refunded ?? 0) / 100;
    const status = statusOf(p.status, refunded);
    if (status === "unknown" || status === "failed") { nonPayments++; continue; }

    const t: Txn = {
      // Razorpay reuses order_id across retry attempts, the payment id is unique per attempt.
      // Dedupe on the order where there is one, so a retried order collapses to one supply.
      orderId: p.order_id || p.id,
      amount: p.amount / 100,
      status,
      txnTimeIST: istFromEpochSec(p.created_at),
      source: "razorpay",
      method: p.method ?? null,
      refunded,
      reference: p.id,
    };
    (isInMonthIST(t.txnTimeIST, period) ? txns : outOfMonth).push(t);
  }

  return { txns, outOfMonth, nonPayments, raw: all.length };
}
