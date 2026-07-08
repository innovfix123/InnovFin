"""Document Type Detection (Part 2, Milestone 2.2).

Classifies each collected document into a precise type (digital vs scanned PDF, encrypted PDF,
XML / JSON e-invoice, JPG / PNG / TIFF, ZIP archive, or unsupported) so later milestones can
route it correctly (structured -> parse directly; scanned/image -> OCR).

Design guarantees:
  * consumes ONLY the :class:`~documents.provider.DocumentProvider` — never a path or blob store,
  * plugin architecture (config-driven detectors),
  * every decision is explainable (reasons) and auditable (append-only log).

Does NOT perform OCR, AI, extraction, validation, normalization, storage or search.
"""

from doctype.engine import DocumentTypeEngine
from doctype.models import DetectionSignal, DocumentType, DocumentTypeResult

__all__ = ["DocumentTypeEngine", "DocumentType", "DocumentTypeResult", "DetectionSignal"]
