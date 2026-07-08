/**
 * Localhost relay to the Python invoice-intelligence MCP (FastMCP streamable-http, run stateless +
 * json_response so each POST is one self-contained JSON-RPC exchange — see mcp_server/server.py).
 *
 * The Python service binds 127.0.0.1:<port> and is guarded by INVOICE_MCP_TOKEN; this proxy adds
 * that bearer on the localhost hop. EXTERNAL auth (per-user bearer OR OAuth) is enforced in route.ts
 * BEFORE this is called — the upstream is never exposed directly.
 */
import { envVar } from "./env";

/** Upstream Streamable-HTTP endpoint of the Python MCP. Override with INVOICE_MCP_UPSTREAM. */
export function upstreamUrl(): string {
  return envVar("INVOICE_MCP_UPSTREAM") ?? "http://127.0.0.1:8765/mcp";
}

function upstreamToken(): string | undefined {
  return envVar("INVOICE_MCP_TOKEN");
}

export interface UpstreamResult {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Forward the raw JSON-RPC request body to the Python MCP and return its status + body verbatim.
 * Throws only on network failure / timeout (route.ts maps that to a 502).
 */
export async function proxyToUpstream(rawBody: string, timeoutMs = 30_000): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = upstreamToken();
    const res = await fetch(upstreamUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // FastMCP streamable-http requires the client to accept both, even in json_response mode.
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: rawBody,
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body };
  } finally {
    clearTimeout(timer);
  }
}
