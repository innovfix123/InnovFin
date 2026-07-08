"""Types produced by content extraction."""

from __future__ import annotations

from dataclasses import dataclass

from doctype.models import DocumentType


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float          # 0..1 (Tesseract's mean word confidence, normalized)


@dataclass(frozen=True)
class ExtractedContent:
    doc_id: str
    filename: str
    document_type: DocumentType
    method: str                # xml | json | pymupdf | tesseract | none
    text: str                  # extracted plain text (may be "")
    structured: dict | None    # parsed tree for XML / JSON e-invoices, else None
    confidence: float          # 0..1
    needs_review: bool         # unreadable / low-confidence / unsupported -> manual review
    notes: tuple[str, ...] = ()
