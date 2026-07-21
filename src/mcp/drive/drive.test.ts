/**
 * Offline unit tests for the Google Drive tools — the parts that don't need a live Drive:
 *  1. USER-OAUTH outbound auth (the mode we run on): refresh_token grant, caching, partial-config guard.
 *  2. SERVICE-ACCOUNT outbound auth (fallback): the RS256 JWT-bearer assertion is well-formed, correctly
 *     signed and carries the right claims; scope widens only when DRIVE_MCP_WRITE is on.
 *  3. Tool registration: 6 read tools, +6 write tools behind the flag, all mounted on a host server
 *     under the drive_ prefix without collisions — including onto the real gstr2b-estimate server.
 *
 * No network: the token exchange fetch is stubbed and the SA assertion it receives is cryptographically
 * verified against the throwaway key we signed with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A throwaway RSA keypair so we can both sign (via the module) and verify (here) the assertion.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_EMAIL = "drive-mcp@innovfin-drive.iam.gserviceaccount.com";
const SA_JSON = JSON.stringify({
  client_email: SA_EMAIL,
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

const OAUTH_KEYS = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"] as const;
const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * envVar() falls back to the repo `.env`, so once the server is really configured these tests would
 * read the OPERATOR's live credentials instead of their fixtures — "no credential configured" and
 * "write disabled" cases could never be exercised again. Isolate exactly the keys the tests drive;
 * every other key (DRIVE_FOLDER_ID etc.) still resolves normally.
 */
const ISOLATED_KEYS = new Set<string>([...OAUTH_KEYS, "GOOGLE_SA_KEY_JSON", "GOOGLE_SA_KEY_FILE", "DRIVE_MCP_WRITE"]);
vi.mock("./env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env")>();
  const envVar = (key: string): string | undefined =>
    ISOLATED_KEYS.has(key) ? process.env[key] || undefined : actual.envVar(key);
  return {
    ...actual,
    envVar,
    writeEnabled: () => /^(1|true|yes|on)$/i.test((envVar("DRIVE_MCP_WRITE") ?? "").trim()),
  };
});

function clearGoogleEnv(): void {
  for (const k of OAUTH_KEYS) process.env[k] = "";
  process.env.GOOGLE_SA_KEY_JSON = "";
  process.env.GOOGLE_SA_KEY_FILE = "";
}

