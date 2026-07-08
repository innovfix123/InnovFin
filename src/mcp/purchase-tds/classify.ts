/**
 * Purchase/Vendor TDS — the classification engine (spec §1–§3). Tax-judgment-free: it only applies
 * the precedence (vendor override → SAC map → keyword fallback → review) over the config rules.
 * Unknown / ambiguous / mixed → `needsReview`, never silently classified (spec §1, §7).
 */
import { OWN_PAN } from "@/tds-core";
import type { Classification, PurchaseInvoice, PurchaseSection } from "./types";
import { SAC_SECTION_MAP, VENDOR_OVERRIDES, KEYWORD_RULES, type OverrideRule } from "./config";

// 15-char GSTIN: 2 state + 10-char PAN (chars 3–12) + entity + 'Z' + checksum.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}$/i;

/** Vendor PAN = characters 3–12 of the GSTIN (spec §4). Null if the GSTIN is absent/malformed. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? "").trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return null;
  return g.slice(2, 12);
}

/** Digits of the header SAC (strip spaces / "SAC"/"HSN" prefixes the extractor may leave). */
function normalizeSac(raw: string | null | undefined): string | null {
  const m = (raw ?? "").match(/\d{4,8}/);
  return m ? m[0] : null;
}

function haystack(inv: PurchaseInvoice): string {
  return `${inv.description ?? ""} ${inv.vendorName ?? ""} ${inv.invoiceNumber ?? ""}`.toLowerCase();
}

function ruleMatches(rule: OverrideRule, inv: PurchaseInvoice, sac: string | null): boolean {
  if (!rule.when) return true; // unconditional rule
  const { sacPrefix, keywords } = rule.when;
  if (sacPrefix && sac && sacPrefix.some((p) => sac.startsWith(p))) return true;
  if (keywords && keywords.some((k) => haystack(inv).includes(k))) return true;
  return false;
}

/** §2 SAC → section, longest prefix wins. */
function matchSac(sac: string): { section: PurchaseSection; ambiguous: boolean; note: string } | null {
  const sorted = [...SAC_SECTION_MAP].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const r of sorted) if (sac.startsWith(r.prefix)) return { section: r.section, ambiguous: !!r.ambiguous, note: r.note };
  return null;
}

export function classifyInvoice(inv: PurchaseInvoice): Classification {
  const flags: string[] = [];
  const pan = panFromGstin(inv.vendorGstin);
  const sac = normalizeSac(inv.hsnSac);

  // 0. Data-quality guards (spec §4) — never auto-classify a bad-PAN row.
  if (inv.vendorGstin && !pan) flags.push(`malformed vendor GSTIN "${inv.vendorGstin}" — PAN not derivable`);
  if (pan && pan === OWN_PAN) flags.push(`vendor PAN equals Innovfix's OWN PAN (${OWN_PAN}) — workbook autofill leak, get the real PAN`);

  // 1. Vendor override (spec §1.1, §5).
  const ov = pan ? VENDOR_OVERRIDES.find((v) => v.pan.toUpperCase() === pan) : undefined;
  if (ov) {
    if (ov.flag) flags.push(ov.flag);
    const hits = ov.rules.filter((r) => ruleMatches(r, inv, sac));
    if (ov.rules.length === 1) {
      return { section: ov.rules[0].section, basis: "vendor-override", confidence: 0.95, needsReview: flags.length > 0, flags };
    }
    if (hits.length === 1) {
      return { section: hits[0].section, basis: "vendor-override", confidence: 0.9, needsReview: flags.length > 0, flags: [...flags, `${ov.name}: matched "${hits[0].note}"`] };
    }
    // Multi-service vendor, can't tell which service → review (spec §1 note, §5).
    return { section: null, basis: "vendor-override", confidence: 0.3, needsReview: true, flags: [...flags, `${ov.name} spans sections (${ov.rules.map((r) => r.section).join("/")}) — per-service split needed`] };
  }

  // 2. SAC map (spec §1.2, §2). Service SACs start "99"; a non-99 code is an HSN → goods → no TDS (§7).
  if (sac) {
    if (!sac.startsWith("99")) {
      return { section: "NONE", basis: "sac", confidence: 0.7, needsReview: flags.length > 0, flags: [...flags, `code ${sac} isn't a 99xx SAC → treated as goods (no purchase TDS); verify if it's actually a service`] };
    }
    const m = matchSac(sac);
    if (m) {
      return { section: m.section, basis: "sac", confidence: m.ambiguous ? 0.6 : 0.85, needsReview: m.ambiguous || flags.length > 0, flags: [...flags, ...(m.ambiguous ? [`SAC ${sac}: ${m.note}`] : [])] };
    }
    flags.push(`SAC ${sac} not in the section map`);
  }

  // 3. Keyword fallback (spec §1.3, §3) — always review.
  const hay = haystack(inv);
  for (const rule of KEYWORD_RULES) {
    const word = rule.words.find((w) => hay.includes(w));
    if (word) {
      return { section: rule.section, basis: "keyword", confidence: 0.4, needsReview: true, flags: [...flags, `keyword-classified ("${word}") — confirm section`] };
    }
  }

  // 4. Unknown → review (spec §1.4). Never default-classify.
  return { section: null, basis: "unknown", confidence: 0, needsReview: true, flags: [...flags, "no SAC / vendor / keyword match — classify manually"] };
}
