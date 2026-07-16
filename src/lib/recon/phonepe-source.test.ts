import { describe, it, expect } from "vitest";
import { parsePhonePeCsv, parsePhonePeFiles, detectFormat } from "./phonepe-source";
import { grossOf } from "./dedupe";

// Header rows copied verbatim from the real June-2026 Hima exports (merchant MERCHANT_A),
// trimmed to the columns this layer reads. The point of these fixtures is that PhonePe's three
// formats genuinely disagree, and the parser must not be fooled by any of them.

const FORWARD_HEAD =
  "Merchant Id,Merchant Order Id,PhonePe Transaction Id,Transaction Type,Transaction Date,Transaction Amount,Instrument,Transaction Status,Transaction UTR";
const SETTLEMENT_HEAD =
  "Merchant ID,Merchant Order Id,PhonePe Transaction ID,Payment Type,Transaction Date,Transaction Amount,Instrument,Transaction Status,Settlement Date,Settlement UTR,UPI_UTR,Card_ARN";
const MONTHLY_HEAD =
  "PaymentType,MerchantReferenceId,PhonePeReferenceId,Instrument,CreationDate,TransactionDate,SettlementDate,BankReferenceNo,Amount";

describe("PhonePe format detection", () => {
  it("tells the three report shapes apart from their headers", () => {
    expect(detectFormat(FORWARD_HEAD.split(","))).toBe("forward");
    expect(detectFormat(SETTLEMENT_HEAD.split(","))).toBe("settlement");
    expect(detectFormat(MONTHLY_HEAD.split(","))).toBe("monthly-settlement");
    expect(detectFormat(["Merchant Id", "Total Refund Amount", "Transaction Status"])).toBe("refund");
  });

  it("recognises the MDR fee invoice and refuses to treat it as sales", () => {
    // INV_A_2026_06_30.csv is PhonePe's commission invoice — 194H, not outward supply.
    // Summing its "Transaction Amount" into GSTR-1 would invent revenue that never existed.
    const fee = ["Invoice No", "Invoice Date", "Transaction Date", "Transaction Amount", "Taxable Amount", "CGST", "SGST"];
    expect(detectFormat(fee)).toBe("fee-invoice");
    const r = parsePhonePeCsv(`${fee.join(",")}\nINV_A,30-06-2026,29-06-2026,3.5282,2.99,0.2691,0.2691`);
    expect(r.txns).toHaveLength(0);
  });
});

describe("PhonePe parsing", () => {
  it("reads a forward SUCCESS row, keeping the IST wall-clock", () => {
    const csv = `${FORWARD_HEAD}\nMERCHANT_A,TXN_FWD_A,OM26,FORWARD_TRANSACTION,2026-06-19 00:00:11,25.0,UPI,SUCCESS,239056505231`;
    const r = parsePhonePeCsv(csv);
    expect(r.format).toBe("forward");
    expect(r.txns[0]).toMatchObject({
      orderId: "TXN_FWD_A",
      amount: 25,
      status: "success",
      txnTimeIST: "2026-06-19T00:00:11+05:30",
      reference: "239056505231",
    });
  });

  it("maps the settlement report's COMPLETED to success", () => {
    // The settlement file says COMPLETED where the forward file says SUCCESS. Matching only on
    // the literal "SUCCESS" would silently value the entire settlement report at zero.
    const csv = `${SETTLEMENT_HEAD}\nMERCHANT_A,TXN_SETTLED_A,OM26,PAYMENT,2026-06-03 23:24:01,299.0,UPI,COMPLETED,2026-06-04 16:24:05,UTR_A,203383638045,`;
    const r = parsePhonePeCsv(csv);
    expect(r.format).toBe("settlement");
    expect(r.txns[0].status).toBe("success");
    expect(r.txns[0].amount).toBe(299);
  });

  it("does NOT treat a blank UTR as a failed payment (the ₹699 CARD case)", () => {
    // TXN_CARD_A: a card payment. "Transaction UTR" is a UPI-rail column, so it is empty —
    // yet the money settled on 10-Jun with bank reference UTR_CARD_A. Writing this off as
    // unsettled would have deleted real revenue and denied a customer 2,500 coins.
    const fwd = `${FORWARD_HEAD}\nMERCHANT_A,TXN_CARD_A,,FORWARD_TRANSACTION,2026-06-09 21:23:09,699.0,CARD,SUCCESS,`;
    const r = parsePhonePeCsv(fwd);
    expect(r.txns[0].status).toBe("success");
    expect(r.txns[0].amount).toBe(699);
    expect(r.txns[0].reference).toBeNull(); // blank — and that is fine

    const stl = `${MONTHLY_HEAD}\nPAYMENT,TXN_CARD_A,T2606,PG_CC_FULFILMENT,09-06-2026,09-06-2026,10-06-2026,UTR_CARD_A,699`;
    expect(parsePhonePeCsv(stl).txns[0].reference).toBe("UTR_CARD_A");
  });

  it("reads the monthly settlement file's dates DAY-first", () => {
    const csv = `${MONTHLY_HEAD}\nPAYMENT,TXN1,T26,UPI_FULFILMENT,01-06-2026,07-06-2026,08-06-2026,UTR1,64`;
    // 07-06-2026 is 7 JUNE. An ISO reader would call it 6 July and file it in the wrong month.
    expect(parsePhonePeCsv(csv).txns[0].txnTimeIST).toBe("2026-06-07T00:00:00+05:30");
  });
});

