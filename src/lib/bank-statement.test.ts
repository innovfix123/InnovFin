import { describe, it, expect } from "vitest";
import { parseBankStatement, parseRcmPivot } from "./bank-statement";
import { computeRcm } from "@/gst-core/rcm";
import type { AOA } from "@/gst-core/gstr1";

describe("parseBankStatement", () => {
  it("HDFC layout: extracts withdrawals, ignores deposits", () => {
    const aoa: AOA = [
      ["HDFC BANK Ltd.", null],
      ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
      ["05/04/26", "POS 514834XX SAN FRANCISCO ANTHROPIC", "x", "05/04/26", 2784.83, null, 100],
      ["01/04/26", "NEFT CR-PHONEPE LIMITED", "y", "01/04/26", null, 1336172.63, 200], // deposit → ignored
    ];
    const rows = parseBankStatement(aoa);
    expect(rows).toHaveLength(1);
    expect(rows[0].narration).toContain("ANTHROPIC");
    expect(rows[0].amount).toBeCloseTo(2784.83, 2);
  });

  it("Yes Bank layout: Description + Withdrawals", () => {
    const aoa: AOA = [
      ["acct", null],
      ["Transaction Date", "Value Date", "Description", "Reference Number", "Withdrawals", "Deposits", "Running Balance"],
      ["01/04/2026", "01/04/2026", "PCA:CURSOR, AI POWERED IDE SAN FRANCISCO", "ref", 5850.42, null, "INR 1"],
    ];
    const rows = parseBankStatement(aoa);
    expect(rows).toHaveLength(1);
    expect(rows[0].narration).toContain("CURSOR");
    expect(rows[0].amount).toBeCloseTo(5850.42, 2);
  });
});

describe("parseRcmPivot + computeRcm", () => {
  it("reads only RCM-flagged rows, then classifies foreign/rent (Tamil excluded)", () => {
    const aoa: AOA = [
      ["Sum of Withdrawal Amt."],
      ["Expense Categorisation", "Total", "Incharge", "Status", "Flag"],
      ["Agora Payment", 1503893.21, "Ayush", "Received", "RCM Applicable"],
      ["Salary", 1280896, "Ayush", "Collect", "Ignore"],
      ["Rent JP", 75000, "JP", "Collect", "RCM Applicable"],
      ["Tamil Rent", 11000, "Tamil", "Ok", "RCM Applicable"],
    ];
    const expenses = parseRcmPivot(aoa);
    expect(expenses.map((e) => e.vendor)).toEqual(["Agora Payment", "Rent JP", "Tamil Rent"]);

    const r = computeRcm(expenses);
    expect(r.foreign.taxable).toBe(1503893); // Agora, rupee-rounded
    expect(r.rent.taxable).toBe(75000); // Rent JP only — Tamil excluded by the classifier
    expect(r.excluded.map((l) => l.vendor)).toContain("Tamil Rent");
  });
});
