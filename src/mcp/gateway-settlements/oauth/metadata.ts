/**
 * OAuth discovery documents for the Gateway Settlements resource (RFC 8414 AS metadata, RFC 9728 PR
 * metadata). Mirrors Hima's oauth/metadata.ts off the GATEWAY config, so `issuer` is the path-based
 * co-located AS. code_challenge_methods_supported MUST advertise "S256" or Claude refuses to connect.
 */
import { issuer, resource, authorizationEndpoint, tokenEndpoint, registrationEndpoint, SCOPES } from "./config";

export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: issuer(),
    authorization_endpoint: authorizationEndpoint(),
    token_endpoint: tokenEndpoint(),
    registration_endpoint: registrationEndpoint(),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
  };
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resource(),
    authorization_servers: [issuer()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}
