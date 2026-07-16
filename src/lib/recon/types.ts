/**
 * Gateway reconciliation layer — the normalised transaction shape.
 *
 * ADDITIVE AND READ-ONLY. Nothing in the production GST path (/api/sales → getConnector →
 * gst-core) imports this module. It exists to observe what each gateway actually settled and
 * compare that against what the app DB recorded. It does not change what we file.
 *
 * Every field below is shaped by something we proved against June-2026 data. See README.md.
 */

/** Which system a row was observed in. */
export type TxnSource = "cashfree" | "phonepe" | "razorpay" | "appdb";

/** Payment state, unified across gateways and the app DB. */
export type TxnStatus = "success" | "failed" | "refunded" | "unknown";

/** One payment as observed in ONE system. The reconciler compares these across systems. */
export interface Txn {
  /** Merchant order id — the join key between gateway and app DB. */
  orderId: string;

  /**
   * Gross amount ACTUALLY charged, in ₹, GST-inclusive.
   *
   * Never a coin-pack list price. The production app-DB query joins `coins` and reads
   * `c.price`, which cannot represent a discounted charge or a ₹1 mandate registration.
   */
  amount: number;

  status: TxnStatus;

  /**
   * Payment time in IST, always `YYYY-MM-DDTHH:mm:ss+05:30`. This is the GST basis.
   *
   * The app DB's own `datetime` is NOT authoritative: it stored a 2026-07-01T00:00:03 retry
   * under 30-Jun, pulling ₹299 into June's return when it belonged in July's.
   */
  txnTimeIST: string;

  source: TxnSource;

  /** Gateway payment method / group (UPI, SBC_UPI, PG_CC_FULFILMENT, …). Null when unknown. */
  method: string | null;

  /** Amount refunded against this payment (₹). 0 when none. */
  refunded: number;

  /**
   * Bank / UPI reference, where the source exposes one.
   *
   * A BLANK reference is NOT evidence of non-settlement. PhonePe's forward-transaction
   * "Transaction UTR" is a UPI-rail column, so every CARD payment carries it empty.
   * Proven: TXN_CARD_A (₹699, CARD) had no UTR in the forward file yet settled on
   * 10-Jun with bank reference UTR_CARD_A. Treating blank as unsettled would have
   * wrongly written off real revenue.
   */
  reference: string | null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function fromUtcMs(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+05:30`
  );
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const DMY = /^(\d{2})-(\d{2})-(\d{4})$/;
const HAS_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * 'YYYY-MM-DD HH:mm[:ss]' with NO timezone — already an IST wall-clock reading.
 *
 * Deliberately a pure string rewrite, never Date.parse: Node reads a naive string as
 * SERVER-local time, and this server runs UTC, so Date.parse would shift every PhonePe
 * timestamp back 5:30 and silently move end-of-month transactions into the previous month.
 */
export function istFromNaive(s: string): string {
  const m = NAIVE.exec(s.trim());
  if (!m) throw new Error(`istFromNaive: expected 'YYYY-MM-DD HH:mm[:ss]', got "${s}"`);
  const [, y, mo, d, hh, mi, ss] = m;
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss ?? "00"}+05:30`;
}

/** 'DD-MM-YYYY' (PhonePe's monthly settlement file) — date only, IST. Time is unknown → 00:00:00. */
export function istFromDmy(s: string): string {
  const m = DMY.exec(s.trim());
  if (!m) throw new Error(`istFromDmy: expected 'DD-MM-YYYY', got "${s}"`);
  const [, d, mo, y] = m;
  return `${y}-${mo}-${d}T00:00:00+05:30`;
}

/** An ISO-8601 string that CARRIES an offset (Cashfree's event_time). */
export function istFromOffsetIso(s: string): string {
  const t = s.trim();
  if (!HAS_OFFSET.test(t)) {
    throw new Error(
      `istFromOffsetIso: "${s}" has no timezone offset — use istFromNaive() instead ` +
        `(a naive string is IST wall-clock; Date.parse would read it as server-local).`,
    );
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`istFromOffsetIso: unparseable: "${s}"`);
  return fromUtcMs(ms);
}

/** Unix epoch SECONDS, UTC (Razorpay's created_at). */
export function istFromEpochSec(sec: number): string {
  if (!Number.isFinite(sec)) throw new Error(`istFromEpochSec: not a finite number: ${sec}`);
  return fromUtcMs(sec * 1000);
}

/** Is this IST timestamp inside the "YYYY-MM" period? The month boundary is IST, always. */
export function isInMonthIST(txnTimeIST: string, period: string): boolean {
  return txnTimeIST.startsWith(`${period}-`);
}

/**
 * Append every element of `source` to `target`.
 *
 * DO NOT "simplify" this to `target.push(...source)`. Spread passes each element as a separate
 * FUNCTION ARGUMENT, so a large array overflows the call stack: `RangeError: Maximum call stack
 * size exceeded`. It fails only at real data volume — the unit tests passed happily and it blew up
 * on PhonePe's 440k-row June export the first time this ran against the live month. Cashfree's
 * 173k transactions would have done the same thing to the recon route.
 */
export function pushAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}
