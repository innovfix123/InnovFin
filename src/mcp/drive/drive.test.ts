/**
 * Offline unit tests for the Google Drive tools — the parts that don't need a live Drive:
 *  1. USER-OAUTH outbound auth (the mode we run on): refresh_token grant, caching, partial-config guard.
 *  2. SERVICE-ACCOUNT outbound auth (fallback): the RS256 JWT-bearer assertion is well-formed, correctly
 *     signed and carries the right claims; scope widens only when DRIVE_MCP_WRITE is on.
 *  3. Tool registration: 7 read tools, +6 write tools behind the flag, all mounted on a host server
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

  it("exposes only the 7 read tools when write is disabled", async () => {
    delete process.env.DRIVE_MCP_WRITE;
    vi.resetModules();
    const { activeDriveTools, DRIVE_WRITE_TOOLS, registerDriveTools } = await import("./factory");
    const tools = activeDriveTools();
    expect(tools).toHaveLength(7);
    for (const w of DRIVE_WRITE_TOOLS) expect(tools).not.toContain(w);
    expect(() => registerDriveTools(host())).not.toThrow();
  });

  it("adds the 6 write tools when DRIVE_MCP_WRITE is enabled, and all 13 register cleanly", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    vi.resetModules();
    const { activeDriveTools, registerDriveTools } = await import("./factory");
    const tools = activeDriveTools();
    expect(tools).toHaveLength(13);
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
    expect(() => registerDriveTools(host())).not.toThrow(); // 13 names, no collision
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
    expect(all).toHaveLength(ITC_TOOLS.length + 13);
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

  it("reads a photo/scan via Google conversion instead of answering 'open the link'", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    const out = await callTool(
      "drive_read_file",
      { fileId: "img1" },
      {
        getMetadata: async () => ({ id: "img1", name: "receipt.jpg", kind: "file", mimeType: "image/jpeg" }),
        readViaGoogleConversion: async () => "VISTA PRINT  Total 1,299.00",
      },
    );
    expect(out.extractedAs).toBe("google-ocr");
    expect(out.content).toContain("1,299.00");
    delete process.env.DRIVE_MCP_WRITE;
  });

  it("does not hand back a .docx/.xlsx as UTF-8-decoded ZIP bytes", async () => {
    // Office mime types contain "openxmlformats", which the old loose /xml/ text test matched — so a
    // Word file came back as "PK...word/_rels..." with no error, reading as a successful extraction.
    process.env.DRIVE_MCP_WRITE = "1";
    const out = await callTool(
      "drive_read_file",
      { fileId: "doc1" },
      {
        getMetadata: async () => ({
          id: "doc1",
          name: "Invoice.docx",
          kind: "file",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        downloadBytes: async () => Buffer.from("PKbinary-zip-bytes"),
        readViaGoogleConversion: async () => "INVOICE  Aditya Sharma  1,25,000",
      },
    );
    expect(out.content).not.toMatch(/^PK/);
    expect(out.extractedAs).toBe("google-ocr");
    expect(out.content).toContain("1,25,000");
    delete process.env.DRIVE_MCP_WRITE;
  });

  it("still decodes genuinely textual uploads", async () => {
    const out = await callTool(
      "drive_read_file",
      { fileId: "csv1" },
      {
        getMetadata: async () => ({ id: "csv1", name: "rows.csv", kind: "file", mimeType: "text/csv" }),
        downloadBytes: async () => Buffer.from("a,b\n1,2"),
      },
    );
    expect(out.extractedAs).toBe("text/csv");
    expect(out.content).toBe("a,b\n1,2");
  });

  it("falls back to OCR for a scanned PDF, and flags the text as OCR-derived", async () => {
    process.env.DRIVE_MCP_WRITE = "1";
    const out = await callTool(
      "drive_read_pdf",
      { fileId: "scan1" },
      {
        getMetadata: async () => ({ id: "scan1", name: "scan.pdf", kind: "file", mimeType: "application/pdf" }),
        downloadBytes: async () => Buffer.from("%PDF-1.4 not really a pdf"),
        readViaGoogleConversion: async () => "HDFC BANK  Closing balance 4,10,220",
      },
    );
    expect(out.extractedAs).toBe("google-ocr");
    expect(out.content).toContain("4,10,220");
    expect(out.note).toMatch(/verify figures/i); // never let OCR digits pass as read-off-the-page facts
    delete process.env.DRIVE_MCP_WRITE;
  });

  it("says why a photo is unreadable when write is off, instead of failing with a raw 403", async () => {
    delete process.env.DRIVE_MCP_WRITE; // conversion writes a temp copy, so it needs write scope
    const out = await callTool(
      "drive_read_file",
      { fileId: "img2" },
      {
        getMetadata: async () => ({ id: "img2", name: "x.png", kind: "file", mimeType: "image/png", webViewLink: "https://drive/x" }),
        readViaGoogleConversion: async () => {
          throw new Error("should not be called without write scope");
        },
      },
    );
    expect(out.error).toBe("conversion_unavailable");
    expect(out.webViewLink).toBe("https://drive/x");
  });

  it("deletes only the temp copy it named, and trashes rather than deletes anything else", async () => {
    // This is the one code path that permanently deletes. If the id it holds ever pointed at a real
    // file, that file would be gone with no Trash to recover from — so the guard is the whole safety
    // story and must be asserted, not assumed.
    vi.doUnmock("./drive-client"); // earlier cases stub it; this one must exercise the real thing
    clearGoogleEnv();
    process.env.GOOGLE_OAUTH_CLIENT_ID = "c";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "s";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "r";
    process.env.DRIVE_MCP_WRITE = "1";
    vi.resetModules();

    const root = process.env.DRIVE_FOLDER_ID ?? "rootfolder";
    process.env.DRIVE_FOLDER_ID = root;

    const run = async (copyName: string) => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "", arrayBuffer: async () => new TextEncoder().encode("ocr text").buffer, clone() { return this; } }) as unknown as Response;
        if (url.includes("oauth2.googleapis.com")) return ok({ access_token: "t", expires_in: 3599 });
        calls.push(`${method} ${url.replace(/\?.*/, "")}`);
        if (url.includes("/copy")) return ok({ id: "tmpcopy", name: copyName, mimeType: "application/vnd.google-apps.document", parents: [root] });
        if (url.includes("/export")) return ok({});
        if (url.includes("files/tmpcopy")) return ok({ id: "tmpcopy", name: copyName, parents: [root] });
        // getMetadata(source) + the folder-tree listing
        if (url.includes("files/src")) return ok({ id: "src", name: "receipt.jpg", mimeType: "image/jpeg", parents: [root] });
        return ok({ files: [] });
      });
      const { readViaGoogleConversion } = await import("./drive-client");
      await readViaGoogleConversion("src");
      vi.unstubAllGlobals();
      vi.resetModules();
      return calls;
    };

    const named = await run(`_mcp-ocr-tmp-src`);
    expect(named).toContain("DELETE https://www.googleapis.com/drive/v3/files/tmpcopy");

    // Same flow, but the file coming back is not the one we created — must never be deleted.
    const foreign = await run("someone-elses-quarterly-report.docx");
    expect(foreign).not.toContain("DELETE https://www.googleapis.com/drive/v3/files/tmpcopy");
    expect(foreign).toContain("PATCH https://www.googleapis.com/drive/v3/files/tmpcopy"); // trashed instead

    delete process.env.DRIVE_MCP_WRITE;
  });

  it("keeps a deeply-nested file in scope no matter how big the folder tree is", async () => {
    // Scope was decided by enumerating the subtree and checking membership, and that walk is capped.
    // Past the cap, real files inside the folder were refused as "outside the configured folder
    // subtree" — unreadable, with an error blaming the caller. Scope now climbs from the file to the
    // root, so it cannot depend on tree size. The stub answers the walk but NEVER the enumeration.
    clearGoogleEnv();
    process.env.GOOGLE_OAUTH_CLIENT_ID = "c";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "s";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "r";
    process.env.DRIVE_FOLDER_ID = "ROOT";
    vi.doUnmock("./drive-client");
    vi.resetModules();

    // deep -> mid -> near -> ROOT, i.e. four levels down.
    const parents: Record<string, string[]> = { deep: ["mid"], mid: ["near"], near: ["ROOT"], outside: ["elsewhere"], elsewhere: [] };
    vi.stubGlobal("fetch", async (url: string) => {
      const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => "", clone() { return this; } }) as unknown as Response;
      if (url.includes("oauth2.googleapis.com")) return ok({ access_token: "t", expires_in: 3599 });
      const m = /files\/([^?]+)/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]);
        return ok({ id, name: `${id}.pdf`, mimeType: "application/pdf", parents: parents[id] ?? [] });
      }
      // The subtree enumeration must not be what decides this.
      return ok({ files: [] });
    });

    const { getMetadata, isInScope } = await import("./drive-client");
    await expect(getMetadata("deep")).resolves.toMatchObject({ id: "deep" });
    expect(await isInScope("mid")).toBe(true);
    expect(await isInScope("outside")).toBe(false);
    await expect(getMetadata("outside")).rejects.toThrow(/not inside the configured folder/);

    vi.unstubAllGlobals();
  });

  it("flags a file that is in the Trash, so a deleted invoice can't read as current", async () => {
    // Search and listing filter trashed out, but reading by id does not — the id usually comes from
    // an earlier search, but it can also be pasted or remembered from before the file was deleted.
    const out = await callTool(
      "drive_read_file",
      { fileId: "gone" },
      {
        getMetadata: async () => ({ id: "gone", name: "old-invoice.csv", kind: "file", mimeType: "text/csv", trashed: true }),
        downloadBytes: async () => Buffer.from("amount\n999"),
      },
    );
    expect(out.file.trashed).toBe(true);
    expect(out.file.trashedWarning).toMatch(/deleted/i);
  });

  it("says when a folder listing is cut off, rather than looking complete", async () => {
    // Real folders here exceed the cap: 194C_Non_Company holds 6,277 direct children.
    const out = await callTool(
      "drive_list_files",
      {},
      { listChildren: async () => ({ files: [{ id: "1", name: "a", kind: "file", mimeType: "text/plain" }], capped: true }) },
    );
    expect(out.capped).toBe(true);
    expect(out.note).toMatch(/cut off/i);
  });

  it("opens a .zip and reads an entry out of it", async () => {
    // 291 archives sit in the connected folder and real invoice sets are stored that way, so an
    // unreadable archive is an unanswerable question. A .xlsx IS a zip, which gives us a genuine
    // archive to parse rather than a hand-rolled fixture.
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["total"], [4816]]), "Sheet1");
    const zip = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const stub = {
      getMetadata: async () => ({ id: "z", name: "invoices.zip", kind: "file", mimeType: "application/zip", size: zip.length }),
      downloadBytes: async () => zip,
    };

    const listing = await callTool("drive_read_archive", { fileId: "z" }, stub);
    expect(listing.entryCount).toBeGreaterThan(0);
    const names: string[] = listing.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("xl/workbook.xml");

    const read = await callTool("drive_read_archive", { fileId: "z", entry: "xl/workbook.xml" }, stub);
    expect(read.extractedAs).toBe("text");
    expect(read.content).toContain("<workbook");

    const missing = await callTool("drive_read_archive", { fileId: "z", entry: "nope.pdf" }, stub);
    expect(missing.error).toBe("entry_not_found");
    expect(missing.availableEntries.length).toBeGreaterThan(0);
  });

  it("refuses a non-ZIP archive by name instead of returning nonsense", async () => {
    const out = await callTool(
      "drive_read_archive",
      { fileId: "r" },
      {
        getMetadata: async () => ({ id: "r", name: "invoices.rar", kind: "file", mimeType: "application/x-rar-compressed", size: 10 }),
        downloadBytes: async () => Buffer.from("Rar!"),
      },
    );
    expect(out.error).toBe("not_a_zip");
  });

  it("surfaces a corrupt archive as a stated reason, not a stack trace", async () => {
    const out = await callTool(
      "drive_read_archive",
      { fileId: "bad" },
      {
        getMetadata: async () => ({ id: "bad", name: "broken.zip", kind: "file", mimeType: "application/zip", size: 20 }),
        downloadBytes: async () => Buffer.from("this is definitely not a zip"),
      },
    );
    expect(out.error).toBe("zip_error");
    expect(out.note).toMatch(/not a zip archive/i);
  });

  it("ranks a filename that carries the query terms above one that only matches on content", async () => {
    // Real regression: "VendorOne invoice April" put bank statements (which mention all three
    // words in their contents) above the actual VendorOne invoices, whose first entry was at
    // position 5. Whole-phrase-only matching means NO filename matches a multi-word query, so the
    // ordering silently degraded to newest-first.
    const { nameRelevance } = await import("./drive-client");
    const q = "VendorOne invoice April";
    const invoice = nameRelevance(q, "Employee - VendorOne - AI Tool Invoice - 23-04-2026.pdf");
    const statement = nameRelevance(q, "Bank 1st April 26 - 30th June 26 statement.xls");
    expect(invoice).toBeLessThan(statement);
  });

  it("ranks a whole-phrase filename match best of all", async () => {
    const { nameRelevance } = await import("./drive-client");
    expect(nameRelevance("bank conso", "1.2 May 2026 - Bank Conso - FINAL.xlsx")).toBe(0);
  });

  it("gives a name carrying none of the query terms the worst rank", async () => {
    const { nameRelevance, NAME_RANK_NONE } = await import("./drive-client");
    expect(nameRelevance("VendorOne invoice", "Bank statement.xls")).toBe(NAME_RANK_NONE);
    expect(nameRelevance("", "anything.pdf")).toBe(NAME_RANK_NONE);
  });

  it("prefers a name matching more of the query terms", async () => {
    const { nameRelevance } = await import("./drive-client");
    const both = nameRelevance("gateway settlement", "Gateway settlement 2026.pdf");
    const one = nameRelevance("gateway settlement", "Gateway payout 2026.pdf");
    expect(both).toBeLessThan(one);
  });

  it("truncates a large result set instead of overflowing the caller's token budget", async () => {
    // A real search for a vendor + month returned 130 files / 59,005 characters, which
    // the MCP client rejected outright — the user got an error, not an answer.
    const many = Array.from({ length: 130 }, (_, i) => ({
      id: String(i), name: `invoice-${i}.pdf`, kind: "file", mimeType: "application/pdf",
      webViewLink: `https://drive.google.com/file/d/${"x".repeat(33)}/view?usp=drivesdk`,
    }));
    const out = await callTool(
      "drive_search_files",
      { query: "VendorOne invoice April" },
      { searchSubtree: async () => ({ files: many, capped: false }) },
    );
    expect(out.count).toBe(25);          // default limit
    expect(out.matched).toBe(130);       // ...but the true total is still reported
    expect(out.files).toHaveLength(25);
    expect(out.note).toMatch(/130 files match/);
    expect(JSON.stringify(out).length).toBeLessThan(20_000);
  });

  it("keeps the best-ranked results when it truncates", async () => {
    // searchSubtree already orders filename-matches first, newest-first. Truncation must not
    // reshuffle that, or the one file the user wanted can be the one dropped.
    const files = Array.from({ length: 40 }, (_, i) => ({
      id: String(i), name: `f${i}.pdf`, kind: "file", mimeType: "application/pdf",
    }));
    const out = await callTool(
      "drive_search_files",
      { query: "x", limit: 3 },
      { searchSubtree: async () => ({ files, capped: false }) },
    );
    expect(out.files.map((f: { id: string }) => f.id)).toEqual(["0", "1", "2"]);
  });

  it("honours an explicit limit", async () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      id: String(i), name: `f${i}.pdf`, kind: "file", mimeType: "application/pdf",
    }));
    const out = await callTool(
      "drive_search_files",
      { query: "x", limit: 50 },
      { searchSubtree: async () => ({ files, capped: false }) },
    );
    expect(out.count).toBe(40);          // fewer matches than the limit -> all of them
    expect(out.matched).toBe(40);
    expect(out.note).toBeUndefined();    // nothing withheld, so no note
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
