"""Document-type detector plugins.

Each detector is a pure function of ``(data, metadata, rules)`` — it never touches storage.
The engine opens each document once via the DocumentProvider and passes the bytes in, so the
detectors stay small, testable and storage-agnostic. Detectors return zero or more
:class:`DetectionSignal`; the engine picks the winner.
"""

from __future__ import annotations

import re
import zlib
from typing import Protocol, runtime_checkable

from attachments.models import AttachmentType
from doctype.models import DetectionSignal, DocumentType
from documents.models import DocumentMetadata

_ENCRYPT_WINDOW = 65536
_STREAM_RE = re.compile(rb"stream\r?\n(.*?)\r?\nendstream", re.DOTALL)
_TEXT_OPS = (b"BT", b" Tj", b" TJ", b"'", b'"')
# Filters/markers that identify an image (XObject) stream — its decoded pixel bytes must NOT be
# scanned for text operators, or a large scanned image trips false "text layer" hits.
_IMAGE_STREAM_MARKERS = (b"/Subtype/Image", b"/Subtype /Image", b"/DCTDecode",
                         b"/JPXDecode", b"/CCITTFaxDecode", b"/JBIG2Decode")
_IMAGE_DICT_WINDOW = 200        # bytes before a 'stream' keyword that hold its object dict


@runtime_checkable
class TypeDetector(Protocol):
    name: str

    def detect(self, data: bytes, meta: DocumentMetadata, rules: dict) -> list[DetectionSignal]:
        ...


def _has_encrypt_marker(data: bytes) -> bool:
    return data.startswith(b"%PDF") and (
        b"/Encrypt" in data[:_ENCRYPT_WINDOW] or b"/Encrypt" in data[-_ENCRYPT_WINDOW:]
    )


def _image_marker_count(data: bytes) -> int:
    return (data.count(b"/Subtype/Image") + data.count(b"/Subtype /Image")
            + data.count(b"/DCTDecode"))


def _pdf_text_len(data: bytes) -> int | None:
    """Authoritative text-layer probe via PyMuPDF: length of extractable text.

    Returns None if PyMuPDF is unavailable or can't parse the bytes, so the caller falls back to
    the pure-Python byte heuristic. This is the reliable signal for real-world PDFs, where binary
    streams (images, ICC profiles) otherwise masquerade as text operators.
    """
    try:
        import fitz
    except Exception:
        return None
    try:
        with fitz.open(stream=data, filetype="pdf") as doc:
            return sum(len(page.get_text().strip()) for page in doc)
    except Exception:
        return None


def _analyze_pdf(data: bytes) -> tuple[int, int]:
    """Return (text_operator_count, image_marker_count) for a PDF (best-effort, pure Python).

    Text operators are counted ONLY inside non-image content streams. Image (XObject) streams are
    skipped entirely so that the decoded pixel bytes of a scanned page can't masquerade as a text
    layer — the failure mode that made real scanned PDFs misclassify as digital.
    """
    text_ops = 0
    for match in _STREAM_RE.finditer(data):
        header = data[max(0, match.start() - _IMAGE_DICT_WINDOW):match.start()]
        if any(marker in header for marker in _IMAGE_STREAM_MARKERS):
            continue                        # image stream — its bytes are not page operators
        chunk = match.group(1)
        try:
            chunk = zlib.decompress(chunk)
        except zlib.error:
            pass  # uncompressed or non-Flate stream — use as-is
        text_ops += sum(chunk.count(op) for op in _TEXT_OPS)
    if b"/Font" in data:
        text_ops += 1                       # a font resource implies a text layer
    image_markers = data.count(b"/Subtype/Image") + data.count(b"/Subtype /Image") + data.count(b"/DCTDecode")
    return text_ops, image_markers


class EmailBodyDetector:
    """The captured email body (no attachment) — routed straight to text field extraction."""

    name = "email_body"

    def detect(self, data, meta, rules):
        if meta.attachment_type is AttachmentType.EMAIL_BODY:
            return [DetectionSignal(
                DocumentType.TEXT_BODY, 1.0,
                "email body captured (email had no usable attachment)", self.name,
            )]
        return []


class EncryptedPdfDetector:
    """Password/permission-protected PDF (carries an /Encrypt dictionary)."""

    name = "encrypted_pdf"

    def detect(self, data, meta, rules):
        if _has_encrypt_marker(data) or (data.startswith(b"%PDF") and meta.is_encrypted):
            return [DetectionSignal(
                DocumentType.ENCRYPTED_PDF, 1.0,
                "PDF carries an /Encrypt dictionary (password/permission protected)", self.name,
            )]
        return []


