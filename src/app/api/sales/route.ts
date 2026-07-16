import { NextResponse } from "next/server";
import { bufferToAOA } from "@/lib/workbook";
import {
  parse, toLine, summarise, APP_ORDER, APP_DEFAULTS,
  type ParserType, type Gstr1Line,
} from "@/gst-core/gstr1";
import { getConnector } from "@/lib/connectors";
import { isGatewaySource } from "@/lib/recon/flag";
import { computeGatewaySales } from "@/lib/recon/sales-from-gateway";

export const runtime = "nodejs";

interface SourceStatus {
  app: string;
  mode: "auto" | "manual";
  status: "ok" | "pending" | "error";
  count?: number;
  taxable?: number;
  message?: string;
}

/**
 * Compute GSTR-1 for the period. Per app: a manual upload (if provided) wins; otherwise the
 * configured connector auto-fetches; otherwise the source is left pending. Manual upload is a
 * graceful fallback so the wizard works before any API keys are added.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const period = (form.get("period") as string) || "";

  // ══ The gateway path is OFF. ══
  //
  // GST_SALES_SOURCE is unset, so salesSourceMode() is "appdb" and this branch is never taken:
  // everything below runs exactly as it always has. Only the literal string "gateway" diverts the
  // return to the reconciled gateway source — see src/lib/recon/flag.ts for the three rulings
  // (refund presentation, month-boundary restatement, unregistered apps) still outstanding before
  // anyone sets it. Enabling it changes a filed statutory return; it must never happen by accident.
  if (isGatewaySource()) {
    return NextResponse.json(await computeGatewaySales(period, form));
  }

  const lines: Gstr1Line[] = [];
  const sources: SourceStatus[] = [];

  for (const app of APP_ORDER) {
    const connector = getConnector(app);
    const manual = form.get(`file:${app}`);
    const typeOverride = form.get(`type:${app}`);
    const baseMode: "auto" | "manual" = connector ? "auto" : "manual";

    try {
      let aoa;
      let mode: "auto" | "manual";
      let parserType: ParserType;

      if (manual instanceof File && manual.size > 0) {
        aoa = bufferToAOA(Buffer.from(await manual.arrayBuffer()));
        mode = "manual";
        parserType = (typeof typeOverride === "string" && typeOverride
          ? typeOverride
          : connector?.parserType ?? APP_DEFAULTS[app].type) as ParserType;
      } else if (connector && connector.isConfigured()) {
        const r = await connector.fetch(period);
        aoa = r.aoa;
        mode = "auto";
        parserType = connector.parserType;
      } else {
        sources.push({
          app, mode: baseMode, status: "pending",
          message: connector ? "auto-fetch not configured — add API key or upload manually" : "manual upload required",
        });
        continue;
      }

      const meas = parse(parserType, aoa);
      const line = toLine(app, meas, {});
      lines.push(line);
      sources.push({ app, mode, status: "ok", count: meas.count, taxable: line.taxable });
    } catch (e) {
      sources.push({ app, mode: baseMode, status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const { hsnRows, total } = summarise(lines);
  return NextResponse.json({ period, lines, hsnRows, total, sources });
}
