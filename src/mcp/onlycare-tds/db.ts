/**
 * Shared read-only connection to the Only Care app DB (onlycare_admin), reached through the
 * durable SSH tunnel (local 3308 → analyst@43.204.113.99:3306) using the SELECT-only
 * `analytics_ro` login. Every data module here (payouts, kyc) opens through this helper so the
 * connection details live in exactly one place. The caller owns the connection — always end() it.
 */
import { createConnection, type Connection } from "mysql2/promise";
import { envVar } from "./env";

/** Open a connection to the Only Care app DB from APPDB_ONLY_CARE_TDS_URL. Read-only by grant. */
export async function getOnlyCareConnection(opts?: { namedPlaceholders?: boolean }): Promise<Connection> {
  const url = envVar("APPDB_ONLY_CARE_TDS_URL");
  if (!url) throw new Error("APPDB_ONLY_CARE_TDS_URL is not set (see .env)");
  const u = new URL(url);
  return createConnection({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    namedPlaceholders: opts?.namedPlaceholders ?? false,
  });
}
