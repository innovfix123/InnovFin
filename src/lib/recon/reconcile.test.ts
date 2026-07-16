import { describe, it, expect } from "vitest";
import { reconcile, reconcileStatuses, totals } from "./reconcile";
import type { AppDbRow } from "./appdb-source";
import type { Txn } from "./types";

const gw = (orderId: string, amount: number, p: Partial<Txn> = {}): Txn => ({
  orderId, amount,
  status: "success",
  txnTimeIST: "2026-06-15T12:00:00+05:30",
  source: "cashfree",
  method: "UPI",
  refunded: 0,
  reference: null,
  ...p,
});

const db = (orderId: string, amount: number, p: Partial<Txn> = {}): Txn =>
  gw(orderId, amount, { source: "appdb", method: "Cashfree", ...p });

describe("reconcile — the June-2026 shape", () => {
  // A miniature of the real month: ordinary coin purchases that BOTH sides see, autopay charges
  // only the GATEWAY sees (the app's `JOIN coins` deletes them), and one phantom row only the APP
  // sees. This is exactly the composition the live reconciliation produced.
  const gatewayTxns = [
    gw("ORD_1", 299),
    gw("ORD_2", 129),
    gw("SBC_A", 1, { method: "SBC_UPI" }),      // mandate registration
    gw("SBC_B", 1, { method: "SBC_UPI" }),
    gw("SBC_C", 299, { method: "SBC_UPI" }),    // recurring debit
    gw("SBC_D", 100, { method: "SBC_CREDIT_CARD" }),
  ];
  const appDbTxns = [
    db("ORD_1", 299),
    db("ORD_2", 129),
    db("ORPHAN", 299), // app says paid; no gateway ever confirmed it
  ];

  const r = reconcile({ app: "Hima", period: "2026-06", gatewayTxns, appDbTxns });

  it("the identity holds: gap === missing − orphans + amountDeltas", () => {
    // Gateway 829 − appDB 727 = 102.  Missing 401 − orphan 299 + 0 = 102.
    expect(r.gateway.gross).toBe(829);
    expect(r.appDb.gross).toBe(727);
    expect(r.gap.gross).toBe(102);
    expect(r.missing.totals.gross).toBe(401);
    expect(r.orphans.totals.gross).toBe(299);
    expect(r.amountDeltas.total).toBe(0);
    expect(r.residual).toBe(0);
    expect(r.reconciles).toBe(true);
  });

  it("names the CAUSE of the missing money by payment method", () => {
    // This is the line that would have caught the leak months ago: the money the app DB never
    // saw is not random — it is entirely autopay.
    expect(r.missing.byMethod["SBC_UPI"]).toMatchObject({ count: 3, gross: 301 });
    expect(r.missing.byMethod["SBC_CREDIT_CARD"]).toMatchObject({ count: 1, gross: 100 });
    expect(r.missing.byMethod["UPI"]).toBeUndefined(); // ordinary purchases all reconcile
  });

  it("reports the orphan the app believed and no gateway confirmed", () => {
    expect(r.orphans.txns).toEqual([{ orderId: "ORPHAN", amount: 299, txnTimeIST: "2026-06-15T12:00:00+05:30" }]);
  });

  it("converts to taxable at the same GST rate the filing engine uses", () => {
    expect(r.gateway.taxable).toBeCloseTo(829 / 1.18, 6);
  });
});

