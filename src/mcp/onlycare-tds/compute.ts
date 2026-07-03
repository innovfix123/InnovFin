/**
 * compute_onlycare_tds — the Only Care 194C pipeline core.
 * payouts (App-DB) + PAN status (provider) → tds-core.resolveRate → per-payout workbook rows,
 * section subtotal, and the regression check against the filed anchor. No tax math lives here;
 * it all comes from tds-core.
 */
import { resolveRate, isOwnPan, type PanStatus } from "../../tds-core";
import { fetchOnlyCarePayouts } from "./payouts";
import { tracesUploadProvider, type TracesRecord } from "./pan-provider";
import { round2 } from "./util";

export interface ComputedRow {
  app: "Onlycare";
  creatorId: string;
  creatorName: string | null;
  pan: string | null;
  panName: string | null;
  payoutRef: string;
  paymentDate: string;
  taxable: number;
  status: PanStatus;
  rateApplied: number;
  tdsDeposited: number;
  creatorBorne: number;
  companyLoss: number;
  code: string;
  majorHead: "0020" | "0021";
  cashfreeFee: number | null;
  netCredited: number | null;
  flags: string[];
}

export interface ComputeResult {
  period: string;
  panSource: string;
  rows: ComputedRow[];
  subtotal: {
    creators: number; payouts: number; taxable: number; tds: number;
    companyLoss: number; inoperativeCount: number; flaggedRows: number;
  };
  regression: { anchorTds: number | null; computedTds: number; drift: number | null; ok: boolean | null };
  flagsSummary: Record<string, number>;
}

/** Filed 194C anchors (rupee-locked regression targets). */
const ANCHORS: Record<string, number> = { "2026-05": 2086.85 };

export async function computeOnlyCareTds(period: string, tracesRecords?: TracesRecord[]): Promise<ComputeResult> {
  const payouts = await fetchOnlyCarePayouts(period);
  const provider = tracesUploadProvider(tracesRecords);
  const statuses = await provider.verify(payouts.map((p) => p.pan ?? "").filter(Boolean));

  const rows: ComputedRow[] = payouts.map((p) => {
    const key = (p.pan ?? "").trim().toUpperCase();
    const verified = key ? statuses.get(key) : undefined;
    const status: PanStatus = verified?.status ?? "UNKNOWN";
    const o = resolveRate({ taxable: p.grossAmount, section: "194C", pan: p.pan, panStatus: status });
    const flags = [...o.flags];
    if (isOwnPan(p.pan)) flags.push("PAN equals Innovfix's own PAN — flag, never file as a creator's PAN");
    return {
      app: "Onlycare",
      creatorId: p.creatorId,
      creatorName: p.creatorName,
      pan: p.pan,
      panName: verified?.name ?? p.panName, // provider name (masked/unmasked) wins; else bank KYC name
      payoutRef: p.payoutRef,
      paymentDate: p.paymentDate,
      taxable: o.taxable,
      status,
      rateApplied: o.rateApplied,
      tdsDeposited: o.tdsDeposited,
      creatorBorne: o.deducteeBorne,
      companyLoss: o.companyLoss,
      code: o.code,
      majorHead: o.majorHead,
      cashfreeFee: p.cashfreeFee,
      netCredited: p.netCredited,
      flags,
    };
  });

  const flagsSummary: Record<string, number> = {};
  for (const r of rows) for (const f of r.flags) flagsSummary[f] = (flagsSummary[f] ?? 0) + 1;

  const creators = new Set(rows.map((r) => r.creatorId)).size;
  const taxable = rows.reduce((s, r) => s + r.taxable, 0);
  const tds = rows.reduce((s, r) => s + r.tdsDeposited, 0);
  const companyLoss = rows.reduce((s, r) => s + r.companyLoss, 0);
  const inoperativeCount = rows.filter((r) => r.status === "INOPERATIVE").length;
  const computedTds = round2(tds);

  const anchorTds = ANCHORS[period] ?? null;
  const drift = anchorTds == null ? null : round2(computedTds - anchorTds);
  const ok = anchorTds == null ? null : Math.abs(computedTds - anchorTds) <= 0.01;

  return {
    period,
    panSource: provider.source,
    rows,
    subtotal: {
      creators, payouts: rows.length, taxable: round2(taxable), tds: computedTds,
      companyLoss: round2(companyLoss), inoperativeCount, flaggedRows: rows.filter((r) => r.flags.length).length,
    },
    regression: { anchorTds, computedTds, drift, ok },
    flagsSummary,
  };
}
