"""InvoiceValidator (Part 2, Milestone 2.5) — deterministic validation, no AI.

Runs a fixed battery of checks over the canonical :class:`InvoiceFields`:

  * mandatory fields present,
  * GSTIN format + checksum (seller and, when present, buyer),
  * invoice number sanity,
  * invoice/due date parse + ordering,
  * amounts are non-negative numbers,
  * arithmetic reconciliation (taxable + cgst + sgst + igst + cess == total, within tolerance).

It then blends the extraction confidences with the check outcomes into one 0..1 score and flags
the invoice for **Manual Review** if any mandatory check fails or the score is below threshold.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

from fields.models import InvoiceFields
from validation.gstin import is_valid_gstin
from validation.models import FieldValidation, ValidationResult

# Sensible defaults; every one is config-overridable via config/validation.yaml.
_DEFAULT_MANDATORY = ("vendor_gstin", "invoice_number", "invoice_date", "total")
_DEFAULT_MIN_CONFIDENCE = 0.6
_DEFAULT_AMOUNT_TOLERANCE = 1.0     # rupees; rounding slack on the arithmetic check
_AMOUNT_FIELDS = ("taxable_value", "cgst", "sgst", "igst", "cess", "total")

_INVOICE_NO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-\/]{1,}$")
_DATE_FORMATS = (
    "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%d.%m.%Y", "%d.%m.%y",
    "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d",
    "%d-%b-%Y", "%d/%b/%Y", "%d-%b-%y", "%d %b %Y", "%d %b, %Y",
    "%d-%B-%Y", "%d %B %Y", "%d %B, %Y",
    "%B %d, %Y", "%b %d, %Y", "%B %d %Y", "%b %d %Y",   # June 6, 2026 / Jun 6 2026
)


def parse_date(value: Any) -> date | None:
    """Best-effort deterministic date parse over the common Indian-invoice formats."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    if not s:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


