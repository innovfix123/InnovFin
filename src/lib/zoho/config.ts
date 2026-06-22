/**
 * Zoho Books API configuration — data-centre URLs + credentials from env.
 *
 * Innovfix is on the India data centre (.in). All app sales are intra-state
 * Karnataka, the company files Indian GST, and the Zoho org is hosted in India,
 * so `in` is the default DC. Override with ZOHO_DC if that ever changes.
 *
 * Required env (see .env.example):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID
 * Optional:
 *   ZOHO_DC (default "in"), ZOHO_API_BASE / ZOHO_ACCOUNTS_BASE (full overrides, e.g. tests)
 */

export type ZohoDataCenter = "in" | "com" | "eu" | "com.au" | "jp" | "ca" | "com.cn" | "sa";

/** API host per data centre — `https://<host>/books/v3`. */
const API_HOST: Record<ZohoDataCenter, string> = {
  in: "www.zohoapis.in",
  com: "www.zohoapis.com",
  eu: "www.zohoapis.eu",
  "com.au": "www.zohoapis.com.au",
  jp: "www.zohoapis.jp",
  ca: "www.zohoapis.ca",
  "com.cn": "www.zohoapis.com.cn",
  sa: "www.zohoapis.sa",
};

/** OAuth / accounts host per data centre — `https://<host>/oauth/v2/token`. */
const ACCOUNTS_HOST: Record<ZohoDataCenter, string> = {
  in: "accounts.zoho.in",
  com: "accounts.zoho.com",
  eu: "accounts.zoho.eu",
  "com.au": "accounts.zoho.com.au",
  jp: "accounts.zoho.jp",
  ca: "accounts.zoho.ca",
  "com.cn": "accounts.zoho.com.cn",
  sa: "accounts.zoho.sa",
};

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  dc: ZohoDataCenter;
  /** e.g. https://www.zohoapis.in/books/v3 */
  apiBase: string;
  /** e.g. https://accounts.zoho.in */
  accountsBase: string;
}

type Env = Record<string, string | undefined>;

const REQUIRED = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"] as const;

function resolveDc(env: Env): ZohoDataCenter {
  const dc = (env.ZOHO_DC ?? "in").trim() as ZohoDataCenter;
  if (!(dc in API_HOST)) {
    throw new Error(`Invalid ZOHO_DC "${dc}" (expected one of ${Object.keys(API_HOST).join(", ")})`);
  }
  return dc;
}

/** True when all required Zoho credentials are present — mirrors connectors' `isConfigured()`. */
export function isZohoConfigured(env: Env = process.env): boolean {
  return REQUIRED.every((k) => Boolean(env[k]?.trim()));
}

/** Resolve the full config, or throw a precise error naming the first missing key. */
export function getZohoConfig(env: Env = process.env): ZohoConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new Error(`Zoho Books not configured — missing env: ${missing.join(", ")} (see .env.example)`);
  }
  const dc = resolveDc(env);
  return {
    clientId: env.ZOHO_CLIENT_ID!.trim(),
    clientSecret: env.ZOHO_CLIENT_SECRET!.trim(),
    refreshToken: env.ZOHO_REFRESH_TOKEN!.trim(),
    orgId: env.ZOHO_ORG_ID!.trim(),
    dc,
    apiBase: env.ZOHO_API_BASE?.trim() || `https://${API_HOST[dc]}/books/v3`,
    accountsBase: env.ZOHO_ACCOUNTS_BASE?.trim() || `https://${ACCOUNTS_HOST[dc]}`,
  };
}
