/**
 * Sync ledger — the idempotency backbone for every write to Zoho Books.
 *
 * THE RULE: nothing is posted to Zoho without first recording our intent here, keyed
 * by a deterministic `reference` (e.g. "REV-HIMA-2026-05"). Before posting we check
 * the ledger; if that reference is already `posted`, we skip — so re-running a month
 * NEVER double-books. Zoho has no idempotency keys of its own, so this is how we make
 * every sync safely re-runnable and dry-runnable.
 *
 * `payloadHash` records WHAT we posted. If the source numbers are later re-derived and
 * the hash differs from what's on file, that's a real change to surface for review —
 * not a silent second post.
 *
 * Storage is behind the `SyncLedger` interface. The default is a file-backed JSON store
 * (zero deps, durable, human-readable, fine for a single-process monthly batch). It can
 * be swapped for Prisma/SQLite or MariaDB at the build phase without touching callers.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SyncStatus = "pending" | "posted" | "failed" | "skipped";

export interface SyncRecord {
  /** Deterministic idempotency key, e.g. "REV-HIMA-2026-05". Unique. */
  reference: string;
  /** "revenue" | "expense" | "settlement" | ... */
  kind: string;
  /** App / vendor / bank — whatever the entry is about. */
  entityKey: string;
  /** Accounting period "YYYY-MM". */
  period: string;
  /** Hash of the payload we posted (detects changed source numbers on re-run). */
  payloadHash: string;
  /** Zoho module the entry lives in, e.g. "journals", "bills". */
  zohoModule?: string;
  /** Id Zoho returned on a successful post. */
  zohoId?: string;
  status: SyncStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type SyncUpsert = Pick<SyncRecord, "reference" | "kind" | "entityKey" | "period" | "payloadHash" | "status"> &
  Partial<Pick<SyncRecord, "zohoModule" | "zohoId" | "error">>;

export interface SyncLedger {
  get(reference: string): Promise<SyncRecord | undefined>;
  /** True only if a record exists AND its status is "posted". */
  wasPosted(reference: string): Promise<boolean>;
  upsert(rec: SyncUpsert): Promise<SyncRecord>;
  all(): Promise<SyncRecord[]>;
}

/** Deterministic SHA-256 of an arbitrary payload (stable key order). */
export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** Build a deterministic reference from parts, e.g. makeReference("REV", "Only Care", "2026-05"). */
export function makeReference(...parts: Array<string | number>): string {
  return parts
    .map((p) => String(p).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function applyUpsert(existing: SyncRecord | undefined, rec: SyncUpsert, nowIso: string): SyncRecord {
  return {
    ...existing,
    ...rec,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/** In-memory ledger — for tests and dry-runs. */
export function createMemoryLedger(seed: SyncRecord[] = []): SyncLedger {
  const map = new Map<string, SyncRecord>(seed.map((r) => [r.reference, r]));
  return {
    async get(reference) {
      return map.get(reference);
    },
    async wasPosted(reference) {
      return map.get(reference)?.status === "posted";
    },
    async upsert(rec) {
      const next = applyUpsert(map.get(rec.reference), rec, new Date().toISOString());
      map.set(rec.reference, next);
      return next;
    },
    async all() {
      return [...map.values()];
    },
  };
}

const DEFAULT_LEDGER_PATH = process.env.ZOHO_SYNC_LEDGER_PATH || path.join(process.cwd(), ".data", "zoho-sync-ledger.json");

/** File-backed ledger — atomic writes (temp + rename), survives restarts, easy to audit. */
export function createFileLedger(filePath: string = DEFAULT_LEDGER_PATH): SyncLedger {
  let cache: Map<string, SyncRecord> | null = null;

  async function load(): Promise<Map<string, SyncRecord>> {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const arr = JSON.parse(raw) as SyncRecord[];
      cache = new Map(arr.map((r) => [r.reference, r]));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      cache = new Map();
    }
    return cache;
  }

  async function persist(map: Map<string, SyncRecord>): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...map.values()], null, 2), "utf8");
    await fs.rename(tmp, filePath);
  }

  return {
    async get(reference) {
      return (await load()).get(reference);
    },
    async wasPosted(reference) {
      return (await load()).get(reference)?.status === "posted";
    },
    async upsert(rec) {
      const map = await load();
      const next = applyUpsert(map.get(rec.reference), rec, new Date().toISOString());
      map.set(rec.reference, next);
      await persist(map);
      return next;
    },
    async all() {
      return [...(await load()).values()];
    },
  };
}

/** Default ledger used by the app (file-backed). */
export function getSyncLedger(): SyncLedger {
  return createFileLedger();
}
