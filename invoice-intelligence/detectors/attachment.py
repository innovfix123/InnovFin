"""Attachment intelligence — the highest-value layer for 'email containing an invoice'.

Signal is carried by filename, MIME type and structural flags. Contents are never read
(Phase 1). Unreadable-but-likely attachments (encrypted / scanned image / archive) emit a
neutral ``unreadable`` marker so the decision engine routes them to Review, not Not.
"""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal
from detectors._helpers import compiled_filename_patterns

# filename fragment -> document-type affinity
_FILENAME_DOC_TYPE = {
    "credit": ("credit_note", "credit note"),
    "debit": ("debit_note", "debit note"),
    "statement": ("statement", "statement"),
    "purchase": ("purchase_order", "purchase order"),
    "receipt": ("invoice", "receipt"),
}


@register_detector
class AttachmentPresenceDetector(Detector):
    """Presence of any attachment (mild positive); absence is informational."""

    detector_id = "attachment_presence"
    layer = "attachment"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if doc.has_attachments:
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.25,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.3},
                    reasons=["attachment_present"],
                    metadata={"count": doc.attachment_count},
                )
            ]
        return [
            Signal(
                detector_id=self.detector_id,
                layer=self.layer,
                strength=0.2,
                polarity=Polarity.NEUTRAL,
                reasons=["no_attachment"],
            )
        ]


@register_detector
class FilenameDetector(Detector):
    """Invoice-like attachment filename (e.g. 'AWS_Invoice_2026.pdf'). Carries Case B."""

    detector_id = "filename"
    layer = "attachment"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        patterns = compiled_filename_patterns(ctx.config)
        signals: list[Signal] = []
        for att in doc.attachments:
            name = att.filename.lower()
            if not name:
                continue
            if any(p.search(name) for p in patterns):
                affinity, reason = self._affinity_and_reason(name, att.is_pdf)
                signals.append(
                    Signal(
                        detector_id=self.detector_id,
                        layer=self.layer,
                        strength=0.8 if att.is_pdf else 0.65,
                        polarity=Polarity.POSITIVE,
                        doc_type_affinity=affinity,
                        reasons=[reason],
                        metadata={"filename": att.filename},
                    )
                )
        return signals

    @staticmethod
    def _affinity_and_reason(name: str, is_pdf: bool):
        for fragment, (doc_type, _) in _FILENAME_DOC_TYPE.items():
            if fragment in name:
                return {doc_type: 0.8}, ("invoice_pdf_attachment" if is_pdf else "invoice_filename")
        return {"invoice": 0.8}, ("invoice_pdf_attachment" if is_pdf else "invoice_filename")


@register_detector
class MimeTypeDetector(Detector):
    """A PDF attachment is a mild document-type-agnostic positive."""

    detector_id = "mime_type"
    layer = "attachment"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if any(att.is_pdf for att in doc.attachments):
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.3,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.3},
                    reasons=["invoice_pdf_attachment"],
                )
            ]
        return []


@register_detector
class StructuredEInvoiceDetector(Detector):
    """A structured e-invoice attachment (.xml / UBL / Factur-X) — very strong evidence."""

    detector_id = "structured_einvoice"
    layer = "attachment"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if any(att.is_structured_xml for att in doc.attachments):
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.9,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.9},
                    reasons=["structured_einvoice"],
                )
            ]
        return []


@register_detector
class AttachmentAnomalyDetector(Detector):
    """Flag unreadable-but-likely attachments so the decision engine routes them to Review."""

    detector_id = "attachment_anomaly"
    layer = "attachment"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        signals: list[Signal] = []
        for att in doc.attachments:
            flag = None
            if att.is_encrypted:
                flag = "encrypted_attachment"
            elif att.is_archive:
                flag = "archive_attachment"
            elif att.is_image:
                flag = "image_attachment"
            if flag:
                signals.append(
                    Signal(
                        detector_id=self.detector_id,
                        layer=self.layer,
                        strength=0.2,
                        polarity=Polarity.NEUTRAL,
                        reasons=[flag],
                        metadata={"unreadable": True, "filename": att.filename},
                    )
                )
        return signals
