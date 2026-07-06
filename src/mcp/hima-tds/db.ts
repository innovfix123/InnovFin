/**
 * Shared read-only connection to the Hima app DB (himaapp), reached through the durable SSH
 * tunnel (hima-tunnel.service, autossh → local 127.0.0.1:3307 → the remote himaapp) using the
 * PAN-scoped SELECT-only `tdsapp_ro` login. Grant (verified live) = SELECT on exactly two views:
 *   - tds_creator_payouts_v : one row per paid creator payout (pre-filtered to paid), denormalized
 *                             (creator_name + pan + pan_name already in the view — no joins).
 *   - payout_charges_v      : the fee slab (min/max amount → deduction_charge, tds_percentage).
 * The raw users/withdrawals PII is deliberately isolated from this login. Every data module here
 * opens through this helper so the connection details live in one place. The caller owns the
 * connection — always end() it.
 */
import { createConnection, type Connection } from "mysql2/promise";
import { envVar } from "./env";

/** Open a connection to the Hima app DB from APPDB_HIMA_TDS_URL. Read-only by grant. */
export async function getHimaConnection(opts?: { namedPlaceholders?: boolean }): Promise<Connection> {
  const url = envVar("APPDB_HIMA_TDS_URL");
  if (!url) throw new Error("APPDB_HIMA_TDS_URL is not set (see .env)");
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
