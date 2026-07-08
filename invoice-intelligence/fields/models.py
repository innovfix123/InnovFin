"""Canonical invoice fields with per-field provenance."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

# The canonical field set (Indian GST focus). Order is presentation order.
CANONICAL_FIELDS = (
    "vendor_name", "vendor_gstin",
    "buyer_name", "buyer_gstin",
    "invoice_number", "invoice_date", "due_date", "po_number",
    "currency",
    "taxable_value", "cgst", "sgst", "igst", "cess", "total",
    "hsn_sac", "irn",
)


@dataclass(frozen=True)
class Field:
    value: Any
    confidence: float
    source: str        # e.g. "structured:SellerDtls.Gstin" or "text:gstin"


@dataclass
class InvoiceFields:
    fields: dict[str, Field] = field(default_factory=dict)

    def set(self, name: str, value: Any, confidence: float, source: str) -> None:
        """Set a field only if we don't already have a higher-confidence value."""
        if value is None or value == "":
            return
        existing = self.fields.get(name)
        if existing is not None and existing.confidence >= confidence:
            return
        self.fields[name] = Field(value, confidence, source)

    def get(self, name: str) -> Optional[Field]:
        return self.fields.get(name)

    def value(self, name: str, default: Any = None) -> Any:
        f = self.fields.get(name)
        return f.value if f else default

    def to_dict(self) -> dict:
        return {
            name: {"value": f.value, "confidence": f.confidence, "source": f.source}
            for name, f in self.fields.items()
        }
