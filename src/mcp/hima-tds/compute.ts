/**
 * compute_hima_tds — the Hima 194C pipeline core.
 * payouts (App-DB) + PAN status (provider) → tds-core.resolveRate → per-payout workbook rows,
 * section subtotal, and a regression block. No tax math lives here; it all comes from tds-core.
 *
 * ANCHOR STATUS — NOT locked yet (unlike Only Care's ₹2,086.85). Two gaps must be reconciled first:
 *   1) Gross gap: filed Sec_194C_NonCompany HIMA line (May-2026) = ₹2,65,75,589 / ₹2,65,755.89 (flat
 *      1%), vs our live DB ₹2,66,68,647 / gross×1% ₹2,66,686.47 — ~₹93,058 gross unexplained by the
 *      243 no-PAN rows alone. Reconcile vs 1.2. TDS_Working_May_26.xlsx.
 *   2) Method gap: tds-core is 206AA-aware, so 243 no-PAN → 20% and 36 non-`P` PANs → 2%. That makes
 *      our DEPOSITED TDS legitimately higher than a flat-1% base. Confirm the filing method with Shoyab.
 * Until both settle, regression.ok stays null and we surface the filed figure as reference only.
 */
import { resolveRate, isOwnPan, type PanStatus } from "../../tds-core";
import { fetchHimaPayouts } from "./payouts";
import { tracesUploadProvider, type TracesRecord } from "./pan-provider";
import { round2 } from "./util";

export interface ComputedRow {
  app: "Hima";
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

export interface FiledReference { filedTds: number; filedGross: number; note: string }

export interface ComputeResult {
  period: string;
  panSource: string;
  rows: ComputedRow[];
  subtotal: {
    creators: number; payouts: number; taxable: number; tds: number;
    grossTimesOnePct: number; companyLoss: number;
    inoperativeCount: number; noPanCount: number; flaggedRows: number;
  };
  regression: { anchorTds: number | null; computedTds: number; drift: number | null; ok: boolean | null };
  filedReference: FiledReference | null;
  flagsSummary: Record<string, number>;
}

/**
 * Filed 194C anchors (rupee-locked regression targets) — EMPTY for Hima, pending reconciliation
 * (see the module header). Populate once the gross gap AND the 206AA method are settled with Shoyab.
 */
const ANCHORS: Record<string, number> = {};

/** Filed figures surfaced for reconciliation only — they do NOT gate the pipeline. */
const FILED_REFERENCE: Record<string, FiledReference> = {
  "2026-05": {
    filedTds: 265755.89,
    filedGross: 26575589,
    note:
      "Filed flat-1% figure. Anchor NOT locked: our 206AA-aware DEPOSITED TDS differs (243 no-PAN → 20%, " +
      "non-`P` PANs → 2%), and there is a ~₹93,058 gross gap vs the live DB. Reconcile vs " +
      "1.2. TDS_Working_May_26.xlsx and confirm the filing method with Shoyab before locking.",
  },
};

export async function computeHimaTds(period: string, tracesRecords?: TracesRecord[]): Promise<ComputeResult> {
  const payouts = await fetchHimaPayouts(period);
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
      app: "Hima",
      creatorId: p.creatorId,
      creatorName: p.creatorName,
      pan: p.pan,
      panName: verified?.name ?? p.panName, // provider name (masked/unmasked) wins; else the payout-row PAN name
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
  const noPanCount = rows.filter((r) => !r.pan).length;
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
      grossTimesOnePct: round2(taxable * 0.01), companyLoss: round2(companyLoss),
      inoperativeCount, noPanCount, flaggedRows: rows.filter((r) => r.flags.length).length,
    },
    regression: { anchorTds, computedTds, drift, ok },
    filedReference: FILED_REFERENCE[period] ?? null,
    flagsSummary,
  };
}
