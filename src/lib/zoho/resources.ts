/**
 * Read-only Zoho Books resources.
 *
 * Deliberately read-only for now: these are safe to run against the LIVE org and
 * are exactly what the accounting discovery needs — `getChartOfAccounts` pulls the
 * real CoA the automation must map to (the most important [EXPORT] in the
 * Accounting Master Reference), and `verifyConnection` is the first smoke test once
 * credentials land. Write operations (journals, bills, payments) come later, behind
 * the sync ledger, once Shoyab's requirements are captured.
 */
import type { ZohoClient } from "./client";
import type { ChartOfAccount, Organization } from "./types";

/** All organizations the token can see (not org-scoped). */
export async function listOrganizations(client: ZohoClient): Promise<Organization[]> {
  const data = await client.request<{ organizations?: Organization[] }>("GET", "/organizations", {
    orgScoped: false,
  });
  return data.organizations ?? [];
}

/** The full Chart of Accounts for the configured org — the spine the automation maps to. */
export function getChartOfAccounts(client: ZohoClient): Promise<ChartOfAccount[]> {
  return client.list<ChartOfAccount>("/chartofaccounts", "chartofaccounts");
}

/** First smoke test: confirm the token works and the configured org id is reachable. */
export async function verifyConnection(
  client: ZohoClient,
): Promise<{ ok: boolean; org?: Organization; message: string }> {
  const orgs = await listOrganizations(client);
  const org = orgs.find((o) => o.organization_id === client.config.orgId);
  if (!org) {
    const seen = orgs.map((o) => `${o.name} (${o.organization_id})`).join(", ") || "none";
    return {
      ok: false,
      message: `ZOHO_ORG_ID ${client.config.orgId} not found among accessible orgs: ${seen}.`,
    };
  }
  return {
    ok: true,
    org,
    message: `Connected to "${org.name}" — org ${org.organization_id}, ${org.currency_code ?? "?"} (DC: ${client.config.dc}).`,
  };
}
