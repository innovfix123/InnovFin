"""Field Extraction (Part 2, Milestone 2.4) — deterministic, no AI.

Maps extracted content into canonical invoice fields:
  * structured (XML/JSON e-invoice) -> direct key mapping (GST INV-01 shape), high confidence,
  * text (digital-PDF / OCR) -> configurable regex patterns.

Every field carries value + confidence + source (provenance). No cloud AI.
"""

from fields.extractor import FieldExtractor
from fields.models import CANONICAL_FIELDS, Field, InvoiceFields

__all__ = ["FieldExtractor", "InvoiceFields", "Field", "CANONICAL_FIELDS"]
