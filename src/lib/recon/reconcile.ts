import { GST_RATE } from "@/gst-core/gstr1";
import { dedupeByOrderId, type AmountConflict } from "./dedupe";
import type { AppDbRow } from "./appdb-source";
import type { Txn, TxnSource } from "./types";

/**
 * The reconciler: gateway truth vs what we actually file.
 *
 * REPORTING ONLY. Nothing here feeds GSTR-1. It answers one question — "if the gateways and the
 * app database disagree, exactly which rupees are in dispute and why" — and it is required to
 * account for every one of them.
 *
 * The core identity:
 *
 *      A  gateway gross (deduped, in-month, successful)
 *      B  app-DB gross (exactly what production files today)
 *      C  = A − B                                   the gap our GSTR-1 misses
 *      D  gateway orders ABSENT from the app DB     (in practice: SBC_* autopay)
 *      E  app-DB orders with NO gateway success     (in practice: month-boundary orphans)
 *      F  matched orders whose amounts DISAGREE     (in practice: none seen yet)
 *
 *      C ≡ D − E + F
 *
 * That is an accounting identity over two sets keyed by order id — it cannot fail arithmetically.
 * So `residual` is not a finding, it is a SELF-CHECK: a non-zero residual means this reconciler is
 * double-counting an order into two buckets, i.e. the code is wrong. It is reported for exactly
 * that reason, and the June figures below are pinned in reconcile.test.ts.
 */

export interface Totals {
  count: number;
  gross: number;   // ₹, GST-inclusive
  taxable: number; // gross ÷ 1.18
}

const EMPTY: Totals = { count: 0, gross: 0, taxable: 0 };

export function totals(txns: { amount: number }[]): Totals {
  const gross = txns.reduce((a, t) => a + t.amount, 0);
  return { count: txns.length, gross, taxable: gross / (1 + GST_RATE) };
}

/** A gateway payment the app database has no record of at all. */
export interface MissingTxn {
  orderId: string;
  amount: number;
  txnTimeIST: string;
  source: TxnSource;
  /** The payment_group / instrument. This is what names the cause (e.g. SBC_UPI → autopay). */
  method: string | null;
}

/** An app-DB row that no gateway ever confirmed — we may have credited a customer for nothing. */
export interface OrphanTxn {
  orderId: string;
  amount: number;
  txnTimeIST: string;
}

/** Same order on both sides, but the money disagrees. */
export interface AmountDelta {
  orderId: string;
  gatewayAmount: number;
  appDbAmount: number;
  delta: number;
}

export interface ReconReport {
  app: string;
  period: string;

  /** 1. Gateway vs App DB. */
  gateway: Totals;
  gatewayBySource: Partial<Record<TxnSource, Totals>>;
  appDb: Totals;
  gap: Totals;

  /** 2. Missing transactions — gateway money the app DB never recorded. */
  missing: { txns: MissingTxn[]; totals: Totals; byMethod: Record<string, Totals> };

  /** 3. Duplicate orders — on either side. */
  duplicates: {
    gatewayOrderIds: string[];
    appDbOrderIds: string[];
    /** Duplicated successes whose amounts differ. A real double-charge would look like this. */
    amountConflicts: AmountConflict[];
  };

  /** 4. Status mismatches — app-DB rows with no gateway success. (The gateway→app direction
   *     needs the unfiltered app-DB read; see reconcileStatuses().) */
  orphans: { txns: OrphanTxn[]; totals: Totals };

  /** 5. Refunds. */
  refunds: { count: number; amount: number };

  /** 6. Month-boundary — gateway successes whose payment date falls OUTSIDE the period. */
  monthBoundary: { txns: MissingTxn[]; totals: Totals };

  /** Matched orders whose amounts disagree (F). */
  amountDeltas: { txns: AmountDelta[]; total: number };

  /** Self-check: C − (D − E + F). Anything but 0 means THIS CODE is wrong. */
  residual: number;
  reconciles: boolean;
}

export interface ReconcileInput {
  app: string;
  period: string;
  /** Gateway transactions: in-month, successful. Deduped here — pass them raw. */
  gatewayTxns: Txn[];
  /** Gateway successes that fell outside the period (from each source's `outOfMonth`). */
  gatewayOutOfMonth?: Txn[];
  /** Exactly the rows production files today (fetchAppDbFiled). */
  appDbTxns: Txn[];
}

