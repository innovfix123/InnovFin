import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serve the OAuth discovery documents at their spec-mandated /.well-known/* paths. Next ignores
  // dot-folders under app/, so these rewrite to normal route handlers under /mcp/onlycare-tds/oauth/.
  // Clients try the path-inserted PRM first, then the root; and oauth-authorization-server, then
  // openid-configuration — so all variants map to the same handlers.
  async rewrites() {
    return [
      // Only Care AS uses the ROOT issuer, so it claims the bare well-known AS-metadata paths.
      { source: "/.well-known/oauth-authorization-server", destination: "/mcp/onlycare-tds/oauth/authorization-server-metadata" },
      { source: "/.well-known/openid-configuration", destination: "/mcp/onlycare-tds/oauth/authorization-server-metadata" },
      { source: "/.well-known/oauth-protected-resource/mcp/onlycare-tds", destination: "/mcp/onlycare-tds/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/mcp/onlycare-tds/oauth/protected-resource-metadata" },
      // Hima AS uses a PATH-BASED issuer (https://host/mcp/hima-tds), so its metadata lives under
      // path-inserted well-known locations — no collision with Only Care's root ones. AS metadata is
      // served at BOTH the RFC 8414 path-insertion location and the path-suffix location, so any
      // spec-compliant client finds it.
      { source: "/.well-known/oauth-protected-resource/mcp/hima-tds", destination: "/mcp/hima-tds/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-authorization-server/mcp/hima-tds", destination: "/mcp/hima-tds/oauth/authorization-server-metadata" },
      { source: "/.well-known/openid-configuration/mcp/hima-tds", destination: "/mcp/hima-tds/oauth/authorization-server-metadata" },
      { source: "/mcp/hima-tds/.well-known/oauth-authorization-server", destination: "/mcp/hima-tds/oauth/authorization-server-metadata" },
      // Gateway Settlements AS uses a PATH-BASED issuer (https://host/mcp/gateway-settlements) too, so
      // its metadata lives under path-inserted well-known locations — no collision with Only Care's
      // root ones or Hima's. Served at BOTH the RFC 8414 path-insertion and the path-suffix location.
      { source: "/.well-known/oauth-protected-resource/mcp/gateway-settlements", destination: "/mcp/gateway-settlements/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-authorization-server/mcp/gateway-settlements", destination: "/mcp/gateway-settlements/oauth/authorization-server-metadata" },
      { source: "/.well-known/openid-configuration/mcp/gateway-settlements", destination: "/mcp/gateway-settlements/oauth/authorization-server-metadata" },
      { source: "/mcp/gateway-settlements/.well-known/oauth-authorization-server", destination: "/mcp/gateway-settlements/oauth/authorization-server-metadata" },
      // Invoice Intelligence AS uses a PATH-BASED issuer (https://host/mcp/invoice-intelligence) too —
      // metadata under path-inserted well-known locations, no collision with the others. Served at BOTH
      // the RFC 8414 path-insertion and the path-suffix location so any spec-compliant client finds it.
      { source: "/.well-known/oauth-protected-resource/mcp/invoice-intelligence", destination: "/mcp/invoice-intelligence/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-authorization-server/mcp/invoice-intelligence", destination: "/mcp/invoice-intelligence/oauth/authorization-server-metadata" },
      { source: "/.well-known/openid-configuration/mcp/invoice-intelligence", destination: "/mcp/invoice-intelligence/oauth/authorization-server-metadata" },
      { source: "/mcp/invoice-intelligence/.well-known/oauth-authorization-server", destination: "/mcp/invoice-intelligence/oauth/authorization-server-metadata" },
      // TDS Working AS uses a PATH-BASED issuer (https://host/mcp/tds-working) too — metadata under
      // path-inserted well-known locations, no collision with the others. Served at BOTH the RFC 8414
      // path-insertion and the path-suffix location so any spec-compliant client finds it.
      { source: "/.well-known/oauth-protected-resource/mcp/tds-working", destination: "/mcp/tds-working/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-authorization-server/mcp/tds-working", destination: "/mcp/tds-working/oauth/authorization-server-metadata" },
      { source: "/.well-known/openid-configuration/mcp/tds-working", destination: "/mcp/tds-working/oauth/authorization-server-metadata" },
      { source: "/mcp/tds-working/.well-known/oauth-authorization-server", destination: "/mcp/tds-working/oauth/authorization-server-metadata" },
    ];
  },
};

export default nextConfig;
