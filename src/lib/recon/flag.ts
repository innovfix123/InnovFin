/**
 * Which source feeds the GSTR-1 working, and how refunds are presented.
 *
 * ══ THE FLAG IS OFF. ══
 *
 * `GST_SALES_SOURCE` defaults to "appdb" — the behaviour that has always run in production. The
 * gateway path is built, validated against June-2026 to the rupee, and NOT ENABLED.
 *
 * Enabling it changes a filed statutory return. It must not happen as a side effect of a deploy,
 * a refactor, or a typo. Three things are still outstanding before anyone should turn it on:
 *
 *   1. The CA (Shoyab) must rule on REFUNDS — netted off taxable, or a Table-9B credit note.
 *   2. The CA must rule on the MONTH-BOUNDARY money. The app stores a payment's INITIATION time
 *      and the gateway stores its COMPLETION time, so a little money each month lands in the
 *      wrong return.
 *      Correcting June means restating what was already filed for May and July.
 *   3. Thedal and Bangalore Connect are still NOT REGISTERED. The gateway path covers exactly the
 *      four apps in APP_ORDER — the same four production files today. Adding apps is a separate,
 *      explicit decision, not a rider on this flag.
 *
 * Note the comparison is `=== "gateway"`, not a truthiness check. "1", "true", "yes", "Gateway"
 * and any typo all resolve to "appdb". The only way to change what we file is to write the exact
 * word, on purpose.
 */

export type SalesSourceMode = "appdb" | "gateway";

/** The current GST sales source. Anything other than the exact string "gateway" → "appdb". */
export function salesSourceMode(): SalesSourceMode {
  return process.env.GST_SALES_SOURCE === "gateway" ? "gateway" : "appdb";
}

export function isGatewaySource(): boolean {
  return salesSourceMode() === "gateway";
}

/**
 * How a refunded sale is presented. Both paths are built; the CA's answer flips this one constant.
 *
 * "credit_note" (DEFAULT) — the supply stays at full taxable value and the refund is reported
 *                           separately (GSTR-1 Table 9B). Cannot understate output tax.
 * "net"                   — the refund is subtracted from taxable value.
 *
 * Either way the SALE SURVIVES. The current Razorpay path deletes a refunded payment outright
 * (`if (p.status !== "captured") continue`), which is wrong under both readings.
 */
export type RefundMode = "credit_note" | "net";

export function refundMode(): RefundMode {
  return process.env.GST_REFUND_MODE === "net" ? "net" : "credit_note";
}
