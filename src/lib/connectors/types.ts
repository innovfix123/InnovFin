import type { AOA, ParserType } from "@/gst-core/gstr1";

export type Provider = "razorpay" | "cashfree" | "appdb" | "manual";

export interface FetchResult {
  /** Rows in the gateway's native shape, so the existing parser consumes them unchanged. */
  aoa: AOA;
  count: number;
  source: string;
}

export interface Connector {
  id: string;
  app: string;
  provider: Provider;
  /** How the engine should parse this source's AOA. */
  parserType: ParserType;
  /** "auto" = fetched via API/DB; "manual" = user uploads a file (PhonePe/bank/2B). */
  mode: "auto" | "manual";
  isConfigured(): boolean;
  fetch(period: string): Promise<FetchResult>;
}
