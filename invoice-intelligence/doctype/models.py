"""Types produced by document-type detection."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class DocumentType(str, Enum):
    DIGITAL_PDF = "digital_pdf"       # PDF with a text layer -> direct text extraction
    SCANNED_PDF = "scanned_pdf"       # image-only PDF -> OCR
    ENCRYPTED_PDF = "encrypted_pdf"   # password/permission protected -> cannot read without key
    XML_INVOICE = "xml_invoice"       # structured -> parse directly
    JSON_EINVOICE = "json_einvoice"   # GST INV-01 structured -> parse directly
    IMAGE_JPG = "image_jpg"           # -> OCR
    IMAGE_PNG = "image_png"           # -> OCR
    IMAGE_TIFF = "image_tiff"         # -> OCR
    ARCHIVE_ZIP = "archive_zip"       # -> unpack later
    TEXT_BODY = "text_body"           # the email body itself (no attachment) -> read text directly
    UNSUPPORTED = "unsupported"

    @property
    def is_structured(self) -> bool:
        return self in (DocumentType.XML_INVOICE, DocumentType.JSON_EINVOICE)

    @property
    def needs_ocr(self) -> bool:
        return self in (
            DocumentType.SCANNED_PDF, DocumentType.IMAGE_JPG,
            DocumentType.IMAGE_PNG, DocumentType.IMAGE_TIFF,
        )


@dataclass(frozen=True)
class DetectionSignal:
    """One detector's opinion, with a human-readable reason (explainability)."""

    document_type: DocumentType
    confidence: float
    reason: str
    detector: str


@dataclass(frozen=True)
class DocumentTypeResult:
    """The final typing decision for a document, with all contributing reasons."""

    doc_id: str
    filename: str
    document_type: DocumentType
    confidence: float
    deciding_detector: str
    reasons: tuple[str, ...]
    signals: tuple[DetectionSignal, ...]
