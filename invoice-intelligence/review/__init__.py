"""Human review actions over a stored invoice record (approve / reject / correct a field).

The pipeline is deterministic and never guesses: anything it can't fully validate lands in
``needs_review``. This module is the HUMAN side of that queue — a reviewer who has checked an
invoice can:

  * :func:`approve`   — "I verified it, treat it as accepted",
  * :func:`reject`    — "this isn't an invoice", moving it to ``not_invoice``,
  * :func:`set_field` — fill in / correct a field (e.g. a total the extractor missed), which then
    re-runs the deterministic validator so the status updates itself (often ``needs_review`` ->
    ``accepted`` once the last mandatory field is present).

Every action stamps a ``review`` block on the record (what, who, when) so the change is auditable
and never silent. Functions are pure (dict in -> dict out) so they are trivially testable and can
be driven from the CLI or the MCP server alike.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from canonical.builder import _normalize
from fields.models import InvoiceFields
from validation import InvoiceValidator


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fields_from_dict(values: dict[str, Any]) -> InvoiceFields:
    f = InvoiceFields()
    for name, value in (values or {}).items():
        if value not in (None, ""):
            f.set(name, value, 1.0, "stored")
    return f


def approve(rec: dict, *, note: str = "", by: str = "manual") -> dict:
    rec = dict(rec)
    rec["status"] = "accepted"
    rec["review"] = {"action": "approved", "by": by, "note": note, "ts": _now()}
    return rec


def reject(rec: dict, *, note: str = "", by: str = "manual") -> dict:
    rec = dict(rec)
    rec["status"] = "not_invoice"
    rec["review"] = {"action": "rejected", "by": by, "note": note, "ts": _now()}
    return rec


def set_field(rec: dict, field: str, value: Any, *, by: str = "manual",
              validator: InvoiceValidator | None = None) -> dict:
    """Set/correct one field, then re-validate so the status reflects the new data.

    A ``duplicate`` stays a duplicate (identity is unchanged). Otherwise the deterministic
    validator decides ``accepted`` vs ``needs_review`` on the updated fields.
    """
    rec = dict(rec)
    fields = dict(rec.get("fields") or {})
    fields[field] = _normalize(field, value)
    rec["fields"] = fields

    validator = validator or InvoiceValidator()
    result = validator.validate(_fields_from_dict(fields))
    rec["validation"] = {
        "ok": result.ok, "confidence": result.confidence,
        "needs_review": result.needs_review, "errors": list(result.errors),
    }
    if rec.get("status") != "duplicate":
        rec["status"] = "needs_review" if result.needs_review else "accepted"
    rec["review"] = {"action": "edited", "field": field, "value": fields[field],
                     "by": by, "ts": _now()}
    return rec
