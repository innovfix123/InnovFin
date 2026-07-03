import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serve the OAuth discovery documents at their spec-mandated /.well-known/* paths. Next ignores
  // dot-folders under app/, so these rewrite to normal route handlers under /mcp/onlycare-tds/oauth/.
  // Clients try the path-inserted PRM first, then the root; and oauth-authorization-server, then
  // openid-configuration — so all variants map to the same handlers.
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/mcp/onlycare-tds/oauth/authorization-server-metadata" },
      { source: "/.well-known/openid-configuration", destination: "/mcp/onlycare-tds/oauth/authorization-server-metadata" },
      { source: "/.well-known/oauth-protected-resource/mcp/onlycare-tds", destination: "/mcp/onlycare-tds/oauth/protected-resource-metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/mcp/onlycare-tds/oauth/protected-resource-metadata" },
    ];
  },
};

export default nextConfig;
