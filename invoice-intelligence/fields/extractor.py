"""Deterministic field extraction: structured mapping first, then regex over text."""

from __future__ import annotations

import re
from typing import Any

from extraction.models import ExtractedContent
from fields.models import InvoiceFields

# A single date VALUE matches the many real-world formats we see across invoices:
#   07/07/2026 · 6-6-2026 · 2026-07-06 · 06-Jun-2026 · 6 June 2026 · June 6, 2026
_DATE_VAL = (
    r"\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}"          # 07/07/2026, 6-6-26
    r"|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}"           # 2026-07-06 (ISO)
    r"|\d{1,2}[ -][A-Za-z]{3,9}[ ,-]+\d{2,4}"   # 6 June 2026, 06-Jun-2026
    r"|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}"     # June 6, 2026
)
# An AMOUNT: digits with optional thousands separators and OPTIONAL decimals (real invoices write
# both "11800" and "11,800.00"). The trailing `(?!\s*%)` rejects a percentage RATE (e.g. "9%") so
# a GST rate is never mistaken for a GST amount. The arithmetic validator is the final safety net.
_AMOUNT = r"([\d,]+(?:\.\d{1,2})?)(?!\s*%)"
# Optionally skip a leading rate like " 9%" / " @ 18.00%" that sits between a tax label and its
# actual amount ("CGST 9% 900.00" -> capture 900.00, not 9).
_RATE = r"(?:\D*?\d{1,2}(?:\.\d+)?\s*%)?"

# The standard GSTIN shape: 2 state digits + 10-char PAN + entity char + 'Z' + checksum char.
# A foreign OIDAR supplier (e.g. Anthropic/Stripe billing an Indian buyer) carries a non-standard
# "99…" registration that deliberately does NOT match this shape — see _reconcile_gstins().
_GSTIN = r"\d{2}[A-Z]{5}\d{4}[A-Z]\d[Zz][0-9A-Za-z]"
# The non-resident / OIDAR registration a foreign supplier prints instead of a GSTIN
# (e.g. Anthropic's 9924USA29003OSI): 15 chars, "99" country prefix, and deliberately NOT the
# standard shape above. Only ever read under an explicit seller-side registration label —
# see _rescue_oidar_vendor() — never grabbed label-lessly.
_NONRESIDENT_REG = r"99[A-Za-z0-9]{13}"
_OIDAR_LABELLED = re.compile(
    r"(?:vat\s*registration|gst\s*registration|non[-\s]?resident|oidar)"
    r"[^\n]{0,40}?[:\s]\s*(" + _NONRESIDENT_REG + r")\b",
    re.IGNORECASE,
)
# Currencies recognised as an explicit ISO token; the symbol->code fallback below covers PDFs that
# print only a symbol ("$100.00") with no code.
_CURRENCY_CODE = r"USD|INR|EUR|GBP|SGD|AED|AUD|CAD|JPY|CNY|CHF|HKD"
_CURRENCY_SYMBOLS = {"₹": "INR", "$": "USD", "€": "EUR", "£": "GBP"}

