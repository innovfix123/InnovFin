"""Subject-line intelligence detectors (deliberately capped weight — see score_weights)."""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal
from detectors._helpers import compiled_entities, find_keywords


@register_detector
class SubjectKeywordDetector(Detector):
    """Strong/medium invoice keywords in the subject, mapped to a document type."""

    detector_id = "subject_keyword"
    layer = "subject"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        subject = doc.subject.lower()
        if not subject:
            return []
        kw = ctx.config.section("invoice_keywords")
        strong = find_keywords(subject, kw.get("strong_subject", []))
        medium = find_keywords(subject, kw.get("medium_subject", []))
        if not strong and not medium:
            return []

        strength = 0.6 if strong else 0.35
        affinity = self._doc_type_affinity(subject, kw)
        return [
            Signal(
                detector_id=self.detector_id,
                layer=self.layer,
                strength=strength,
                polarity=Polarity.POSITIVE,
                doc_type_affinity=affinity,
                reasons=["subject_invoice_keyword"],
                metadata={"matched": (strong or medium)},
            )
        ]

    @staticmethod
    def _doc_type_affinity(subject: str, kw: dict) -> dict[str, float]:
        affinity: dict[str, float] = {}
        for doc_type, phrases in kw.get("doc_type_keywords", {}).items():
            if find_keywords(subject, phrases):
                affinity[doc_type] = 0.7
        return affinity or {"invoice": 0.5}


@register_detector
class SubjectInvoiceNumberDetector(Detector):
    """An invoice-number pattern in the subject (e.g. 'INV-2026-001')."""

    detector_id = "subject_invoice_number"
    layer = "subject"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if not doc.subject:
            return []
        pattern = compiled_entities(ctx.config).get("invoice_number")
        if pattern and pattern.search(doc.subject):
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.5,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.7},
                    reasons=["invoice_number_pattern"],
                )
            ]
        return []
