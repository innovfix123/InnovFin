"""Email-body intelligence: financial keywords, financial entities, invoice phrases.

All body-derived detectors share the ``body`` layer, which maps to the ``content``
corroboration domain — so multiple body hits count as ONE independent confirmation.
"""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal
from detectors._helpers import compiled_entities, entity_affinity, find_keywords

# Which entities produce which human reason code.
_ENTITY_REASON = {
    "gstin": "gstin_found",
    "pan": "pan_found",
    "invoice_number": "invoice_number_pattern",
    "po_number": "po_number_pattern",
    "amount": "amount_found",
    "hsn_sac": "financial_keywords",
    "irn": "structured_einvoice",
}
_ENTITY_STRENGTH = {
    "gstin": 0.8,
    "pan": 0.5,
    "invoice_number": 0.7,
    "po_number": 0.6,
    "amount": 0.4,
    "hsn_sac": 0.4,
    "irn": 0.85,
}


@register_detector
class BodyFinancialKeywordDetector(Detector):
    """Count of financial keywords in subject+body -> scaled positive."""

    detector_id = "body_financial_keyword"
    layer = "body"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        keywords = ctx.config.section("invoice_keywords").get("body_financial", [])
        hits = find_keywords(doc.searchable_text, keywords)
        if not hits:
            return []
        strength = min(0.3 + 0.1 * len(hits), 0.7)
        return [
            Signal(
                detector_id=self.detector_id,
                layer=self.layer,
                strength=strength,
                polarity=Polarity.POSITIVE,
                doc_type_affinity={"invoice": 0.5},
                reasons=["financial_keywords"],
                metadata={"matched": hits[:8]},
            )
        ]


@register_detector
class BodyEntityDetector(Detector):
    """Detect financial entities (GSTIN, PAN, invoice no, PO, amount, HSN, IRN) in text."""

    detector_id = "body_entity"
    layer = "body"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        text = f"{doc.subject}\n{doc.body_text}"
        patterns = compiled_entities(ctx.config)
        signals: list[Signal] = []
        for entity, pattern in patterns.items():
            if pattern.search(text):
                affinity = entity_affinity(ctx.config, entity) or {"invoice": 0.5}
                signals.append(
                    Signal(
                        detector_id=self.detector_id,
                        layer=self.layer,
                        strength=_ENTITY_STRENGTH.get(entity, 0.5),
                        polarity=Polarity.POSITIVE,
                        doc_type_affinity=affinity,
                        reasons=[_ENTITY_REASON.get(entity, "financial_keywords")],
                        metadata={"entity": entity},
                    )
                )
        return signals


@register_detector
class BodyPhraseDetector(Detector):
    """'Please find attached invoice' style cues — strong for the Case-B attachment invoice."""

    detector_id = "body_phrase"
    layer = "body"
    _PHRASES = (
        "please find attached",
        "please find the attached",
        "find attached the invoice",
        "attached is the invoice",
        "attached invoice",
    )

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if find_keywords(doc.body_text, self._PHRASES):
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.4,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.5},
                    reasons=["financial_keywords"],
                )
            ]
        return []
