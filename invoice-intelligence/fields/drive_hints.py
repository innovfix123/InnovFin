"""Trusted-source field hints for documents pulled from the finance Drive archive.

Two canonical fields are effectively unrecoverable from these documents by OCR alone:

  * ``vendor_name`` — extracted today ONLY from structured e-invoices (``SellerDtls``/``_STRUCT_
    ALIASES``). There is no text pattern for it, because "the vendor's name" has no label to anchor
    on in a scanned PDF — it is simply the largest words at the top. Fill rate on the Drive pilot
    was 0/43.
  * ``total`` — present in the text, but frequently unreadable: OCR drops the decimal point across
    a line break (``Paid 116`` / ``73 INR``), and the currency follows the number instead of
    preceding it. Fill rate on the pilot was 20/43.

Both are, however, already written down by a human — in the Drive path itself:

    /2026-27/4. Purchases & Expenses Invoices/1. Purchase Invoices- Apr'26/VendorTwo Invoice_Apr'26/
        VendorTwo - API Services - 01 Apr 2026 - bill-2026-03 - USD 16097.60.pdf
      └ folder = the vendor                                   └ filename = the amount

Finance filed every document under its vendor and named it with the amount. That is the same
trusted-source principle the relevance gate already uses (:class:`TrustedSourceRelevance`): believe
the human filing over a re-derivation from noisy pixels.

**These hints never override extraction.** They are set at confidence 0.7 / 0.5, below the 0.6 of a
text match and the 0.75+ of a structured e-invoice field, and ``InvoiceFields.set`` keeps the
higher-confidence value. So a document whose total OCR'd cleanly keeps its OCR'd total; only the
gaps are filled. Provenance records ``drive:folder`` / ``drive:filename`` so any figure sourced this
way is auditable and can be found later.
"""

from __future__ import annotations

import re

from fields.models import InvoiceFields

# Confidence floors — deliberately below text (0.6) and structured (0.75+) extraction.
_VENDOR_CONF = 0.7    # nothing else populates vendor_name from an unstructured doc
_TOTAL_CONF = 0.5     # must lose to any real extracted total

_MONTH = (r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
          r"aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?")

# A word that carries filing metadata rather than vendor identity: a month (optionally with an
# apostrophe-year, "Apr'26"), a bare number ("2026", "05", "8th"), or an ISO-ish date fragment.
_NOISE_WORD = re.compile(
    r"^(?:" + _MONTH + r")[’'`]?\s*\d{0,4}$"      # apr / april / apr'26
    r"|^\d{1,4}(?:st|nd|rd|th)?$"                       # 2026 / 05 / 8th
    r"|^\d{4}[-/]\d{1,2}(?:[-/]\d{1,4})?$"              # 2026-05-07
    r"|^invoices?$|^bills?$|^receipts?$",               # the literal word, not glued into one
    re.IGNORECASE,
)

_SEPARATOR = re.compile(r"\s*[-_]\s*")

_CURRENCY = r"(?:rs\.?|inr|usd|eur|gbp|aed|sgd|₹|\$|€|£)"
# Decimals arrive two ways: the ordinary "116.62", and "INR10867_72" where the filesystem-hostile
# dot was written as an underscore. Both are bounded by a negative lookahead so a following date
# ("INR40000_20260403") cannot be read as "40000.20".
_NUMBER = r"\d[\d,]*(?:\.\d{1,2}(?!\d)|_\d{2}(?!\d))?"

# A currency token is required — a bare number in a filename is far more often an invoice number,
# an order id or a date than it is money.
#
# The two readings are tried in ORDER, not as one alternation, and this matters. In
# "… - 23-04-2026 USD 100.pdf" a single alternation scanning left to right matches "2026 USD"
# first (number-then-currency), consumes the USD, and never sees "USD 100" — silently yielding
# 2026 as the invoice total. Currency-first is the unambiguous reading, so it wins outright;
# the suffix form is consulted only when there is no prefix form anywhere in the name.
_AMOUNT_PREFIXED = re.compile(_CURRENCY + r"\s*(" + _NUMBER + r")", re.IGNORECASE)
_AMOUNT_SUFFIXED = re.compile(r"(" + _NUMBER + r")\s*" + _CURRENCY, re.IGNORECASE)


def _is_noise_group(group: str) -> bool:
    """True when every word in a separator-delimited group is filing metadata."""
    words = group.split()
    return bool(words) and all(_NOISE_WORD.match(w) for w in words)


def vendor_from_drive_path(drive_path: str) -> str | None:
    """The vendor name a human encoded in the containing folder, or None if it holds no name.

    ``VendorOne Invoice_Apr'26`` -> ``VendorOne``; ``AppTwo - Gateway - April 2026`` ->
    ``AppTwo - Gateway``; ``Invoices-2026-05-07`` -> None (a date-only folder names no vendor).

    Trailing metadata is stripped from the END only, so an internal hyphen in a real name
    (``Courier - Printing``) survives.
    """
    if not drive_path:
        return None
    parts = [p for p in str(drive_path).strip("/").split("/") if p.strip()]
    if len(parts) < 2:
        return None                      # need a containing folder, not just a filename
    segment = parts[-2].strip()

    # Stage 1 — drop trailing separator-delimited groups that are pure metadata.
    groups = [g for g in _SEPARATOR.split(segment) if g.strip()]
    while groups and _is_noise_group(groups[-1]):
        groups.pop()
    if not groups:
        return None

    # Stage 2 — drop trailing metadata WORDS from what remains ("Cloud Host Apr'26").
    words = " - ".join(groups).split()
    while words and _NOISE_WORD.match(words[-1]):
        words.pop()

    name = " ".join(words).strip(" -_")
    return name if len(name) >= 2 else None


def amount_from_filename(filename: str) -> float | None:
    """The invoice amount a human put in the filename, or None.

    ``... - USD 16097.60.pdf`` -> 16097.60; ``..._116.62 INR.pdf`` -> 116.62; ``-INR1500-`` -> 1500.
    The LAST currency-qualified number wins — when a name carries several, the amount is
    conventionally last, after the date and document ids.
    """
    if not filename:
        return None
    matches = list(_AMOUNT_PREFIXED.finditer(str(filename))) or \
        list(_AMOUNT_SUFFIXED.finditer(str(filename)))
    if not matches:
        return None
    raw = matches[-1].group(1).replace(",", "").replace("_", ".")
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


class DriveHintEnricher:
    """Fills ``vendor_name``/``total`` gaps from the Drive path. Applied only on the Drive ingest.

    Wired into :class:`InvoicePipeline` as its optional ``enricher``; the mailbox flow constructs
    no enricher and is therefore completely unaffected.
    """

    def __init__(self, vendor: bool = True, total: bool = True) -> None:
        self.vendor = vendor
        self.total = total

    def enrich(self, fields: InvoiceFields, metadata) -> None:
        drive_path = getattr(metadata, "source_ref", "") or ""
        filename = getattr(metadata, "filename", "") or ""

        if self.vendor:
            name = vendor_from_drive_path(drive_path)
            if name:
                fields.set("vendor_name", name, _VENDOR_CONF, "drive:folder")

        if self.total:
            amount = amount_from_filename(filename)
            if amount is not None:
                fields.set("total", amount, _TOTAL_CONF, "drive:filename")
