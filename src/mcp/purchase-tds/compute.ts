/**
 * Purchase/Vendor TDS — compute (spec §4, §6, §9). Classify → derive deductee PAN/entity → resolve
 * rate + challan code → emit the output contract, and aggregate per vendor·section·FY for the §6
 * thresholds. Rates: 194C via tds-core (validated); the flat sections via config (⚠ pending Shoyab).
 * TDS is ALWAYS on the taxable value EXCL GST, never on GST.
 */
import { entityTypeFromPan, statutoryRate } from "@/tds-core";
import type { PurchaseInvoice, PurchaseTdsLine } from "./types";
import { classifyInvoice, panFromGstin } from "./classify";
import { SECTION_RULES, THRESHOLDS, DE_MINIMIS_TDS } from "./config";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Indian financial year (Apr–Mar) of a YYYY-MM-DD date, e.g. 2026-06-15 → "2026-2027". */
function fyOf(date: string | null): string {
  const [y, m] = (date ?? "").split("-").map(Number);
  if (!y || !m) return "unknown";
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Classify + rate ONE invoice (no cross-invoice threshold decision — that needs the whole set). */
export function computeLine(inv: PurchaseInvoice): PurchaseTdsLine {
  const cls = classifyInvoice(inv);
  const info = entityTypeFromPan(panFromGstin(inv.vendorGstin));
  const flags = [...cls.flags];

  const line: PurchaseTdsLine = {
    docId: inv.docId,
    invoiceNumber: inv.invoiceNumber,
    vendorName: inv.vendorName,
    vendorGstin: inv.vendorGstin,
    deducteePan: info.pan,
    entityType: info.entity,
    section: cls.section,
    newCode: null,
    majorHead: null,
    rate: null,
    taxableValue: inv.taxableValue,
    tds: null,
    classificationBasis: cls.basis,
    confidence: cls.confidence,
    needsReview: cls.needsReview,
    belowThreshold: false,
    flags,
  };

  // Not classified → review (rate stays null). Pure goods → explicit zero, no TDS.
  if (!cls.section) return line;
  if (cls.section === "NONE") {
    line.rate = 0;
    line.tds = 0;
    return line;
  }

  const rule = SECTION_RULES[cls.section];
  const isCompany = info.deducteeClass === "COMPANY";
  line.majorHead = isCompany ? "0020" : "0021";
  const code = isCompany ? rule.codeCompany : rule.codeNonCompany;
  const codeConfirmed = isCompany ? rule.codeCompanyConfirmed : rule.codeNonCompanyConfirmed;
  line.newCode = code;
  if (code && !codeConfirmed) flags.push(`challan code ${code} (${cls.section}/${info.deducteeClass}) is ⚠ UNCONFIRMED — verify with Shoyab before filing`);
  if (!code) flags.push(`no challan code configured for ${cls.section}/${info.deducteeClass}`);

  // Bad/own/missing PAN → review, don't compute a confident rate (spec §4; 206AA 20% may apply).
  if (!info.valid) {
    flags.push("vendor PAN missing/invalid → review (206AA 20% may apply; entity rate unresolved)");
    line.needsReview = true;
    return line;
  }

  line.rate = rule.rateKind === "entity_194C" ? statutoryRate("194C", info.entity) : rule.flatRate ?? 0;

  if (inv.taxableValue == null) {
    flags.push("no taxable value (excl GST) captured — cannot compute TDS base");
    line.needsReview = true;
    return line;
  }
  line.tds = round2(line.rate * inv.taxableValue);
  return line;
}

/**
 * Classify + rate a SET of invoices and apply the §6 thresholds (aggregate per vendor·section·FY):
 * once a vendor's annual aggregate for a section crosses the limit, TDS is due on all its lines.
 * The per-line `tds` is always shown; `belowThreshold` marks lines not yet deductible.
 */
export function computePurchaseTds(invoices: PurchaseInvoice[]): PurchaseTdsLine[] {
  const lines = invoices.map(computeLine);

  const aggKey = (l: PurchaseTdsLine, inv: PurchaseInvoice) =>
    `${l.deducteePan ?? l.vendorName ?? "?"}|${l.section}|${fyOf(inv.invoiceDate)}`;

  const annual = new Map<string, number>();
  lines.forEach((l, i) => {
    if (l.section && l.section !== "NONE" && l.taxableValue != null) {
      const k = aggKey(l, invoices[i]);
      annual.set(k, (annual.get(k) ?? 0) + l.taxableValue);
    }
  });

  lines.forEach((l, i) => {
    if (!l.section || l.section === "NONE" || l.taxableValue == null || l.rate == null) return;
    const th = THRESHOLDS[l.section];
    const agg = annual.get(aggKey(l, invoices[i])) ?? l.taxableValue;
    const crosses = (th.perPayment > 0 && l.taxableValue >= th.perPayment) || agg >= th.annual;
    l.belowThreshold = !crosses;
    if (!crosses) l.flags.push(`below ${l.section} threshold (vendor FY aggregate ₹${round2(agg)} < ₹${th.annual}${th.perPayment ? `, payment < ₹${th.perPayment}` : ""}) — no deduction yet`);
    if (l.tds != null && l.tds > 0 && l.tds < DE_MINIMIS_TDS) l.flags.push(`TDS ₹${l.tds} below de-minimis ₹${DE_MINIMIS_TDS} — ignore`);
  });

  return lines;
}
