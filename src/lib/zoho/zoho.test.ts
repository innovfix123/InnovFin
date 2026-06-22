import { describe, it, expect } from "vitest";
import { getZohoConfig, isZohoConfigured } from "./config";
import { createZohoAuth } from "./auth";
import { createZohoClient } from "./client";
import { ZohoApiError } from "./types";

const FULL = {
  ZOHO_CLIENT_ID: "cid",
  ZOHO_CLIENT_SECRET: "secret",
  ZOHO_REFRESH_TOKEN: "rt",
  ZOHO_ORG_ID: "org123",
};

/** Minimal Response stand-in covering the bits client/auth use (ok, status, headers.get, json, text). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>() as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fakeAuth = { getAccessToken: async () => "AT", reset() {} };

// ---------------- config ----------------

describe("zoho config", () => {
  it("isZohoConfigured reflects presence of all required keys", () => {
    expect(isZohoConfigured({})).toBe(false);
    expect(isZohoConfigured({ ...FULL, ZOHO_ORG_ID: "" })).toBe(false);
    expect(isZohoConfigured(FULL)).toBe(true);
  });

  it("defaults to the India data centre", () => {
    const c = getZohoConfig(FULL);
    expect(c.apiBase).toBe("https://www.zohoapis.in/books/v3");
    expect(c.accountsBase).toBe("https://accounts.zoho.in");
    expect(c.dc).toBe("in");
  });

  it("honours ZOHO_DC and explicit base overrides", () => {
    expect(getZohoConfig({ ...FULL, ZOHO_DC: "com" }).apiBase).toBe("https://www.zohoapis.com/books/v3");
    const o = getZohoConfig({ ...FULL, ZOHO_API_BASE: "http://localhost:9/books/v3", ZOHO_ACCOUNTS_BASE: "http://localhost:9" });
    expect(o.apiBase).toBe("http://localhost:9/books/v3");
    expect(o.accountsBase).toBe("http://localhost:9");
  });

  it("throws naming the missing key", () => {
    expect(() => getZohoConfig({ ...FULL, ZOHO_ORG_ID: "" })).toThrow(/ZOHO_ORG_ID/);
  });
});

// ---------------- auth ----------------

describe("zoho auth", () => {
  const cfg = getZohoConfig(FULL);

  it("fetches, then caches the access token", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ access_token: "AT1", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const auth = createZohoAuth({ config: cfg, fetchImpl, now: () => 0 });
    expect(await auth.getAccessToken()).toBe("AT1");
    expect(await auth.getAccessToken()).toBe("AT1");
    expect(calls).toBe(1);
  });

  it("refreshes once the token nears expiry", async () => {
    const tokens = ["AT1", "AT2"];
    let calls = 0;
    let t = 0;
    const fetchImpl = (async () => jsonResponse({ access_token: tokens[calls++], expires_in: 3600 })) as unknown as typeof fetch;
    const auth = createZohoAuth({ config: cfg, fetchImpl, now: () => t });
    expect(await auth.getAccessToken()).toBe("AT1");
    t = 3_600_000; // an hour later
    expect(await auth.getAccessToken()).toBe("AT2");
    expect(calls).toBe(2);
  });

  it("throws a clear error on an OAuth failure payload", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "invalid_client" }, 400)) as unknown as typeof fetch;
    const auth = createZohoAuth({ config: cfg, fetchImpl, now: () => 0 });
    await expect(auth.getAccessToken()).rejects.toThrow(/invalid_client/);
  });

  it("collapses concurrent refreshes into one call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ access_token: "AT", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const auth = createZohoAuth({ config: cfg, fetchImpl, now: () => 0 });
    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
    expect([a, b]).toEqual(["AT", "AT"]);
    expect(calls).toBe(1);
  });
});

// ---------------- client ----------------

describe("zoho client", () => {
  const cfg = getZohoConfig(FULL);
  const base = { config: cfg, sleep: async () => {}, now: () => 0, auth: fakeAuth };

  it("injects organization_id + the OAuth header and returns parsed JSON", async () => {
    let captured: { url: unknown; init: RequestInit } | undefined;
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({ code: 0, message: "ok", chartofaccounts: [] });
    }) as unknown as typeof fetch;
    const c = createZohoClient({ ...base, fetchImpl });
    const data = await c.get<{ message: string }>("/chartofaccounts");
    expect(String(captured!.url)).toContain("organization_id=org123");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Zoho-oauthtoken AT");
    expect(data.message).toBe("ok");
  });

  it("retries on 429 then succeeds", async () => {
    const seq = [jsonResponse({}, 429), jsonResponse({ code: 0, message: "ok" })];
    let i = 0;
    const fetchImpl = (async () => seq[i++]) as unknown as typeof fetch;
    const c = createZohoClient({ ...base, fetchImpl });
    const data = await c.get<{ message: string }>("/x");
    expect(data.message).toBe("ok");
    expect(i).toBe(2);
  });

  it("throws ZohoApiError after exhausting retries", async () => {
    const fetchImpl = (async () => jsonResponse({ code: 44, message: "rate limit" }, 429)) as unknown as typeof fetch;
    const c = createZohoClient({ ...base, fetchImpl, maxRetries: 2 });
    await expect(c.get("/x")).rejects.toThrow(ZohoApiError);
  });

  it("walks pagination via page_context.has_more_page", async () => {
    const pages = [
      jsonResponse({ code: 0, message: "ok", items: [{ a: 1 }], page_context: { page: 1, per_page: 200, has_more_page: true } }),
      jsonResponse({ code: 0, message: "ok", items: [{ a: 2 }], page_context: { page: 2, per_page: 200, has_more_page: false } }),
    ];
    let i = 0;
    const fetchImpl = (async () => pages[i++]) as unknown as typeof fetch;
    const c = createZohoClient({ ...base, fetchImpl });
    expect(await c.list("/items", "items")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("throttles when the per-minute window is full", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
    const fetchImpl = (async () => jsonResponse({ code: 0, message: "ok" })) as unknown as typeof fetch;
    const c = createZohoClient({ config: cfg, auth: fakeAuth, fetchImpl, sleep, now: () => clock, perMinute: 2, maxConcurrent: 5 });
    await c.get("/a");
    await c.get("/b");
    expect(sleeps).toHaveLength(0);
    await c.get("/c"); // 3rd in the same minute must wait out the window
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
  });
});
