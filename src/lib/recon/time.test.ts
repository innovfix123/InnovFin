import { describe, it, expect } from "vitest";
import { istFromNaive, istFromDmy, istFromOffsetIso, istFromEpochSec, isInMonthIST } from "./types";

describe("IST normalisation", () => {
  it("treats a naive gateway timestamp as IST wall-clock, not server time", () => {
    // This server runs UTC. Date.parse("2026-06-30 23:59:47") would read it as 23:59:47 UTC
    // and shift it back 5:30 — silently moving end-of-month rows into the previous month.
    expect(istFromNaive("2026-06-30 23:59:47")).toBe("2026-06-30T23:59:47+05:30");
    expect(istFromNaive("2026-07-01T00:00:03")).toBe("2026-07-01T00:00:03+05:30");
  });

  it("reads PhonePe's monthly settlement dates as DAY-first", () => {
    // 'DD-MM-YYYY'. Read as ISO, 06-07-2026 would become 6 July instead of 7 June.
    expect(istFromDmy("07-06-2026")).toBe("2026-06-07T00:00:00+05:30");
    expect(istFromDmy("30-06-2026")).toBe("2026-06-30T00:00:00+05:30");
  });

  it("converts an offset-carrying ISO string (Cashfree event_time) to IST", () => {
    expect(istFromOffsetIso("2026-06-30T23:59:47+05:30")).toBe("2026-06-30T23:59:47+05:30");
    expect(istFromOffsetIso("2026-06-30T18:29:47Z")).toBe("2026-06-30T23:59:47+05:30");
  });

  it("refuses a naive string, rather than guessing its timezone", () => {
    expect(() => istFromOffsetIso("2026-06-30 23:59:47")).toThrow(/no timezone offset/);
  });

  it("converts Razorpay's UTC epoch seconds to IST", () => {
    // 2026-06-30T18:29:47Z === 2026-06-30 23:59:47 IST
    expect(istFromEpochSec(Date.UTC(2026, 5, 30, 18, 29, 47) / 1000)).toBe("2026-06-30T23:59:47+05:30");
  });

  describe("the month boundary is IST", () => {
    it("keeps the last second of June in June", () => {
      expect(isInMonthIST("2026-06-30T23:59:59+05:30", "2026-06")).toBe(true);
    });

    it("puts the TXN_RETRY_A retry in JULY, where it belongs", () => {
      // The failed attempt was 30-Jun 23:59:47; the SUCCESS was 16 seconds later, on 1 July.
      // The app DB stored it under 30-Jun and pulled ₹299 into the wrong return.
      expect(isInMonthIST("2026-07-01T00:00:03+05:30", "2026-06")).toBe(false);
      expect(isInMonthIST("2026-07-01T00:00:03+05:30", "2026-07")).toBe(true);
    });

    it("does not confuse 2026-06 with 2026-06x prefixes", () => {
      expect(isInMonthIST("2026-06-01T00:00:00+05:30", "2026-0")).toBe(false);
    });
  });
});
