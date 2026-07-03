/**
 * Networked Only Care TDS MCP endpoint — https://gst.innovfix.ai/mcp/onlycare-tds
 *
 * Served by the innovfin Next.js app (pm2 :3000, behind nginx TLS for gst.innovfix.ai).
 * Per-user bearer auth (see http-auth.ts), stateless Streamable HTTP transport, and an
 * access log on every call (see audit.ts) — this endpoint serves creator PANs.
 *
 * Claude Desktop connects via `npx mcp-remote <url> --header "Authorization: Bearer <token>"`.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildOnlyCareServer } from "@/mcp/onlycare-tds/factory";
import { authenticate, bearerFromRequest, hasConfiguredTokens, type Principal } from "@/mcp/onlycare-tds/http-auth";
import { audit, safeArgs } from "@/mcp/onlycare-tds/audit";

export const runtime = "nodejs";      // needs node crypto, fs (audit), mysql2 (app DB)
export const dynamic = "force-dynamic"; // never cache; every call is authed + audited

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Extract the non-PII shape of a JSON-RPC message (or the first of a batch) for the audit log. */
function describe(body: unknown): { method?: string; tool?: string; args?: Record<string, unknown> } {
  const msg = Array.isArray(body) ? body[0] : body;
  if (!msg || typeof msg !== "object") return {};
  const m = msg as Record<string, unknown>;
  const method = typeof m.method === "string" ? m.method : undefined;
  const params = (m.params ?? {}) as Record<string, unknown>;
  const tool = method === "tools/call" && typeof params.name === "string" ? params.name : undefined;
  const args = method === "tools/call" ? safeArgs(params.arguments) : undefined;
  return { method, tool, args };
}

function jsonRpcError(status: number, code: number, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const ip = clientIp(req);

  // Fail closed + loud if the deploy has no user tokens configured.
  if (!hasConfiguredTokens()) {
    audit({ ts: new Date(started).toISOString(), event: "error", user: "anonymous", ip, status: 503, ms: Date.now() - started, reason: "no ONLYCARE_MCP_TOKEN_* configured" });
    return jsonRpcError(503, -32000, "Endpoint not provisioned — no access tokens configured.");
  }

  const token = bearerFromRequest(req);
  const principal: Principal | null = authenticate(token);
  if (!principal) {
    audit({ ts: new Date(started).toISOString(), event: "auth_fail", user: "anonymous", ip, status: 401, ms: Date.now() - started, reason: token ? "unknown token" : "missing bearer token" });
    return jsonRpcError(401, -32001, "Unauthorized — supply a valid bearer token.", { "www-authenticate": 'Bearer realm="onlycare-tds"' });
  }

  // Read the body once so we can (a) label the audit entry and (b) hand it to the transport.
  let body: unknown;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    audit({ ts: new Date(started).toISOString(), event: "error", user: principal.user, tokenFp: principal.tokenFp, ip, status: 400, ms: Date.now() - started, reason: "invalid JSON body" });
    return jsonRpcError(400, -32700, "Parse error — body is not valid JSON.");
  }
  const { method, tool, args } = describe(body);

  let status = 200;
  try {
    const server = buildOnlyCareServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session affinity, one server per request
      enableJsonResponse: true,      // single JSON response (our tools are request/response, not streams)
    });
    await server.connect(transport);
    const res = await transport.handleRequest(req, { parsedBody: body });
    status = res.status;
    audit({ ts: new Date(started).toISOString(), event: "call", user: principal.user, tokenFp: principal.tokenFp, ip, method, tool, args, status, ms: Date.now() - started });
    return res;
  } catch (e) {
    status = 500;
    audit({ ts: new Date(started).toISOString(), event: "error", user: principal.user, tokenFp: principal.tokenFp, ip, method, tool, args, status, ms: Date.now() - started, reason: e instanceof Error ? e.message : String(e) });
    return jsonRpcError(500, -32603, "Internal error handling MCP request.");
  }
}

// Stateless mode exposes no server-initiated stream and no session to delete. Require a valid
// token (don't leak liveness to the unauthenticated), then report method-not-allowed.
async function methodNotAllowed(req: Request): Promise<Response> {
  const ip = clientIp(req);
  const principal = authenticate(bearerFromRequest(req));
  if (!principal) {
    return jsonRpcError(401, -32001, "Unauthorized — supply a valid bearer token.", { "www-authenticate": 'Bearer realm="onlycare-tds"' });
  }
  audit({ ts: new Date().toISOString(), event: "call", user: principal.user, tokenFp: principal.tokenFp, ip, method: req.method, status: 405, ms: 0 });
  return jsonRpcError(405, -32000, "Method not allowed — POST JSON-RPC to this endpoint.", { allow: "POST" });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
