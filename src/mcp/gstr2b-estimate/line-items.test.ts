import { describe, it, expect } from "vitest";
import { parseLineItems } from "./line-items";
import { toRegistryInvoice } from "./source";
import { evaluateLine } from "./compute";

/** The real Cashfree June-2026 tax invoice text (CF/26-27/54529), as stored by the registry. */
const CASHFREE_TEXT = `TAX INVOICE
Original for Recipient
Billed To:
Invoice No: CF/26-27/54529
Entity ID: 970202
Period: Jun, 2026
GSTIN: 29AAICP2912R1ZR
INNOVFIX PRIVATE LIMITED
Date: Jun 30, 2026
Place of Supply: 29/Karnataka
GROUND FLOOR, INDIQUBE ASCENT,
BENGALURU URBAN, KARNATAKA,
560034
BANGALORE SOUTH,Karnataka 560034
IRN : 49fbf22d0582cde65508b0a3df9d96a2a726070814a6a
572d50b79099193d0f4
GSTIN: 29AAICI1603A1Z3
DESCRIPTION
HSN/SAC
GST %
QUANTITY
AMOUNT
TRANSACTED (INR)
CHARGES (INR)
PAYOUT
Account ID: 89647
Payouts Disbursed
997158
18.00
88614
26,367,383.03
288,014.00
SUBSCRIPTION
Account ID: 970202
Master Credit Mandate Creation Charges MDR
997158
18.00
1
0.00
7.51
Master Debit Mandate Creation Charges MDR
997158
18.00
1
0.00
7.51
Master Debit Per Execution Charges MDR
997158
18.00
1
299.00
13.33
UPI Autopay Mandate Creation Charges for Slab
transaction amount 250 to 1000
997158
18.00
5257
0.00
26,285.00
UPI Autopay Per Execution Charges for Slab transaction
amount 250 to 1000
997158
18.00
274
81,926.00
1,370.00
Visa Credit Mandate Creation Charges MDR
997158
18.00
2
0.00
15.03
Visa Credit Per Execution Charges MDR
997158
18.00
1
299.00
13.33
Visa Debit Mandate Creation Charges MDR
997158
18.00
1
0.00
7.51
PAYMENT GATEWAY*
Account ID: 970202
Payment Gateway Charges (Only card txns up to Rs.
2,000) (GST Exempt)
997159
0.00
7
603.00
0.00
Payment Gateway Charges (excludes Card transactions
upto Rs. 2000)
997158
18.00
173172
39,776,000.00
426,445.35
PAN Verification
Account ID: 89647
PAN Verification
997158
18.00
6763
0.00
8,453.75
Taxable Sub Total
INR 750,632.35
CGST @ 9%
INR 67,556.91
SGST @ 9%
INR 67,556.91
Total Amount Received
INR 885,746.18`;

/** An Anthropic (OIDAR) invoice — a DIFFERENT layout the Cashfree parser must not touch. */
const ANTHROPIC_TEXT = `Invoice
Invoice number
5CR0HBCL-0004
VAT Registration India GST:
9924USA29003OSI
Anthropic, PBC
Bill to
IN GST 29AAICI1603A1Z3
$100.00 USD due June 6, 2026
Total
$100.00`;

describe("parseLineItems — Cashfree charge table", () => {
  const bd = parseLineItems(CASHFREE_TEXT, 750632.35);

  it("parses every charge row", () => {
    expect(bd).not.toBeNull();
    expect(bd!.source).toBe("cashfree-tax-invoice");
    expect(bd!.count).toBe(12);
  });

  it("reads the first row (Payouts Disbursed) with charge vs transacted kept apart", () => {
    expect(bd!.items[0]).toEqual({
      category: "PAYOUT",
      description: "Payouts Disbursed",
      hsnSac: "997158",
      gstRatePct: 18,
      quantity: 88614,
      amountTransacted: 26367383.03, // volume — NOT taxable
      charge: 288014, // the taxable fee
    });
  });

  it("joins a multi-line description into one", () => {
    const upi = bd!.items.find((i) => i.description.startsWith("UPI Autopay Mandate"));
    expect(upi!.description).toBe("UPI Autopay Mandate Creation Charges for Slab transaction amount 250 to 1000");
    expect(upi!.charge).toBe(26285);
  });

  it("captures the GST-exempt payment-gateway row (0% / ₹0 charge)", () => {
    const exempt = bd!.items.find((i) => i.hsnSac === "997159");
    expect(exempt).toMatchObject({ category: "PAYMENT GATEWAY", gstRatePct: 0, charge: 0 });
  });

  it("distinguishes the 'PAN Verification' section header from its identically named row", () => {
    const pan = bd!.items.filter((i) => i.category === "PAN VERIFICATION");
    expect(pan).toHaveLength(1);
    expect(pan[0]).toMatchObject({ description: "PAN Verification", charge: 8453.75 });
  });

  it("rolls charges up by category", () => {
    const cats = Object.fromEntries(bd!.byCategory.map((c) => [c.category, c]));
    expect(cats["PAYMENT GATEWAY"]).toEqual({ category: "PAYMENT GATEWAY", lines: 2, charge: 426445.35 });
    expect(cats["PAYOUT"]).toEqual({ category: "PAYOUT", lines: 1, charge: 288014 });
    expect(cats["SUBSCRIPTION"]).toEqual({ category: "SUBSCRIPTION", lines: 8, charge: 27719.22 });
    expect(cats["PAN VERIFICATION"]).toEqual({ category: "PAN VERIFICATION", lines: 1, charge: 8453.75 });
    // biggest category first
    expect(bd!.byCategory[0].category).toBe("PAYMENT GATEWAY");
  });

  it("reconciles the summed charges to the invoice's taxable value (within line-rounding slack)", () => {
    expect(bd!.taxableFromLines).toBe(750632.32); // vs stated 750,632.35 → 3-paise line rounding
    expect(bd!.reconcilesToTaxable).toBe(true);
  });

  it("reports reconcilesToTaxable = null when the taxable value is unknown", () => {
    expect(parseLineItems(CASHFREE_TEXT)!.reconcilesToTaxable).toBeNull();
  });
});

describe("parseLineItems — graceful fallback", () => {
  it("returns null for a non-Cashfree invoice layout", () => {
    expect(parseLineItems(ANTHROPIC_TEXT, 100)).toBeNull();
  });

  it("returns null for empty / missing text", () => {
    expect(parseLineItems(null)).toBeNull();
    expect(parseLineItems(undefined)).toBeNull();
    expect(parseLineItems("")).toBeNull();
  });
});

describe("line items flow through to the estimate line", () => {
  it("toRegistryInvoice → evaluateLine carries the breakdown onto itc_invoices", () => {
    const inv = toRegistryInvoice({
      doc_id: "d1",
      fields: {
        invoice_number: "CF/26-27/54529",
        invoice_date: "2026-06-30",
        vendor_gstin: "29AAICP2912R1ZR",
        taxable_value: 750632.35,
        cgst: 67556.91,
        sgst: 67556.91,
        total: 885746.18,
      },
      source: { sender: "shoyab@innovfix.in", received_date: "2026-07-07" },
      text: CASHFREE_TEXT,
    });
    expect(inv.lineItems?.count).toBe(12);

    const line = evaluateLine(inv);
    expect(line.included).toBe(true); // clean intra-state CGST+SGST invoice → headline
    expect(line.lineItems?.taxableFromLines).toBe(750632.32);
    expect(line.lineItems?.byCategory[0].category).toBe("PAYMENT GATEWAY");
  });
});
