import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this module's location (src/mcp/onlycare-tds → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Read a key from process.env, falling back to parsing the repo `.env` — so the MCP server
 * runs standalone (via tsx) without a dotenv dependency or a specific launcher.
 */
function unquote(v: string): string {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function envVar(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    for (const line of readFileSync(resolve(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) return unquote(m[2]);
    }
  } catch {
    /* no .env — rely on process.env only */
  }
  return undefined;
}

/**
 * All env keys starting with `prefix`, from process.env and the repo `.env` (process.env wins).
 * Used to discover per-user MCP tokens (ONLYCARE_MCP_TOKEN_<USER>) without a hardcoded user list.
 */
export function envVarsWithPrefix(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1].startsWith(prefix)) out[m[1]] = unquote(m[2]);
    }
  } catch {
    /* no .env — rely on process.env only */
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v) out[k] = v;
  }
  return out;
}
