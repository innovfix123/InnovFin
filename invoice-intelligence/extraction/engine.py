"""ExtractionEngine — route a typed document to the right (deterministic-first) extractor.

Consumes ONLY the DocumentProvider. Structured (XML/JSON) and digital PDFs are extracted with
full confidence and no external service. Scanned PDFs / images go to the OCRProvider (Tesseract);
if OCR is unavailable or low-confidence, the document is flagged ``needs_review``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from doctype.models import DocumentType
from documents.provider import DocumentProvider
from extraction.extractors import (
    extract_digital_pdf,
    extract_json,
    extract_xml,
    render_pdf_pages_png,
)
from extraction.models import ExtractedContent
from extraction.ocr import build_ocr_provider

# DocumentType.value -> extraction method
_DEFAULT_ROUTES = {
    "xml_invoice": "xml",
    "json_einvoice": "json",
    "text_body": "body",
    "digital_pdf": "pymupdf",
    "scanned_pdf": "ocr",
    "image_jpg": "ocr",
    "image_png": "ocr",
    "image_tiff": "ocr",
    "encrypted_pdf": "review",
    "archive_zip": "review",
    "unsupported": "review",
}


class ExtractionEngine:
    def __init__(self, routes, ocr_provider, min_ocr_confidence=0.6, audit_path=None) -> None:
        self.routes = routes
        self.ocr = ocr_provider
        self.min_ocr_confidence = min_ocr_confidence
        self.audit_path = Path(audit_path) if audit_path else None

    @classmethod
    def from_config(cls, settings: dict[str, Any]) -> "ExtractionEngine":
        settings = settings or {}
        routes = {**_DEFAULT_ROUTES, **(settings.get("routes", {}) or {})}
        ocr = build_ocr_provider(settings)
        min_conf = float((settings.get("ocr", {}) or {}).get("min_confidence", 0.6))
        return cls(routes, ocr, min_conf, (settings.get("audit", {}) or {}).get("path"))

    def extract(self, provider: DocumentProvider, ref, document_type: DocumentType) -> ExtractedContent:
        meta = provider.metadata(ref)
        method = self.routes.get(document_type.value, "review")
        result = self._run(provider, ref, meta, document_type, method)
        self._audit(result)
        return result

    # -- routing ------------------------------------------------------------
    def _run(self, provider, ref, meta, dtype, method) -> ExtractedContent:
        try:
            data = provider.open(ref)
            if method == "xml":
                text, structured = extract_xml(data)
                return self._ok(meta, dtype, "xml", text, structured, "parsed XML e-invoice structure")
            if method == "json":
                text, structured = extract_json(data)
                return self._ok(meta, dtype, "json", text, structured, "parsed JSON e-invoice structure")
            if method == "body":
                text = data.decode("utf-8", "ignore")
                if text.strip():
                    return self._ok(meta, dtype, "body", text, None, "read email body text")
                return self._review(meta, dtype, "body", "empty email body")
            if method == "pymupdf":
                text = extract_digital_pdf(data)
                if text.strip():
                    return self._ok(meta, dtype, "pymupdf", text, None,
                                    f"extracted {len(text)} chars via PyMuPDF")
                return self._review(meta, dtype, "pymupdf",
                                    "PyMuPDF found no text (document may be scanned)")
            if method == "ocr":
                return self._ocr(data, meta, dtype)
            return self._review(meta, dtype, "none",
                                f"{dtype.value}: not extractable in this milestone")
        except Exception as exc:  # never crash the pipeline on one bad document
            return self._review(meta, dtype, method, f"extraction error: {exc!r}")

    def _ocr(self, data, meta, dtype) -> ExtractedContent:
        if not self.ocr.available():
            return self._review(
                meta, dtype, self.ocr.name,
                f"OCR provider {self.ocr.name!r} unavailable (Tesseract binary not found) - "
                f"install Tesseract to enable scanned/image extraction",
            )
        images = render_pdf_pages_png(data) if dtype is DocumentType.SCANNED_PDF else [data]
        texts, confs = [], []
        for image in images:
            res = self.ocr.image_to_text(image)
            texts.append(res.text)
            confs.append(res.confidence)
        text = "\n".join(t for t in texts if t)
        conf = sum(confs) / len(confs) if confs else 0.0
        notes = [f"OCR via {self.ocr.name} (avg confidence {conf:.0%})"]
        low = conf < self.min_ocr_confidence or not text.strip()
        if low:
            notes.append(f"confidence below {self.min_ocr_confidence:.0%} - manual review")
        return ExtractedContent(meta.doc_id, meta.filename, dtype, self.ocr.name, text, None,
                                conf, low, tuple(notes))

    # -- result builders ----------------------------------------------------
    def _ok(self, meta, dtype, method, text, structured, note) -> ExtractedContent:
        return ExtractedContent(meta.doc_id, meta.filename, dtype, method, text, structured,
                                1.0, False, (note,))

    def _review(self, meta, dtype, method, note) -> ExtractedContent:
        return ExtractedContent(meta.doc_id, meta.filename, dtype, method, "", None,
                                0.0, True, (f"{note} -> manual review",))

    # -- audit --------------------------------------------------------------
    def _audit(self, r: ExtractedContent) -> None:
        if not self.audit_path:
            return
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "doc_id": r.doc_id,
            "filename": r.filename,
            "document_type": r.document_type.value,
            "method": r.method,
            "chars": len(r.text),
            "confidence": r.confidence,
            "needs_review": r.needs_review,
            "notes": list(r.notes),
        }
        with self.audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
