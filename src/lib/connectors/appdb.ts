import type { Connector, FetchResult } from "./types";

export interface AppDbCreds {
  /** Connection URL (e.g. mysql://user:pass@host/db or postgres://...). */
  url: string;
  /** SELECT returning invoice-wise sales for the period. */
  query?: string;
}

/** App dashboard DB connector (Hima / Only Care / Unman invoice-wise sales). */
export function appDbConnector(app: string, creds?: AppDbCreds): Connector {
  return {
    id: `appdb:${app.toLowerCase().replace(/\s+/g, "-")}`,
    app,
    provider: "appdb",
    parserType: "invoicewise",
    mode: "auto",
    isConfigured: () => Boolean(creds?.url),
    async fetch(): Promise<FetchResult> {
      if (!creds?.url) throw new Error(`App-DB not configured for ${app}`);
      // NOT WIRED YET: needs the app's DB schema + read-only creds. Once shared, connect and
      // SELECT invoice-wise sales for the period → AOA [["Invoice No","Taxable Value","Invoice Value"], ...].
      throw new Error(`App-DB connector for ${app}: query not wired yet (pending DB schema + read creds).`);
    },
  };
}