describe("google-auth — user OAuth (refresh token)", () => {
  beforeEach(() => {
    clearGoogleEnv();
    process.env.GOOGLE_OAUTH_CLIENT_ID = "123.apps.googleusercontent.com";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "GOCSPX-unit-test";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "1//unit-test-refresh";
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearGoogleEnv();
  });

  it("prefers user OAuth over the service account when both are configured", async () => {
    process.env.GOOGLE_SA_KEY_JSON = SA_JSON;
    vi.resetModules();
    const { credentialMode } = await import("./google-auth");
    expect(credentialMode()).toBe("user-oauth");
  });

  it("exchanges the refresh token for an access token and caches it", async () => {
    let sent = new URLSearchParams();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      sent = new URLSearchParams(init.body as string);
      return { ok: true, status: 200, json: async () => ({ access_token: "ya29.oauth", expires_in: 3599 }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("./google-auth");
    expect(await getAccessToken()).toBe("ya29.oauth");
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("1//unit-test-refresh");
    expect(sent.get("client_id")).toBe("123.apps.googleusercontent.com");
    expect(sent.get("client_secret")).toBe("GOCSPX-unit-test");
    // No SA assertion is involved in this mode.
    expect(sent.get("assertion")).toBeNull();

    // Cached: a second call does not hit the network again.
    expect(await getAccessToken()).toBe("ya29.oauth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a Google error body instead of a bare status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }) as Response),
    );
    const { getAccessToken } = await import("./google-auth");
    await expect(getAccessToken()).rejects.toThrow(/user-oauth token exchange failed \(400\)[\s\S]*invalid_grant/);
  });

  it("rejects a half-configured OAuth credential rather than silently falling back", async () => {
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "";
    vi.resetModules();
    const { oauthCreds } = await import("./google-auth");
    expect(() => oauthCreds()).toThrow(/GOOGLE_OAUTH_REFRESH_TOKEN|all be set/);
  });
});

describe("google-auth — service account (JWT-bearer fallback)", () => {
  beforeEach(() => {
    clearGoogleEnv();
    process.env.GOOGLE_SA_KEY_JSON = SA_JSON;
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearGoogleEnv();
    delete process.env.DRIVE_MCP_WRITE;
  });

  it("reports service-account mode and exposes the SA email for the 'share the folder with' hint", async () => {
    const { credentialMode, serviceAccountEmail } = await import("./google-auth");
    expect(credentialMode()).toBe("service-account");
    expect(serviceAccountEmail()).toBe(SA_EMAIL);
  });

  it("signs a valid RS256 assertion with correct claims and exchanges it for a cached token", async () => {
    let capturedAssertion = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as string);
      capturedAssertion = body.get("assertion") ?? "";
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      return { ok: true, status: 200, json: async () => ({ access_token: "ya29.test-token", expires_in: 3600 }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("./google-auth");
    expect(await getAccessToken()).toBe("ya29.test-token");

    const [h, p, sig] = capturedAssertion.split(".");
    expect(JSON.parse(b64urlToBuf(h).toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(b64urlToBuf(p).toString());
    expect(claims.iss).toBe(SA_EMAIL);
    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.exp - claims.iat).toBe(3600);

    // Signature actually verifies against the public key.
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, b64urlToBuf(sig))).toBe(true);

    // Token is cached.
    expect(await getAccessToken()).toBe("ya29.test-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests the full drive scope only when DRIVE_MCP_WRITE is enabled", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    vi.resetModules();
    let scope = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const assertion = new URLSearchParams(init.body as string).get("assertion")!;
        scope = JSON.parse(b64urlToBuf(assertion.split(".")[1]).toString()).scope;
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) } as Response;
      }),
    );
    const { getAccessToken } = await import("./google-auth");
    await getAccessToken();
    expect(scope).toBe("https://www.googleapis.com/auth/drive");
  });

  it("fails with an actionable message when no usable credential is configured", async () => {
    clearGoogleEnv();
    vi.resetModules();
    const { getAccessToken } = await import("./google-auth");
    // The error must name the fix — never a bare ENOENT — and must reject rather than hang.
    await expect(getAccessToken()).rejects.toThrow(/drive:auth/i);
  });
});

describe("tool registration (drive_ prefix + write gating)", () => {
  const host = () => new McpServer({ name: "test-host", version: "0.0.0" });
  afterEach(() => {
    delete process.env.DRIVE_MCP_WRITE;
    vi.resetModules();
  });

  it("exposes only the 6 read tools when write is disabled", async () => {
    delete process.env.DRIVE_MCP_WRITE;
    vi.resetModules();
    const { activeDriveTools, DRIVE_WRITE_TOOLS, registerDriveTools } = await import("./factory");
    const tools = activeDriveTools();
    expect(tools).toHaveLength(6);
    for (const w of DRIVE_WRITE_TOOLS) expect(tools).not.toContain(w);
    expect(() => registerDriveTools(host())).not.toThrow();
  });

  it("adds the 6 write tools when DRIVE_MCP_WRITE is enabled, and all 12 register cleanly", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    vi.resetModules();
    const { activeDriveTools, registerDriveTools } = await import("./factory");
    const tools = activeDriveTools();
    expect(tools).toHaveLength(12);
    expect(tools).toEqual(
      expect.arrayContaining([
        "drive_create_folder",
        "drive_upload_text_file",
        "drive_update_file_content",
        "drive_rename_file",
        "drive_move_file",
        "drive_trash_file",
      ]),
    );
    expect(() => registerDriveTools(host())).not.toThrow(); // 12 names, no collision
  });

  it("every tool name is drive_-prefixed, so it cannot collide with a host server's tools", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    vi.resetModules();
    const { activeDriveTools } = await import("./factory");
    for (const t of activeDriveTools()) expect(t).toMatch(/^drive_/);
  });

  it("mounts onto the real gstr2b-estimate server alongside the itc_ tools", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    vi.resetModules();
    const { buildGstr2bEstimateServer, gstr2bEstimateTools, ITC_TOOLS } = await import("../gstr2b-estimate/factory");
    expect(() => buildGstr2bEstimateServer()).not.toThrow();
    const all = gstr2bEstimateTools();
    expect(all).toHaveLength(ITC_TOOLS.length + 12);
    expect(all).toEqual(expect.arrayContaining([...ITC_TOOLS, "drive_list_files", "drive_trash_file"]));
    expect(new Set(all).size).toBe(all.length); // no duplicate tool names on the merged server
  });

  it("tells the client to fall back to Drive when the ITC registry has no answer", async () => {
    // Without this the two tool families read as unrelated and a caller reports "not found" for a
    // document that is sitting in the connected folder. The client only ever sees these instructions
    // at initialize, so losing them is silent — assert the parts that carry the behaviour.
    vi.resetModules();
    const { buildGstr2bEstimateServer } = await import("../gstr2b-estimate/factory");
    const instructions = (buildGstr2bEstimateServer().server as unknown as { _instructions?: string })._instructions;
    expect(instructions).toBeTruthy();
    expect(instructions).toMatch(/do not stop at "not found"/i);
    expect(instructions).toMatch(/drive_search_files/);
    expect(instructions).toMatch(/itc_/);
    expect(instructions).toMatch(/which source a figure came from/i); // attribution, so the two never blend
  });
});

