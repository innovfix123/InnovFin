# Zoho Books Integration — Foundation Layer

*The generic, requirements-independent plumbing the accounting automation is built on. In place before Shoyab's requirements so that once they land, we build business logic — not scaffolding.*

**Status:** Foundation built & tested (typecheck clean, 18 unit tests). **Nothing writes to Zoho yet** — the layer is read-only + an idempotency ledger. Business logic (revenue booking, bills, reconciliation) comes after the accounting discovery (`_private/Innovfix - Accounting Workings - Master Reference (DISCOVERY DRAFT).md`).
*Last updated: 2026-06-21*

---

## What this is

`src/lib/zoho/` — a small, tested adapter over the Zoho Books v3 API, mirroring the proven shape of `src/lib/connectors/` (factory functions, injectable deps, fail-loud errors). It exists so the eventual booking code never touches `fetch`, OAuth, rate limits, or idempotency directly.

| File | Responsibility |
|---|---|
| `config.ts` | Resolves data-centre URLs + credentials from env. Defaults to the **India DC** (`www.zohoapis.in` / `accounts.zoho.in`). `isZohoConfigured()` / `getZohoConfig()`. |
| `auth.ts` | OAuth 2.0 refresh-token → 1-hour access token. In-process cache, refreshes ~2 min early, collapses concurrent refreshes into one call. |
| `client.ts` | The single HTTP choke-point: injects the OAuth header + `organization_id`, **enforces Zoho's rate limits in-process**, retries 429/5xx with backoff (honours `Retry-After`), walks pagination. |
| `resources.ts` | Read-only endpoints: `verifyConnection` (first smoke test), `getChartOfAccounts`, `listOrganizations`. |
| `sync-ledger.ts` | The idempotency backbone — records every intended write keyed by a deterministic `reference`, so re-running a month never double-books. |
| `index.ts` | Barrel re-export. Import from `@/lib/zoho`. |

---

## The verified API contract (India DC)

Confirmed against Zoho's official docs (not assumed — finance code verifies):

- **API base:** `https://www.zohoapis.in/books/v3`
- **OAuth token endpoint:** `POST https://accounts.zoho.in/oauth/v2/token` — params (`refresh_token`, `client_id`, `client_secret`, `grant_type=refresh_token`) in the **query string**, not a JSON body.
- **Access token:** valid **1 hour** (`expires_in: 3600`); sent as header `Authorization: Zoho-oauthtoken <token>` (header only — strict format).
- **`organization_id`** is required on every API call.
- **Rate limits (premium plan):** **10,000 calls/day, 100/minute/org, 10 concurrent** → HTTP 429 on breach.

> **Why the limits drive the architecture.** 100 calls/min ÷ would mean pushing Hima's ~307k monthly transactions individually takes **51+ hours** and instantly clutters the ledger. So the automation books **per-app summary entries** (the GST engine already computes those totals) — Zoho is the *book of record*, not a transaction warehouse. The client's limiter enforces this ceiling so we never get throttled in practice.

---

## Configuration

Add to `.env` (gitignored — never paste secrets in chat). Template in `.env.example`:

```
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_ORG_ID=
# ZOHO_DC=in                 # only if the org moves data centre
# ZOHO_SYNC_LEDGER_PATH=     # default .data/zoho-sync-ledger.json
```

**Getting the credentials** (one-time): create a **Self Client / Server-based app** at `https://api-console.zoho.in`, grant Zoho Books scopes (start read-only — `ZohoBooks.settings.READ`, `ZohoBooks.banking.READ`), generate a refresh token, and read the `organization_id` from `GET /organizations` (or `verifyConnection`). The refresh token is long-lived; the access token is fetched automatically.

---

## First run, once credentials are in `.env`

```ts
import { createZohoClient, verifyConnection, getChartOfAccounts } from "@/lib/zoho";

const zoho = createZohoClient();
console.log((await verifyConnection(zoho)).message);   // confirms token + org
const coa = await getChartOfAccounts(zoho);            // the live Chart of Accounts
```

`getChartOfAccounts` directly produces the **most important discovery artifact** — the real CoA the automation must map to (the `[EXPORT]` step in the Accounting Master Reference).

---

## The idempotency contract (sync ledger)

Zoho has no idempotency keys, so this layer provides them. Every write follows:

1. Build a deterministic `reference` — `makeReference("REV", "Hima", "2026-05")` → `REV-HIMA-2026-05`.
2. `if (await ledger.wasPosted(reference)) skip;` — a re-run never double-books.
3. `upsert({ ..., status: "pending", payloadHash })` → post to Zoho → `upsert({ status: "posted", zohoId })` (or `"failed"`).
4. `payloadHash` records *what* was posted; if the source numbers are re-derived and the hash differs, that's a real change to surface — not a silent second post.

**Storage** is behind the `SyncLedger` interface. Default = a file-backed JSON store (`.data/zoho-sync-ledger.json`, atomic writes, zero deps, audit-readable) — adequate for a single-process monthly batch. **Deliberately not Prisma yet:** Prisma 7 is a major rewrite (driver adapters + `prisma.config.ts` + deprecated generator), and the persistence target (SQLite vs the MariaDB already in the XAMPP stack) is a decision for the build phase. Swapping the implementation won't touch any caller.

---

## Design notes

- **Everything timing-related is injectable** (`fetchImpl`, `sleep`, `now`, `auth`) — the limiter and retry logic are unit-tested without real waits or a live org. See `zoho.test.ts`, `sync-ledger.test.ts`.
- **Read-only on purpose.** No write endpoints exist yet — they're added per-module once requirements define the exact journal/bill shapes, each behind the sync ledger and locked to a validated month (the GST playbook).
- **No API routes yet.** When we add them, read `node_modules/next/dist/docs/` first — this repo's Next.js 16 has breaking changes from older conventions (`AGENTS.md`).

---

*Companion to the GST docs. Build sequence and scope live in the Accounting Master Reference (`_private/`) and memory.*