# Default regex patterns (config-overridable). Each maps a field -> pattern with one group.
_DEFAULT_PATTERNS = {
    "vendor_gstin": r"\b(" + _GSTIN + r")\b",
    # Buyer / bill-to GSTIN, anchored to the recipient block so it is never confused with the
    # seller's. This also RESCUES vendor_gstin: when the seller is a foreign OIDAR (non-standard
    # "99…" reg), the only standard-shape GSTIN on the page is our own bill-to one, which the
    # label-less vendor_gstin grab would wrongly take. _reconcile_gstins() undoes that.
    "buyer_gstin": r"(?:bill(?:ed)?\s*to|sold\s*to|ship\s*to|buyer|recipient)\b"
                   r"[\s\S]{0,300}?\b(" + _GSTIN + r")\b",
    "invoice_number": r"(?:invoice|bill|receipt)\s*(?:no|number|#|num)\.?\s*[:\-]?\s*"
                      r"([A-Za-z0-9][A-Za-z0-9\-\/]{2,})",
    # Any of the common date labels (including a bare "date"), then the value — `\s*` spans the
    # newline that separates a label from its value in many PDF text extractions.
    # `date paid` is how a paid RECEIPT (as opposed to an invoice) dates itself — Anthropic/Stripe
    # receipts carry no "invoice date" at all, and without this the line has no period to sit in.
    "invoice_date": r"\b(?:invoice\s*date|inv\.?\s*date|bill\s*date|date\s*of\s*issue|"
                    r"issue\s*date|date\s*paid|dated|date)\b\s*[:\-]?\s*(" + _DATE_VAL + r")",
    "due_date": r"\b(?:due\s*date|date\s*due|payment\s*due)\b\s*[:\-]?\s*(" + _DATE_VAL + r")",
    # `\b` + `(?![A-Za-z])` stop the label matching the "po" INSIDE a word — without them
    # "support@anthropic.com" yields po_number "rt". Requiring a digit in the value stops the
    # postal "P.O. Box 104477" on a US supplier's remittance block yielding po_number "Box".
    "po_number": r"\b(?:p\.?o\.?|purchase\s*order)(?![A-Za-z])\s*(?:no|number|#)?\.?\s*[:\-]?\s*"
                 r"(?=[A-Za-z0-9\-\/]{2,})([A-Za-z0-9\-\/]*\d[A-Za-z0-9\-\/]*)",
    "hsn_sac": r"(?:hsn|sac)\s*(?:code)?\s*[:\-]?\s*(\d{4,8})",
    "cgst": r"cgst" + _RATE + r"\D{0,12}?" + _AMOUNT,
    "sgst": r"sgst" + _RATE + r"\D{0,12}?" + _AMOUNT,
    "igst": r"igst" + _RATE + r"\D{0,12}?" + _AMOUNT,
    "taxable_value": r"(?:taxable\s*(?:value|amount)?|assessable\s*value)\D{0,12}?" + _AMOUNT,
    # Two ways in, ONE capture group. The labelled forms tolerate up to 12 filler non-digits; the
    # bare `total` (all a receipt prints) instead demands a currency symbol immediately before the
    # number, so a stray "Total Qty 5" column header can never be read as the invoice total.
    # `\b` keeps bare `total` from matching inside "Subtotal".
    "total": r"(?:(?:grand\s*total|total\s*amount|total\s*value|total\s*invoice\s*value|"
             r"invoice\s*value|invoice\s*total|amount\s*payable|amount\s*due|balance\s*due|"
             r"net\s*payable|total\s*payable|amount\s*paid)\D{0,12}?"
             r"|\btotal\b\s*[:\-]?\s*[₹$€£]\s*)" + _AMOUNT,
    "currency": r"\b(" + _CURRENCY_CODE + r")\b",
}
_AMOUNT_FIELDS = {"cgst", "sgst", "igst", "taxable_value", "total", "cess"}

# Common tag/key aliases for non-INV-01 structured invoices (UBL / custom XML / ERP exports).
# Searched case-insensitively anywhere in the tree; first match wins.
_STRUCT_ALIASES = {
    "invoice_number": ["invoicenumber", "invoiceno", "invno", "billno", "docno", "number"],
    "invoice_date": ["invoicedate", "invdate", "billdate", "docdate", "issuedate"],
    "due_date": ["duedate", "paymentduedate"],
    "vendor_gstin": ["sellergstin", "suppliergstin", "vendorgstin", "gstin"],
    "buyer_gstin": ["buyergstin", "recipientgstin", "customergstin"],
    "vendor_name": ["sellername", "suppliername", "vendorname", "companyname"],
    "buyer_name": ["buyername", "recipientname", "customername"],
    "taxable_value": ["taxablevalue", "taxableamount", "assval", "assessablevalue"],
    "cgst": ["cgst", "cgstamount", "cgstval"],
    "sgst": ["sgst", "sgstamount", "sgstval"],
    "igst": ["igst", "igstamount", "igstval"],
    "total": ["totalamount", "grandtotal", "invoicevalue", "totalinvoicevalue", "totinvval", "nettotal"],
    "hsn_sac": ["hsn", "hsncode", "hsncd", "sac", "saccode"],
    "po_number": ["ponumber", "pono", "purchaseorder", "orderno"],
    "currency": ["currency", "currencycode"],
    "irn": ["irn"],
}