describe("answering from a file — the failure modes that return wrong data quietly", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** Call a tool the way a real client does — over the protocol — with drive-client stubbed. */
  async function callTool(name: string, args: Record<string, unknown>, stub: Record<string, unknown>) {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("./drive-client")>("./drive-client");
    vi.doMock("./drive-client", () => ({ ...actual, ...stub }));
    const { registerDriveTools } = await import("./factory");
    const server = registerDriveTools(new McpServer({ name: "t", version: "0.0.0" }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return JSON.parse(res.content[0].text);
  }

  it("reads EVERY tab of a Google Sheet, not the first one wearing the requested tab's name", async () => {
    // CSV export returns only tab 1. The old code labelled it with whatever tab was asked for, so a
    // request for "Summary" came back as tab 1's rows called "Summary" — wrong numbers, no error.
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a"], [1]]), "First");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["total"], [42]]), "Summary");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const exported: string[] = [];
    const out = await callTool(
      "drive_read_sheet",
      { fileId: "sheet1", sheet: "Summary" },
      {
        getMetadata: async () => ({ id: "sheet1", name: "S", kind: "file", mimeType: "application/vnd.google-apps.spreadsheet" }),
        exportFile: async (_id: string, mime: string) => {
          exported.push(mime);
          return buf;
        },
      },
    );

    expect(exported).toEqual(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    expect(exported).not.toContain("text/csv");
    expect(out.allTabs).toEqual(["First", "Summary"]);
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0].name).toBe("Summary");
    expect(out.tabs[0].csv).toContain("42"); // the requested tab's data, not tab 1's
  });

  it("surfaces a wrong tab name as an error with the real tab list, instead of guessing", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a"], [1]]), "Actuals");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const out = await callTool(
      "drive_read_sheet",
      { fileId: "x", sheet: "Nope" },
      {
        getMetadata: async () => ({ id: "x", name: "S", kind: "file", mimeType: "application/vnd.ms-excel" }),
        downloadBytes: async () => buf,
      },
    );
    expect(out.error).toBe("sheet_not_found");
    expect(out.availableTabs).toEqual(["Actuals"]);
  });

  it("reports a capped search as capped, so the list is not read as every match", async () => {
    const out = await callTool(
      "drive_search_files",
      { query: "bank statement" },
      { searchSubtree: async () => ({ files: [{ id: "1", name: "x", kind: "file", mimeType: "text/plain" }], capped: true }) },
    );
    expect(out.capped).toBe(true);
    expect(out.note).toMatch(/narrow the query/i);
  });
});
