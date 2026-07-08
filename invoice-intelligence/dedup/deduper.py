"""InvoiceDeduper (Part 2, Milestone 2.6) — semantic invoice dedup, no AI.

The attachment layer already de-dupes identical *bytes* (content hash). This layer catches the
*same invoice arriving as different files* — a PDF and its e-invoice JSON, a re-send, a forward —
by building a stable semantic key from the extracted fields:

  1. **IRN** if present (the GSTN-issued Invoice Reference Number is globally unique), else
  2. ``vendor_gstin | invoice_number`` (the natural business key), else
  3. no key -> treated as unique (we never collapse invoices we can't identify).

First invoice seen for a key becomes the *canonical* record; later ones are flagged duplicates
pointing back to it. The ledger persists as JSON, mirroring the AttachmentRegistry.
"""

from __future__ import annotations

import json
from pathlib import Path

from dedup.models import DedupResult
from fields.models import InvoiceFields


def _norm(value) -> str:
    return str(value).strip().upper()


def dedup_key(fields: InvoiceFields) -> str | None:
    """Derive the semantic key for an invoice, or None if it can't be identified."""
    irn = fields.value("irn")
    if irn not in (None, ""):
        return f"irn:{_norm(irn)}"
    gstin = fields.value("vendor_gstin")
    number = fields.value("invoice_number")
    if gstin not in (None, "") and number not in (None, ""):
        return f"inv:{_norm(gstin)}|{_norm(number)}"
    return None


class InvoiceDeduper:
    def __init__(self, index_path: str | Path | None = None) -> None:
        self.index_path = Path(index_path) if index_path else None
        self._by_key: dict[str, str] = {}       # key -> canonical doc_id
        self._load()

    # -- queries ------------------------------------------------------------
    def canonical_for(self, key: str) -> str | None:
        return self._by_key.get(key)

    # -- core ---------------------------------------------------------------
    def check(self, doc_id: str, fields: InvoiceFields) -> DedupResult:
        """Non-mutating: report whether this invoice duplicates a known one."""
        key = dedup_key(fields)
        if key is None:
            return DedupResult(False, None, doc_id, "no dedup key (missing IRN and GSTIN/number)")
        existing = self._by_key.get(key)
        if existing is not None and existing != doc_id:
            return DedupResult(True, key, existing, f"duplicate of {existing} (key {key})")
        return DedupResult(False, key, existing or doc_id, f"new invoice (key {key})")

    def register(self, doc_id: str, fields: InvoiceFields) -> DedupResult:
        """Check, then record this invoice as the canonical one for its key if new."""
        result = self.check(doc_id, fields)
        if result.key is not None and not result.is_duplicate:
            self._by_key.setdefault(result.key, doc_id)
        return result

    # -- persistence --------------------------------------------------------
    def _load(self) -> None:
        if not (self.index_path and self.index_path.exists()):
            return
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        if isinstance(data, dict):
            self._by_key = {str(k): str(v) for k, v in data.items()}

    def save(self) -> None:
        if not self.index_path:
            return
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(
            json.dumps(self._by_key, indent=2, sort_keys=True), encoding="utf-8"
        )
