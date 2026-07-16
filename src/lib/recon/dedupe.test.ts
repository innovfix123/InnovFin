import { describe, it, expect } from "vitest";
import { dedupeByOrderId, grossOf } from "./dedupe";
import type { Txn } from "./types";

const txn = (p: Partial<Txn> & Pick<Txn, "orderId">): Txn => ({
  amount: 299,
  status: "success",
  txnTimeIST: "2026-06-15T12:00:00+05:30",
  source: "phonepe",
  method: "UPI",
  refunded: 0,
  reference: null,
  ...p,
});

describe("dedupeByOrderId — the real June-2026 cases", () => {
  it("TXN_DUP_A: a duplicated row is ONE sale, not two", () => {
    // The same order appeared twice at ₹299 in the app DB. The customer was charged once and
    // credited once; the second row is a database artefact.
    const r = dedupeByOrderId([
      txn({ orderId: "TXN_DUP_A" }),
      txn({ orderId: "TXN_DUP_A" }),
    ]);
    expect(r.kept).toHaveLength(1);
    expect(grossOf(r.kept)).toBe(299);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe("duplicate-of-kept");
    expect(r.duplicateOrderIds).toEqual(["TXN_DUP_A"]);
  });

  it("TXN_RETRY_A: keeps the SUCCESSFUL retry, not the earlier failure", () => {
    // PhonePe reuses the order id across retries. FAILED at 30-Jun 23:59:47, SUCCESS 16 seconds
    // later at 01-Jul 00:00:03. "Keep the first row" would have kept the failure and thrown away
    // the money that actually settled.
    const r = dedupeByOrderId([
      txn({ orderId: "TXN_RETRY_A", status: "failed", txnTimeIST: "2026-06-30T23:59:47+05:30" }),
      txn({ orderId: "TXN_RETRY_A", status: "success", txnTimeIST: "2026-07-01T00:00:03+05:30" }),
    ]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].status).toBe("success");
    expect(r.kept[0].txnTimeIST).toBe("2026-07-01T00:00:03+05:30");
    expect(r.dropped[0].reason).toBe("failed-attempt-of-successful-order");
  });

  it("drops an order where every attempt failed", () => {
    const r = dedupeByOrderId([
      txn({ orderId: "TXN_DEAD", status: "failed", txnTimeIST: "2026-06-10T10:00:00+05:30" }),
      txn({ orderId: "TXN_DEAD", status: "failed", txnTimeIST: "2026-06-10T10:00:09+05:30" }),
    ]);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason)).toEqual(["all-attempts-failed", "all-attempts-failed"]);
  });

  it("keeps a refunded sale — the supply happened", () => {
    // The current Razorpay path deletes these outright. The sale is real; only its PRESENTATION
    // (net off vs credit note) is undecided.
    const r = dedupeByOrderId([txn({ orderId: "order_X", status: "refunded", amount: 49, refunded: 49 })]);
    expect(r.kept).toHaveLength(1);
    expect(grossOf(r.kept)).toBe(49);
    expect(r.kept[0].refunded).toBe(49);
  });

  it("never loses a refund recorded on the duplicate row we discard", () => {
    const r = dedupeByOrderId([
      txn({ orderId: "order_Y", status: "refunded", amount: 99, refunded: 99, txnTimeIST: "2026-06-01T09:00:00+05:30" }),
      txn({ orderId: "order_Y", status: "success", amount: 99, refunded: 0, txnTimeIST: "2026-06-01T09:00:01+05:30" }),
    ]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].refunded).toBe(99);
  });

  it("flags duplicated successes whose amounts DISAGREE — a genuine double-charge looks like this", () => {
    const r = dedupeByOrderId([
      txn({ orderId: "order_Z", amount: 299 }),
      txn({ orderId: "order_Z", amount: 499 }),
    ]);
    expect(r.amountConflicts).toEqual([{ orderId: "order_Z", amounts: [299, 499] }]);
    expect(r.kept).toHaveLength(1); // still collapses, but loudly
  });

  it("is deterministic when duplicate rows share a timestamp", () => {
    const rows = [txn({ orderId: "o", amount: 10 }), txn({ orderId: "o", amount: 10 })];
    expect(grossOf(dedupeByOrderId(rows).kept)).toBe(grossOf(dedupeByOrderId([...rows]).kept));
  });

  it("accounts for every input row: kept + dropped === input", () => {
    const rows = [
      txn({ orderId: "a" }),
      txn({ orderId: "a", status: "failed" }),
      txn({ orderId: "b" }),
      txn({ orderId: "c", status: "failed" }),
    ];
    const r = dedupeByOrderId(rows);
    expect(r.kept.length + r.dropped.length).toBe(rows.length);
  });
});
