/**
 * Zoho Books HTTP client — the single choke-point every API call goes through.
 *
 * Responsibilities (all the reasons you don't call fetch() directly):
 *  - Injects the OAuth header + `organization_id` on every request.
 *  - Enforces Zoho's limits IN-PROCESS so we never get throttled:
 *      premium = 10,000/day, 100/min/org, 10 concurrent (HTTP 429 on breach).
 *    These numbers are why we push per-app SUMMARY entries, never raw transactions.
 *  - Retries 429 / 5xx with exponential backoff (honours Retry-After).
 *  - Walks pagination (`page_context.has_more_page`) so callers get the full list.
 *
 * Everything timing-related (sleep, clock, fetch, token) is injectable so the
 * limiter and retry logic are unit-testable without real waits or a live org.
 */
import { getZohoConfig, type ZohoConfig } from "./config";
import { createZohoAuth, type ZohoAuth } from "./auth";
import { ZohoApiError, type ZohoListResponse } from "./types";

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Concurrency cap + sliding-1-minute-window rate limit. */
class Limiter {
  private active = 0;
  private hits: number[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly perMinute: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  async acquire(): Promise<void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
    this.active++;
    for (;;) {
      const t = this.now();
      const cutoff = t - 60_000;
      while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
      if (this.hits.length < this.perMinute) {
        this.hits.push(t);
        return;
      }
      await this.sleep(Math.max(0, this.hits[0] + 60_000 - t + 5));
    }
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

export interface ZohoClientOptions {
  config?: ZohoConfig;
  auth?: ZohoAuth;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Default 10 (premium concurrent cap). */
  maxConcurrent?: number;
  /** Default 90 (a safety margin under Zoho's 100/min). */
  perMinute?: number;
  /** Default 4 retry attempts on 429 / 5xx. */
  maxRetries?: number;
}

export interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Set false for endpoints that don't take organization_id (e.g. /organizations). */
  orgScoped?: boolean;
}

export interface ZohoClient {
  config: ZohoConfig;
  request<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  get<T = unknown>(path: string, params?: RequestOptions["params"], opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body: unknown, opts?: RequestOptions): Promise<T>;
  /** GET that walks all pages and returns the records under `key`. */
  list<T = unknown>(path: string, key: string, params?: RequestOptions["params"]): Promise<T[]>;
}

export function createZohoClient(opts: ZohoClientOptions = {}): ZohoClient {
  const config = opts.config ?? getZohoConfig();
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const maxRetries = opts.maxRetries ?? 4;
  const auth = opts.auth ?? createZohoAuth({ config, fetchImpl: doFetch, now });
  const limiter = new Limiter(opts.maxConcurrent ?? 10, opts.perMinute ?? 90, sleep, now);

  async function request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    const url = new URL(config.apiBase + path);
    if (ro.orgScoped !== false) url.searchParams.set("organization_id", config.orgId);
    for (const [k, v] of Object.entries(ro.params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      let res: Response;
      try {
        const token = await auth.getAccessToken();
        res = await doFetch(url.toString(), {
          method,
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            ...(ro.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
        });
      } finally {
        limiter.release();
      }

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
        await sleep(backoff);
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        const err = json as { code?: number; message?: string } | undefined;
        throw new ZohoApiError(res.status, err?.code, err?.message ?? text.slice(0, 300));
      }
      return json as T;
    }
  }

  async function list<T>(path: string, key: string, params: RequestOptions["params"] = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const data = await request<ZohoListResponse<T>>("GET", path, { params: { ...params, page, per_page: 200 } });
      const records = (data[key] as T[] | undefined) ?? [];
      out.push(...records);
      if (!data.page_context?.has_more_page) break;
    }
    return out;
  }

  return {
    config,
    request,
    get: (path, params, opts) => request("GET", path, { ...opts, params }),
    post: (path, body, opts) => request("POST", path, { ...opts, body }),
    list,
  };
}