class PdfLayerDetector:
    """Digital (has text layer) vs scanned (image-only) PDF."""

    name = "pdf_layer"

    def detect(self, data, meta, rules):
        if not data.startswith(b"%PDF") or _has_encrypt_marker(data):
            return []   # non-PDF, or encrypted (can't read text) -> other detectors handle
        min_ops = int(rules.get("min_text_ops", 1))
        # Prefer the authoritative PyMuPDF text probe; fall back to the byte heuristic if it can't
        # parse (e.g. truncated/synthetic input or PyMuPDF missing).
        text_len = _pdf_text_len(data)
        if text_len is not None:
            image_markers = _image_marker_count(data)
            if text_len >= 1:
                return [DetectionSignal(
                    DocumentType.DIGITAL_PDF, 0.9,
                    f"{text_len} chars of extractable text -> has a text layer", self.name,
                )]
            if image_markers > 0:
                return [DetectionSignal(
                    DocumentType.SCANNED_PDF, 0.8,
                    f"no extractable text + {image_markers} image marker(s) -> image-only (scanned)", self.name,
                )]
        else:
            text_ops, image_markers = _analyze_pdf(data)
            if text_ops >= min_ops:
                return [DetectionSignal(
                    DocumentType.DIGITAL_PDF, 0.9,
                    f"{text_ops} text-show operator(s)/font found -> has a text layer", self.name,
                )]
            if image_markers > 0:
                return [DetectionSignal(
                    DocumentType.SCANNED_PDF, 0.8,
                    f"{image_markers} image marker(s) and no text operators -> image-only (scanned)", self.name,
                )]
        default = str(rules.get("pdf_ambiguous_default", "scanned")).lower()
        dtype = DocumentType.DIGITAL_PDF if default == "digital" else DocumentType.SCANNED_PDF
        return [DetectionSignal(
            dtype, 0.5,
            f"no text operators and no image markers detected -> treating as {default} (ambiguous)", self.name,
        )]


class XmlInvoiceDetector:
    name = "xml_invoice"

    def detect(self, data, meta, rules):
        head = data.lstrip()[:64]
        if head.startswith(b"<?xml") or head.startswith(b"<"):
            return [DetectionSignal(
                DocumentType.XML_INVOICE, 0.95,
                "XML document (structured e-invoice candidate)", self.name,
            )]
        return []


class JsonEInvoiceDetector:
    name = "json_einvoice"

    def detect(self, data, meta, rules):
        if data.lstrip()[:1] != b"{":
            return []
        hints = rules.get("einvoice_json_keys", ["Irn", "SellerDtls", "AckNo", "DocDtls"])
        matched = [h for h in hints if h.encode() in data]
        if matched:
            return [DetectionSignal(
                DocumentType.JSON_EINVOICE, 0.98,
                f"JSON with GST e-invoice keys {matched}", self.name,
            )]
        return [DetectionSignal(
            DocumentType.JSON_EINVOICE, 0.7,
            "JSON document (structured candidate; no known e-invoice keys)", self.name,
        )]


class ImageDetector:
    name = "image"

    def detect(self, data, meta, rules):
        head = data[:16]
        if head.startswith(b"\xff\xd8\xff"):
            return [DetectionSignal(DocumentType.IMAGE_JPG, 1.0, "JPEG magic bytes (FF D8 FF)", self.name)]
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            return [DetectionSignal(DocumentType.IMAGE_PNG, 1.0, "PNG magic bytes", self.name)]
        if head[:4] in (b"II*\x00", b"MM\x00*"):
            return [DetectionSignal(DocumentType.IMAGE_TIFF, 1.0, "TIFF magic bytes", self.name)]
        return []


class ArchiveDetector:
    name = "archive"

    def detect(self, data, meta, rules):
        if data[:2] == b"PK":
            return [DetectionSignal(DocumentType.ARCHIVE_ZIP, 1.0, "ZIP magic bytes (PK)", self.name)]
        return []


# The plugin catalog. New detectors are registered here and enabled/ordered via config.
DETECTOR_CATALOG = {
    cls.name: cls
    for cls in (
        EmailBodyDetector, EncryptedPdfDetector, PdfLayerDetector, XmlInvoiceDetector,
        JsonEInvoiceDetector, ImageDetector, ArchiveDetector,
    )
}
