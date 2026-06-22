/** Core Zoho Books API types + a typed error. Module record types grow as we add resources. */

/** Response from the OAuth token endpoint (refresh-token grant). */
export interface ZohoTokenResponse {
  access_token?: string;
  /** Seconds until the access token expires (Zoho: 3600). */
  expires_in?: number;
  token_type?: string;
  scope?: string;
  api_domain?: string;
  /** Present on failure, e.g. "invalid_code", "invalid_client". */
  error?: string;
}

/** Pagination block returned on Zoho list endpoints. */
export interface PageContext {
  page: number;
  per_page: number;
  has_more_page: boolean;
  report_name?: string;
  sort_column?: string;
  sort_order?: string;
}

/** Shape of a Zoho list response. The records sit under a module-named key (e.g. `chartofaccounts`). */
export type ZohoListResponse<T> = {
  code: number;
  message: string;
  page_context?: PageContext;
} & Record<string, T[] | unknown>;

/** Thrown on any non-2xx Zoho API response (after retries are exhausted). */
export class ZohoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: number,
    public readonly detail?: string,
  ) {
    super(`Zoho API ${status}${code != null ? ` (code ${code})` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "ZohoApiError";
  }
}

// ---- Read-only resource shapes (only the fields we use; Zoho returns many more) ----

export interface Organization {
  organization_id: string;
  name: string;
  currency_code?: string;
  country?: string;
  /** Whether this is the org the API token defaults to. */
  is_default_org?: boolean;
}

export interface ChartOfAccount {
  account_id: string;
  account_name: string;
  /** e.g. "income", "expense", "bank", "current_liability", "other_current_asset". */
  account_type: string;
  /** Some orgs use a numeric account code. */
  account_code?: string;
  description?: string;
  is_active?: boolean;
  is_user_created?: boolean;
}