class InvoiceValidator:
    def __init__(
        self,
        mandatory: tuple[str, ...] = _DEFAULT_MANDATORY,
        min_confidence: float = _DEFAULT_MIN_CONFIDENCE,
        amount_tolerance: float = _DEFAULT_AMOUNT_TOLERANCE,
        require_buyer_gstin: bool = False,
    ) -> None:
        self.mandatory = tuple(mandatory)
        self.min_confidence = float(min_confidence)
        self.amount_tolerance = float(amount_tolerance)
        self.require_buyer_gstin = bool(require_buyer_gstin)

    @classmethod
    def from_config(cls, settings: dict[str, Any] | None) -> "InvoiceValidator":
        s = settings or {}
        return cls(
            mandatory=tuple(s.get("mandatory_fields", _DEFAULT_MANDATORY)),
            min_confidence=float(s.get("min_confidence", _DEFAULT_MIN_CONFIDENCE)),
            amount_tolerance=float(s.get("amount_tolerance", _DEFAULT_AMOUNT_TOLERANCE)),
            require_buyer_gstin=bool(s.get("require_buyer_gstin", False)),
        )

    # -- public -------------------------------------------------------------
    def validate(self, fields: InvoiceFields) -> ValidationResult:
        checks: list[FieldValidation] = []
        checks.extend(self._check_mandatory(fields))
        checks.extend(self._check_gstins(fields))
        checks.extend(self._check_invoice_number(fields))
        checks.extend(self._check_dates(fields))
        checks.extend(self._check_amounts(fields))
        checks.append(self._check_arithmetic(fields))

        errors = tuple(c.message for c in checks if not c.ok)
        confidence = self._score(fields, checks)
        needs_review = bool(errors) or confidence < self.min_confidence
        return ValidationResult(tuple(checks), errors, round(confidence, 4), needs_review)

    # -- individual checks --------------------------------------------------
    def _check_mandatory(self, f: InvoiceFields) -> list[FieldValidation]:
        out = []
        for name in self.mandatory:
            present = f.value(name) not in (None, "")
            out.append(FieldValidation(
                name, present,
                "" if present else f"mandatory field '{name}' is missing",
            ))
        return out

    def _check_gstins(self, f: InvoiceFields) -> list[FieldValidation]:
        out = []
        vendor = f.value("vendor_gstin")
        if vendor not in (None, ""):
            ok = is_valid_gstin(vendor)
            out.append(FieldValidation(
                "vendor_gstin", ok,
                "" if ok else f"vendor GSTIN '{vendor}' fails format/checksum",
            ))
        buyer = f.value("buyer_gstin")
        if buyer not in (None, ""):
            ok = is_valid_gstin(buyer)
            out.append(FieldValidation(
                "buyer_gstin", ok,
                "" if ok else f"buyer GSTIN '{buyer}' fails format/checksum",
            ))
        elif self.require_buyer_gstin:
            out.append(FieldValidation("buyer_gstin", False, "buyer GSTIN is required but missing"))
        return out

    def _check_invoice_number(self, f: InvoiceFields) -> list[FieldValidation]:
        num = f.value("invoice_number")
        if num in (None, ""):
            return []
        ok = bool(_INVOICE_NO_RE.match(str(num)))
        return [FieldValidation(
            "invoice_number", ok,
            "" if ok else f"invoice number '{num}' has an unexpected format",
        )]

    def _check_dates(self, f: InvoiceFields) -> list[FieldValidation]:
        out = []
        inv = f.value("invoice_date")
        inv_d = parse_date(inv)
        if inv not in (None, ""):
            out.append(FieldValidation(
                "invoice_date", inv_d is not None,
                "" if inv_d else f"invoice date '{inv}' is unparseable",
            ))
        due = f.value("due_date")
        due_d = parse_date(due)
        if due not in (None, ""):
            out.append(FieldValidation(
                "due_date", due_d is not None,
                "" if due_d else f"due date '{due}' is unparseable",
            ))
        if inv_d and due_d and due_d < inv_d:
            out.append(FieldValidation(
                "due_date", False,
                f"due date {due_d} is before invoice date {inv_d}",
            ))
        return out

    def _check_amounts(self, f: InvoiceFields) -> list[FieldValidation]:
        out = []
        for name in _AMOUNT_FIELDS:
            v = f.value(name)
            if v is None:
                continue
            num = _as_number(v)
            if num is None:
                out.append(FieldValidation(name, False, f"amount '{name}' is not a number: {v!r}"))
            elif num < 0:
                out.append(FieldValidation(name, False, f"amount '{name}' is negative: {num}"))
        return out

    def _check_arithmetic(self, f: InvoiceFields) -> FieldValidation:
        total = _as_number(f.value("total"))
        parts = [_as_number(f.value(n)) for n in ("taxable_value", "cgst", "sgst", "igst", "cess")]
        present = [p for p in parts if p is not None]
        if total is None or not present:
            return FieldValidation("total", True, "")  # not enough data to reconcile -> not an error
        summed = sum(present)
        ok = abs(summed - total) <= self.amount_tolerance
        return FieldValidation(
            "total", ok,
            "" if ok else f"components sum to {summed:.2f} but total is {total:.2f}",
        )

    # -- scoring ------------------------------------------------------------
    def _score(self, f: InvoiceFields, checks: list[FieldValidation]) -> float:
        # Base: mean extraction confidence of the fields we actually have.
        confs = [fd.confidence for fd in f.fields.values()]
        base = sum(confs) / len(confs) if confs else 0.0
        # Penalty: every failed check knocks 15% off, hard-floored at 0.
        failed = sum(1 for c in checks if not c.ok)
        return max(0.0, base * (1.0 - 0.15 * failed))


def _as_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


class TrustedSourceValidator:
    """Validator for documents that a human has ALREADY reviewed before we ever saw them.

    The purchase-invoice archive in the finance Drive folder is not an inbox — every document in it
    was checked, approved and filed by the finance team, in many cases already claimed in a filed
    GST return. Routing it into our manual-review queue asks a person to re-do work that is
    finished, for thousands of documents.

    So this wrapper runs the real :class:`InvoiceValidator` unchanged — every check still executes
    and every failure is still recorded in ``checks``/``errors``/``confidence``, so the record stays
    fully auditable and you can always ask "which of these has a missing total?" — and then forces
    ``needs_review`` to False. The document lands as ``accepted``.

    What this does NOT do is invent data: a field OCR could not read stays empty, and the error
    explaining why stays attached to the record. It changes the QUEUE, not the FACTS.
    """

    def __init__(self, inner: InvoiceValidator | None = None,
                 source_label: str = "curated invoice folder") -> None:
        self.inner = inner or InvoiceValidator()
        self.source_label = source_label

    @classmethod
    def from_config(cls, settings: dict[str, Any] | None,
                    source_label: str = "curated invoice folder") -> "TrustedSourceValidator":
        return cls(InvoiceValidator.from_config(settings), source_label)

    def validate(self, fields: InvoiceFields) -> ValidationResult:
        r = self.inner.validate(fields)
        return ValidationResult(r.checks, r.errors, r.confidence, False)