describe("reconcile — the traps", () => {
  it("dedupes BOTH sides before comparing, so a duplicate row is not read as a difference", () => {
    // PhonePe duplicates rows in its OWN settlement report, and the app DB duplicated ₹299 too.
    // Comparing raw rows would invent a gap that does not exist.
    const r = reconcile({
      app: "Hima", period: "2026-06",
      gatewayTxns: [gw("TXN_D", 299), gw("TXN_D", 299)],
      appDbTxns: [db("TXN_D", 299), db("TXN_D", 299)],
    });
    expect(r.gateway.gross).toBe(299);
    expect(r.appDb.gross).toBe(299);
    expect(r.gap.gross).toBe(0);
    expect(r.duplicates.gatewayOrderIds).toEqual(["TXN_D"]);
    expect(r.duplicates.appDbOrderIds).toEqual(["TXN_D"]);
    expect(r.reconciles).toBe(true);
  });

  it("catches a matched order whose amounts DISAGREE (a coupon or a mispriced pack)", () => {
    const r = reconcile({
      app: "Hima", period: "2026-06",
      gatewayTxns: [gw("ORD_C", 199)],  // what the customer actually paid
      appDbTxns: [db("ORD_C", 299)],    // the coin pack's LIST price — what we billed GST on
      });
    expect(r.amountDeltas.txns).toEqual([
      { orderId: "ORD_C", gatewayAmount: 199, appDbAmount: 299, delta: -100 },
    ]);
    expect(r.residual).toBe(0);
    expect(r.reconciles).toBe(true);
  });

  it("reports the out-of-month retry instead of swallowing it", () => {
    const r = reconcile({
      app: "Hima", period: "2026-06",
      gatewayTxns: [gw("ORD_1", 299)],
      gatewayOutOfMonth: [gw("TXN_RETRY_A", 299, { txnTimeIST: "2026-07-01T00:00:03+05:30", source: "phonepe" })],
      appDbTxns: [db("ORD_1", 299)],
    });
    expect(r.monthBoundary.totals.gross).toBe(299);
    expect(r.monthBoundary.txns[0].txnTimeIST).toBe("2026-07-01T00:00:03+05:30");
    expect(r.gateway.gross).toBe(299); // and it is NOT in June's base
  });

  it("splits the gateway total by source, because Hima has two", () => {
    const r = reconcile({
      app: "Hima", period: "2026-06",
      gatewayTxns: [gw("C1", 100, { source: "cashfree" }), gw("P1", 200, { source: "phonepe" })],
      appDbTxns: [],
    });
    expect(r.gatewayBySource.cashfree).toMatchObject({ count: 1, gross: 100 });
    expect(r.gatewayBySource.phonepe).toMatchObject({ count: 1, gross: 200 });
  });

  it("reports refunds without deleting the sale", () => {
    const r = reconcile({
      app: "Sudar", period: "2026-06",
      gatewayTxns: [gw("pay_R", 49, { status: "refunded", refunded: 49, source: "razorpay" })],
      appDbTxns: [],
    });
    expect(r.gateway.gross).toBe(49);      // the supply still happened
    expect(r.refunds).toEqual({ count: 1, amount: 49 });
  });

  it("holds the identity on a randomised set — residual is a self-check on this code", () => {
    const g: Txn[] = [];
    const d: Txn[] = [];
    for (let i = 0; i < 200; i++) {
      const amt = 25 + ((i * 37) % 500);
      if (i % 7 === 0) g.push(gw(`only_gw_${i}`, amt));            // missing from app DB
      else if (i % 11 === 0) d.push(db(`only_db_${i}`, amt));      // orphan
      else if (i % 13 === 0) { g.push(gw(`delta_${i}`, amt)); d.push(db(`delta_${i}`, amt + 10)); }
      else { g.push(gw(`both_${i}`, amt)); d.push(db(`both_${i}`, amt)); }
    }
    const r = reconcile({ app: "Hima", period: "2026-06", gatewayTxns: g, appDbTxns: d });
    expect(r.residual).toBeCloseTo(0, 9);
    expect(r.reconciles).toBe(true);
  });
});

describe("reconcileStatuses — what the production query hides", () => {
  const row = (orderId: string, p: Partial<AppDbRow> = {}): AppDbRow => ({
    orderId,
    txnTimeIST: "2026-06-15T12:00:00+05:30",
    price: 299,
    status: 1,
    checked: 1,
    gateway: "PhonePe",
    inMonth: true,
    ...p,
  });

  it("finds money the gateway took that the app left at status=0", () => {
    // Real revenue the app never credited — and real customers who never got their coins.
    const s = reconcileStatuses(
      [gw("TXN_PAID", 699, { source: "phonepe" }), gw("TXN_OK", 299, { source: "phonepe" })],
      [row("TXN_PAID", { status: 0, price: 699 }), row("TXN_OK", { status: 1 })],
    );
    expect(s.gatewayPaidAppFailed).toHaveLength(1);
    expect(s.gatewayPaidAppFailed[0]).toMatchObject({ orderId: "TXN_PAID", appStatus: 0, amount: 699 });
    expect(s.totals.gatewayPaidAppFailed.gross).toBe(699);
  });

  it("finds the row the app believed that no gateway ever confirmed", () => {
    const s = reconcileStatuses([], [row("CF_ORPHAN_A", { status: 1, price: 299 })]);
    expect(s.appPaidGatewayMissing).toEqual([
      { orderId: "CF_ORPHAN_A", amount: 299, txnTimeIST: "2026-06-15T12:00:00+05:30" },
    ]);
  });

  it("finds the coin-less rows WHEN it can see them", () => {
    // An autopay charge has no coin pack, so `JOIN coins ON c.id = p.coin_id` removes it — even
    // though status=1 and the money settled. This is the autopay revenue the return misses.
    const s = reconcileStatuses(
      [gw("SBC_1", 1, { method: "SBC_UPI" })],
      [row("SBC_1", { price: null, status: 1 })],
      true, // coinlessVisible — i.e. we are reading a source that exposes them
    );
    expect(s.deletedByCoinJoin).toHaveLength(1);
    expect(s.deletedByCoinJoin?.[0].noCoinPack).toBe(true);
    expect(s.totals.deletedByCoinJoin?.gross).toBe(1);
    expect(s.blindSpots).toEqual([]);
  });

  it("reports NULL, never a reassuring zero, when it is blind to coin-less rows", () => {
    // Hima's views INNER JOIN `coins` below our grants, so autopay payments never reach us.
    // A report that answered "0 rows deleted" here would be stating the opposite of the truth:
    // the autopay revenue IS being deleted — we simply cannot observe it from this side.
    const s = reconcileStatuses([gw("SBC_1", 1, { method: "SBC_UPI" })], [], false);
    expect(s.deletedByCoinJoin).toBeNull();
    expect(s.totals.deletedByCoinJoin).toBeNull();
    expect(s.blindSpots).toHaveLength(1);
    expect(s.blindSpots[0]).toMatch(/CANNOT see them/);
  });
});

describe("totals", () => {
  it("divides out GST at 18%", () => {
    expect(totals([{ amount: 118 }])).toEqual({ count: 1, gross: 118, taxable: 100 });
  });
});
