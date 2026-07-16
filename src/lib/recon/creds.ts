import type { CashfreeCreds } from "@/lib/connectors/cashfree";
import type { RazorpayCreds } from "@/lib/connectors/razorpay";

/**
 * Gateway credentials, read from the environment.
 *
 * Deliberately a separate copy of the lookup in src/lib/connectors/index.ts rather than an export
 * from it: the reconciliation layer is meant to stand apart from the production GST path, and this
 * is six lines of `process.env` with no logic in it. The env var NAMES are the contract, and they
 * are already fixed by .env and by the live connectors.
 *
 * Read-only credentials. Nothing in this layer moves money.
 */

/** "Only Care" → "ONLY_CARE" */
function envKey(app: string): string {
  return app.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function cashfreeCreds(app: string): CashfreeCreds | undefined {
  const k = envKey(app);
  const appId = process.env[`CASHFREE_${k}_APP_ID`];
  const secretKey = process.env[`CASHFREE_${k}_SECRET_KEY`];
  return appId && secretKey ? { appId, secretKey } : undefined;
}

export function razorpayCreds(app: string): RazorpayCreds | undefined {
  const k = envKey(app);
  const keyId = process.env[`RAZORPAY_${k}_KEY_ID`];
  const keySecret = process.env[`RAZORPAY_${k}_KEY_SECRET`];
  return keyId && keySecret ? { keyId, keySecret } : undefined;
}

/** Which gateways each app actually collects through. Evidence, not the production WIRING map:
 *  Hima runs BOTH Cashfree and PhonePe — that is why one connector per app cannot describe it. */
export const GATEWAYS: Record<string, ("cashfree" | "razorpay" | "phonepe")[]> = {
  "Hima": ["cashfree", "phonepe"],
  "Only Care": ["cashfree"],
  "Sudar": ["razorpay"],
  "Unman": ["razorpay"],
  "Thedal": ["razorpay"],
  "Bangalore Connect": ["phonepe"],
};