/** Sum a list of Txn into a per-source breakdown. */
function bySource(txns: Txn[]): Partial<Record<TxnSource, Totals>> {
  const groups = new Map<TxnSource, Txn[]>();
  for (const t of txns) {
    const g = groups.get(t.source);
    if (g) g.push(t);
    else groups.set(t.source, [t]);
  }
  const out: Partial<Record<TxnSource, Totals>> = {};
  for (const [src, rows] of groups) out[src] = totals(rows);
  return out;
}

export function reconcile(input: ReconcileInput): ReconReport {
  const { app, period, gatewayTxns, gatewayOutOfMonth = [], appDbTxns } = input;

  // Both sides are deduped on order id before anything is compared. The gateway files duplicate
  // rows just as the app DB does — TXN_RETRY_A appears twice in PhonePe's own settlement
  // report — so comparing raw rows would manufacture a difference that isn't there.
  const gw = dedupeByOrderId(gatewayTxns);
  const db = dedupeByOrderId(appDbTxns);

  const gwByOrder = new Map(gw.kept.map((t) => [t.orderId, t]));
  const dbByOrder = new Map(db.kept.map((t) => [t.orderId, t]));

  const missingTxns: MissingTxn[] = [];
  const amountDeltaTxns: AmountDelta[] = [];
  for (const [orderId, t] of gwByOrder) {
    const d = dbByOrder.get(orderId);
    if (!d) {
      missingTxns.push({ orderId, amount: t.amount, txnTimeIST: t.txnTimeIST, source: t.source, method: t.method });
    } else if (d.amount !== t.amount) {
      amountDeltaTxns.push({ orderId, gatewayAmount: t.amount, appDbAmount: d.amount, delta: t.amount - d.amount });
    }
  }

  const orphanTxns: OrphanTxn[] = [];
  for (const [orderId, d] of dbByOrder) {
    if (!gwByOrder.has(orderId)) orphanTxns.push({ orderId, amount: d.amount, txnTimeIST: d.txnTimeIST });
  }

  // What KIND of money are we missing? In June this is the whole answer: SBC_* = autopay mandates
  // and recurring debits, which the app DB's `JOIN coins` silently deletes.
  const byMethod: Record<string, Totals> = {};
  for (const m of missingTxns) {
    const k = m.method ?? "UNKNOWN";
    const cur = byMethod[k] ?? EMPTY;
    const gross = cur.gross + m.amount;
    byMethod[k] = { count: cur.count + 1, gross, taxable: gross / (1 + GST_RATE) };
  }

  const gatewayTot = totals(gw.kept);
  const appDbTot = totals(db.kept);
  const gapTot: Totals = {
    count: gatewayTot.count - appDbTot.count,
    gross: gatewayTot.gross - appDbTot.gross,
    taxable: gatewayTot.taxable - appDbTot.taxable,
  };

  const missingTot = totals(missingTxns);
  const orphanTot = totals(orphanTxns);
  const deltaTot = amountDeltaTxns.reduce((a, d) => a + d.delta, 0);

  const residual = gapTot.gross - (missingTot.gross - orphanTot.gross + deltaTot);

  const refunded = gw.kept.filter((t) => t.refunded > 0);

  return {
    app,
    period,
    gateway: gatewayTot,
    gatewayBySource: bySource(gw.kept),
    appDb: appDbTot,
    gap: gapTot,
    missing: { txns: missingTxns, totals: missingTot, byMethod },
    duplicates: {
      gatewayOrderIds: gw.duplicateOrderIds,
      appDbOrderIds: db.duplicateOrderIds,
      amountConflicts: [...gw.amountConflicts, ...db.amountConflicts],
    },
    orphans: { txns: orphanTxns, totals: orphanTot },
    refunds: { count: refunded.length, amount: refunded.reduce((a, t) => a + t.refunded, 0) },
    monthBoundary: {
      txns: gatewayOutOfMonth.map((t) => ({
        orderId: t.orderId, amount: t.amount, txnTimeIST: t.txnTimeIST, source: t.source, method: t.method,
      })),
      totals: totals(gatewayOutOfMonth),
    },
    amountDeltas: { txns: amountDeltaTxns, total: deltaTot },
    residual,
    // Rounded to paise: floating-point sums over 170k rows drift in the 1e-9 range.
    reconciles: Math.abs(residual) < 0.005,
  };
}

// ---- Status mismatches (needs the UNFILTERED app-DB read — fetchAppDbAll) ----

