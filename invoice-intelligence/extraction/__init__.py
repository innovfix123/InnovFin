"""Content Extraction (Part 2, Milestone 2.3).

Turns each typed document into text / structured content, routed by DocumentType using the
APPROVED, deterministic-first stack:
  * XML e-invoice   -> direct XML parsing (stdlib)
  * JSON e-invoice  -> direct JSON parsing (stdlib)
  * digital PDF     -> PyMuPDF text extraction
  * scanned PDF / image -> OCRProvider (Tesseract default; cloud providers are optional plugins)

Consumes ONLY the DocumentProvider (bytes by opaque id). No paid AI. Low-confidence / unreadable
documents are flagged ``needs_review``. This milestone does NOT map fields or validate — that is
the next milestone.
"""

from extraction.engine import ExtractionEngine
from extraction.models import ExtractedContent, OcrResult

__all__ = ["ExtractionEngine", "ExtractedContent", "OcrResult"]
