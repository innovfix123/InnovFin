/**
 * Which app is settled by which gateway, and how to reach each — the wiring for the 194H commission
 * source. Separate from the sales/GST wiring in src/lib/connectors (that picks ONE source per app for
 * revenue; here an app can have MULTIPLE gateway lines, e.g. Hima = Cashfree + PhonePe).
 *
 * Credentials are resolved through the MCP's .env-aware envVar() (NOT process.env), so the stdio
 * server + anchor harness run standalone via tsx. A gateway with no keys is SKIPPED and flagged —
 * never a hard failure — so the remaining apps slot in as keys arrive (PhonePe, etc.).
 */
import type { RazorpayCreds } from "@/lib/connectors/razorpay";
import type { CashfreeCreds } from "@/lib/connectors/cashfree";
import { OWN_PAN } from "@/tds-core";
import { envVar } from "./env";

export type Gateway = "cashfree" | "razorpay" | "phonepe";

export interface GatewaySlice {
  app: string;
  gateway: Gateway;
}

/**
 * The per-app × per-gateway lines that make up the 194H section (matches how the filed sheet breaks
 * commission out per app). Add a line here (+ its keys) to bring a gateway online.
 */
export const GATEWAY_SLICES: GatewaySlice[] = [
  { app: "Hima", gateway: "cashfree" },
  { app: "Hima", gateway: "phonepe" },            // Hima also settles via PhonePe — keys pending
  { app: "Only Care", gateway: "cashfree" },
  { app: "Thedal", gateway: "razorpay" },
  { app: "Sudar", gateway: "razorpay" },
  { app: "Unman", gateway: "razorpay" },
  { app: "Bangalore Connect", gateway: "phonepe" }, // PhonePe only — keys pending
];

/** "Only Care" → "ONLY_CARE" for env var names (mirrors src/lib/connectors/index.ts). */
export function appEnvKey(app: string): string {
  return app.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export interface SliceFilter { app?: string; gateway?: Gateway }

/** Normalise an app name for forgiving matching: "Only Care" = "onlycare" = "ONLY_CARE". */
const normApp = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The slices matching an optional {app, gateway} filter (forgiving on app spelling/spacing). */
export function selectSlices(filter?: SliceFilter): GatewaySlice[] {
  return GATEWAY_SLICES.filter((s) =>
    (!filter?.app || normApp(s.app) === normApp(filter.app)) &&
    (!filter?.gateway || s.gateway === filter.gateway));
}

/** Distinct app names in slice order (for tool descriptions / validation hints). */
export const KNOWN_APPS: string[] = [...new Set(GATEWAY_SLICES.map((s) => s.app))];

export function razorpayCredsFor(app: string): RazorpayCreds | undefined {
  const k = appEnvKey(app);
  const keyId = envVar(`RAZORPAY_${k}_KEY_ID`);
  const keySecret = envVar(`RAZORPAY_${k}_KEY_SECRET`);
  return keyId && keySecret ? { keyId, keySecret } : undefined;
}

export function cashfreeCredsFor(app: string): CashfreeCreds | undefined {
  const k = appEnvKey(app);
  const appId = envVar(`CASHFREE_${k}_APP_ID`);
  const secretKey = envVar(`CASHFREE_${k}_SECRET_KEY`);
  return appId && secretKey ? { appId, secretKey } : undefined;
}

/** True if this slice's gateway auto-fetches (has an API + configured creds). */
export function isSliceConfigured(slice: GatewaySlice): boolean {
  switch (slice.gateway) {
    case "razorpay": return Boolean(razorpayCredsFor(slice.app));
    case "cashfree": return Boolean(cashfreeCredsFor(slice.app));
    case "phonepe": return false; // PhonePe has no settlement API — manual only (see isManualGateway)
  }
}

/**
 * PhonePe provides NO settlement-report API — its commission is read manually from the downloaded
 * settlement report and supplied via the `manualLines` tool argument. So PhonePe is never a "pending
 * keys" line; it's a MANUAL line. (Kept as a predicate so a second manual gateway can be added later.)
 */
export function isManualGateway(gateway: Gateway): boolean {
  return gateway === "phonepe";
}

/**
 * Known gateway (deductee) PANs — the counterparty is the same company regardless of app.
 *  - Cashfree: AAICP2912R (Cashfree Payments India Pvt Ltd — GSTIN 29AAICP2912R1ZR, sourced in-repo).
 *  - Razorpay/PhonePe: NOT on file. The filed sheet carried Innovfix's OWN PAN on the Razorpay line
 *    (an autofill error) — so we deliberately leave it null and FLAG, never inherit a guess.
 * Override per-gateway with GATEWAY_PAN_<GATEWAY> in .env once a PAN is confirmed with Shoyab.
 */
const GATEWAY_PAN: Record<Gateway, string | null> = {
  cashfree: "AAICP2912R",
  razorpay: null,
  phonepe: null,
};

export function gatewayPan(gateway: Gateway): string | null {
  return envVar(`GATEWAY_PAN_${gateway.toUpperCase()}`) ?? GATEWAY_PAN[gateway];
}

/** Human label for a gateway's counterparty (for the workbook/deductee name), best-effort. */
export const GATEWAY_LEGAL_NAME: Record<Gateway, string> = {
  cashfree: "Cashfree Payments India Private Limited",
  razorpay: "Razorpay Software Private Limited",
  phonepe: "PhonePe Payment Services",
};

/**
 * De-minimis cutoff (₹). The filed sheet ignored tiny fees ("Nobroker – ignore less amount",
 * ₹0.23 → ₹0.00). The exact cutoff is UNCONFIRMED with Shoyab, so we only FLAG below-threshold
 * commission lines — never drop them. Override with GATEWAY_DEMINIMIS_INR in .env.
 */
export function deMinimisInr(): number {
  const raw = envVar("GATEWAY_DEMINIMIS_INR");
  const v = raw == null ? NaN : Number(raw);
  return isFinite(v) && v >= 0 ? v : 1.0;
}

/** True if a configured gateway PAN equals Innovfix's own PAN — the exact filed-sheet autofill bug. */
export function panIsOwn(pan: string | null): boolean {
  return (pan ?? "").trim().toUpperCase() === OWN_PAN;
}