export interface StatusMismatch {
  orderId: string;
  amount: number;
  txnTimeIST: string;
  gateway: string;
  appStatus: number;
  appChecked: number | null;
  /** True when the app DB has no coin pack for this row — i.e. the production JOIN deletes it. */
  noCoinPack: boolean;
}

export interface StatusReport {
  /** Gateway says the money arrived; the app left the row at status=0 and credited nothing.
   *  Real revenue — and real customers owed the coins they paid for. */
  gatewayPaidAppFailed: StatusMismatch[];
  /** The app marked it successful but no gateway ever confirmed it. Usually a month-boundary retry. */
  appPaidGatewayMissing: OrphanTxn[];
  /**
   * Rows the production INNER JOIN on `coins` deletes outright.
   *
   * NULL means WE CANNOT SEE THEM — not that there are none. For Hima the join lives inside
   * `gst_*_sales_v`, below our grants, so coin-less payments never reach us and an empty array
   * here would be a lie. Autopay revenue must be found from the gateway side (report.missing).
   */
  deletedByCoinJoin: StatusMismatch[] | null;
  /** Plain-English list of what this report is structurally unable to see. Never silently empty. */
  blindSpots: string[];
  totals: {
    gatewayPaidAppFailed: Totals;
    appPaidGatewayMissing: Totals;
    deletedByCoinJoin: Totals | null;
  };
}

/**
 * Compare gateway successes against EVERY app-DB row, not just the ones production files.
 *
 * Sees: money that arrived but the app disbelieved (status=0), and rows the app believed but no
 * gateway ever confirmed.
 *
 * Does NOT see: payments the app never recorded at all, because the `coins` inner join inside the
 * view removes them before we get there. Pass `coinlessVisible` from fetchAppDbAll() so the report
 * declares that blindness instead of quietly reporting zero.
 */
export function reconcileStatuses(
  gatewayTxns: Txn[],
  appDbAll: AppDbRow[],
  coinlessVisible = false,
): StatusReport {
  const gw = dedupeByOrderId(gatewayTxns);
  const gwByOrder = new Map(gw.kept.map((t) => [t.orderId, t]));
  const dbByOrder = new Map<string, AppDbRow>();
  for (const r of appDbAll) {
    const prev = dbByOrder.get(r.orderId);
    // Keep the most favourable row per order: a status=1 anywhere means the app believed it.
    if (!prev || r.status > prev.status) dbByOrder.set(r.orderId, r);
  }

  const gatewayPaidAppFailed: StatusMismatch[] = [];
  const deletedByCoinJoin: StatusMismatch[] = [];

  for (const [orderId, t] of gwByOrder) {
    const d = dbByOrder.get(orderId);
    if (!d) continue; // absent entirely → that's `missing`, not a status mismatch
    const m: StatusMismatch = {
      orderId,
      amount: t.amount,
      txnTimeIST: t.txnTimeIST,
      gateway: d.gateway,
      appStatus: d.status,
      appChecked: d.checked,
      noCoinPack: d.price == null,
    };
    if (d.status !== 1) gatewayPaidAppFailed.push(m);
    if (d.price == null) deletedByCoinJoin.push(m);
  }

  const appPaidGatewayMissing: OrphanTxn[] = [];
  for (const [orderId, d] of dbByOrder) {
    if (d.status !== 1 || !d.inMonth) continue;
    if (!gwByOrder.has(orderId)) {
      appPaidGatewayMissing.push({ orderId, amount: d.price ?? 0, txnTimeIST: d.txnTimeIST });
    }
  }

  const blindSpots: string[] = [];
  if (!coinlessVisible) {
    blindSpots.push(
      "Payments with no coin pack (every autopay/mandate charge) are removed by the `coins` INNER " +
        "JOIN inside gst_*_sales_v, below our grants. This report CANNOT see them and reports null, " +
        "not zero. They are visible only from the gateway side — see report.missing.byMethod (SBC_*).",
    );
  }

  return {
    gatewayPaidAppFailed,
    appPaidGatewayMissing,
    deletedByCoinJoin: coinlessVisible ? deletedByCoinJoin : null,
    blindSpots,
    totals: {
      gatewayPaidAppFailed: totals(gatewayPaidAppFailed),
      appPaidGatewayMissing: totals(appPaidGatewayMissing),
      deletedByCoinJoin: coinlessVisible ? totals(deletedByCoinJoin) : null,
    },
  };
}
