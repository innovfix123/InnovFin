/**
 * Zoho Books integration — foundation layer.
 *
 * Generic, requirements-independent plumbing: OAuth, a rate-limited/retrying HTTP
 * client, read-only resources, and config. Business logic (revenue booking, bills,
 * reconciliation) is built on top of this once the accounting discovery is done.
 *
 * Usage once .env has ZOHO_* creds:
 *   import { createZohoClient, verifyConnection, getChartOfAccounts } from "@/lib/zoho";
 *   const zoho = createZohoClient();
 *   console.log(await verifyConnection(zoho));
 *   const coa = await getChartOfAccounts(zoho);
 */
export * from "./config";
export * from "./types";
export * from "./auth";
export * from "./client";
export * from "./resources";
export * from "./sync-ledger";