describe("PhonePe across overlapping exports", () => {
  it("collapses the same order seen in the forward AND settlement files into one sale", () => {
    // The exports overlap by design; PhonePe also repeats rows inside a single file. Summing
    // them naively double-counts — which is precisely the failure mode we are chasing.
    const fwd = `${FORWARD_HEAD}\nM,TXN_A,OM,FORWARD_TRANSACTION,2026-06-10 10:00:00,299.0,UPI,SUCCESS,U1`;
    const stl = `${SETTLEMENT_HEAD}\nM,TXN_A,OM,PAYMENT,2026-06-10 10:00:00,299.0,UPI,COMPLETED,2026-06-11 16:00:00,UTR1,U1,`;
    const r = parsePhonePeFiles([{ name: "fwd.csv", text: fwd }, { name: "stl.csv", text: stl }], "2026-06");
    expect(r.txns).toHaveLength(1);
    expect(grossOf(r.txns)).toBe(299);
  });

  it("pushes the 01-Jul retry out of June instead of counting it", () => {
    const fwd =
      `${FORWARD_HEAD}\n` +
      `M,TXN_RETRY_A,OM1,FORWARD_TRANSACTION,2026-06-30 23:59:47,299.0,UPI,FAILED,\n` +
      `M,TXN_RETRY_A,OM2,FORWARD_TRANSACTION,2026-07-01 00:00:03,299.0,UPI,SUCCESS,876634387692`;
    const r = parsePhonePeFiles([{ name: "fwd.csv", text: fwd }], "2026-06");
    expect(r.txns).toHaveLength(0);        // not June's revenue…
    expect(r.outOfMonth).toHaveLength(1);  // …but surfaced, not silently swallowed
    expect(r.outOfMonth[0].txnTimeIST).toBe("2026-07-01T00:00:03+05:30");
  });

  // 30s, not the 5s default: the volume IS the test. Building and parsing 200k rows takes ~5s, so
  // the default timeout fails it for being slow while the code under test is perfectly healthy.
  // Do not shrink the row count to make it fit — a smaller array does not overflow the stack, and
  // the test stops testing anything.
  it("survives a real-sized export (200k rows) without overflowing the stack", { timeout: 30_000 }, () => {
    // This is a REGRESSION TEST, not a hypothetical. `all.push(...r.txns)` passes every element as
    // a separate function argument, so it dies with "Maximum call stack size exceeded" once the
    // array is large enough. All 168 unit tests passed while that bug was live — it surfaced only
    // when the parser first met PhonePe's actual 441k-row June export. Volume is the only thing
    // that catches it, so the test carries the volume.
    const rows: string[] = [FORWARD_HEAD];
    for (let i = 0; i < 200_000; i++) {
      rows.push(`M,TXN_BULK_${i},OM,FORWARD_TRANSACTION,2026-06-15 10:00:00,10.0,UPI,SUCCESS,U${i}`);
    }
    const r = parsePhonePeFiles([{ name: "big.csv", text: rows.join("\n") }], "2026-06");
    expect(r.txns).toHaveLength(200_000);
    expect(grossOf(r.txns)).toBe(2_000_000);
  });

  it("June had no PhonePe refunds — an empty refund file parses to nothing, not a crash", () => {
    const head =
      "Merchant Id,Transaction Type,Merchant Order Id,Transaction Amount,Total Refund Amount,Transaction Date,Transaction Status";
    const r = parsePhonePeCsv(head); // header only — exactly what PhonePe shipped for June
    expect(r.format).toBe("refund");
    expect(r.txns).toHaveLength(0);
    expect(r.refunds).toEqual({});
  });
});