def _num(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).replace(",", "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group()) if m else None


def _section(obj: Any, name: str):
    name = name.lower()
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() == name and isinstance(v, dict):
                return v
        for v in obj.values():
            r = _section(v, name)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for it in obj:
            r = _section(it, name)
            if r is not None:
                return r
    return None


def _scalar(obj: Any, name: str):
    name = name.lower()
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() == name and not isinstance(v, (dict, list)):
                return v
        for v in obj.values():
            r = _scalar(v, name)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for it in obj:
            r = _scalar(it, name)
            if r is not None:
                return r
    return None


class FieldExtractor:
    def __init__(self, patterns: dict[str, str] | None = None) -> None:
        raw = {**_DEFAULT_PATTERNS, **(patterns or {})}
        self.patterns = {k: re.compile(v, re.IGNORECASE) for k, v in raw.items()}

    @classmethod
    def from_config(cls, settings: dict[str, Any]) -> "FieldExtractor":
        return cls((settings or {}).get("patterns"))

    def extract(self, content: ExtractedContent) -> InvoiceFields:
        f = InvoiceFields()
        if content.structured is not None:
            self._from_structured(content.structured, f)
        if content.text:
            self._from_text(content.text, f)
        return f

    # -- structured (GST INV-01 JSON / nested XML) --------------------------
    def _from_structured(self, s: Any, f: InvoiceFields) -> None:
        f.set("irn", _scalar(s, "Irn"), 0.99, "structured:Irn")
        doc = _section(s, "DocDtls") or {}
        f.set("invoice_number", _scalar(doc, "No"), 0.97, "structured:DocDtls.No")
        f.set("invoice_date", _scalar(doc, "Dt"), 0.97, "structured:DocDtls.Dt")
        seller = _section(s, "SellerDtls") or {}
        f.set("vendor_gstin", _scalar(seller, "Gstin"), 0.98, "structured:SellerDtls.Gstin")
        f.set("vendor_name", _scalar(seller, "LglNm") or _scalar(seller, "TrdNm"), 0.9, "structured:SellerDtls")
        buyer = _section(s, "BuyerDtls") or {}
        f.set("buyer_gstin", _scalar(buyer, "Gstin"), 0.95, "structured:BuyerDtls.Gstin")
        f.set("buyer_name", _scalar(buyer, "LglNm") or _scalar(buyer, "TrdNm"), 0.9, "structured:BuyerDtls")
        val = _section(s, "ValDtls") or {}
        f.set("taxable_value", _num(_scalar(val, "AssVal")), 0.9, "structured:ValDtls.AssVal")
        f.set("cgst", _num(_scalar(val, "CgstVal")), 0.9, "structured:ValDtls.CgstVal")
        f.set("sgst", _num(_scalar(val, "SgstVal")), 0.9, "structured:ValDtls.SgstVal")
        f.set("igst", _num(_scalar(val, "IgstVal")), 0.9, "structured:ValDtls.IgstVal")
        f.set("cess", _num(_scalar(val, "CesVal")), 0.9, "structured:ValDtls.CesVal")
        f.set("total", _num(_scalar(val, "TotInvVal")), 0.95, "structured:ValDtls.TotInvVal")
        f.set("hsn_sac", _scalar(s, "HsnCd"), 0.85, "structured:ItemList.HsnCd")
        # Generic fallback: many XML/JSON e-invoices are NOT GST INV-01 shape (UBL, custom, ERP
        # exports). Deep-search common tag/key aliases for any field not already mapped above.
        self._from_aliases(s, f)

    def _from_aliases(self, s, f: InvoiceFields) -> None:
        for canonical, aliases in _STRUCT_ALIASES.items():
            if f.get(canonical) is not None:      # keep the higher-confidence INV-01 value
                continue
            for alias in aliases:
                value = _scalar(s, alias)
                if value is not None:
                    if canonical in _AMOUNT_FIELDS:
                        value = _num(value)
                    f.set(canonical, value, 0.75, f"structured:{alias}")
                    break

    # -- text (digital PDF / OCR) -------------------------------------------
    def _from_text(self, text: str, f: InvoiceFields) -> None:
        for name, pattern in self.patterns.items():
            m = pattern.search(text)
            if not m:
                continue
            value = m.group(1).strip()
            if name in _AMOUNT_FIELDS:
                value = _num(value)
            f.set(name, value, 0.6, f"text:{name}")
        self._reconcile_gstins(f)
        self._rescue_oidar_vendor(text, f)
        self._infer_currency_symbol(text, f)

    def _reconcile_gstins(self, f: InvoiceFields) -> None:
        """Drop a self-referential vendor GSTIN grabbed from text.

        The label-less ``vendor_gstin`` pattern takes the first standard-shape GSTIN in the text.
        On an invoice whose seller is a foreign OIDAR supplier — whose "99…" registration does not
        match the standard shape — the only standard GSTIN present is our OWN bill-to one, so it is
        wrongly captured as the vendor. When the buyer pattern confirms that exact GSTIN is the
        recipient's, we drop it as the vendor rather than record a self-issued invoice: the seller
        GSTIN is then (correctly) blank and the invoice falls to needs_review. Only a text-sourced
        vendor is touched, so a high-confidence structured mapping is never second-guessed.
        """
        vendor = f.get("vendor_gstin")
        buyer = f.get("buyer_gstin")
        if vendor is None or buyer is None:
            return
        if vendor.value == buyer.value and vendor.source.startswith("text:"):
            del f.fields["vendor_gstin"]

    def _rescue_oidar_vendor(self, text: str, f: InvoiceFields) -> None:
        """Record the foreign seller's non-resident registration as the vendor, when labelled.

        After _reconcile_gstins() drops our own bill-to GSTIN, an OIDAR invoice would otherwise
        carry NO vendor at all — and downstream that reads as "supplier unknown" (possibly an
        unregistered domestic vendor) rather than the truth: an import of service. Recording the
        "99…" registration keeps it OUT of the standard-GSTIN path (it still fails validation and
        still routes to review) while naming the real reason — the estimated-2B engine reads a
        "99" prefix as a non-resident/OIDAR supply, i.e. RCM territory, never a 2B B2B credit.

        Only fills a vendor we don't already have, and only from an explicit registration label,
        so a genuine domestic vendor is never displaced.
        """
        if f.get("vendor_gstin") is not None:
            return
        m = _OIDAR_LABELLED.search(text)
        if m:
            f.set("vendor_gstin", m.group(1).upper(), 0.6, "text:vendor_gstin_oidar")

    def _infer_currency_symbol(self, text: str, f: InvoiceFields) -> None:
        """Fallback when no explicit ISO code (USD/INR/…) was found: map a currency SYMBOL attached
        to an amount (e.g. ``$100.00``) to its code, so a foreign-currency PDF is never silently
        stored as null and treated as rupees downstream."""
        if f.value("currency") is not None:
            return
        for sym, code in _CURRENCY_SYMBOLS.items():
            if re.search(re.escape(sym) + r"\s*\d", text):
                f.set("currency", code, 0.5, "text:currency_symbol")
                return
