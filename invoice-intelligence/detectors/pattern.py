"""Pattern intelligence — holistic template checks over the email text.

These share the ``pattern`` layer, which maps to the ``content`` corroboration domain
(same source as the body), so they refine document-type affinity and confidence WITHOUT
inflating the independent-corroboration count.
"""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal
from detectors._helpers import compiled_entities, find_keywords


@register_detector
class InvoicePatternDetector(Detector):
    """Invoice 'shape': an invoice number AND a monetary amount co-occur -> strong."""

    detector_id = "invoice_pattern"
    layer = "pattern"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        text = f"{doc.subject}\n{doc.body_text}"
        entities = compiled_entities(ctx.config)
        has_invoice_no = bool(entities.get("invoice_number") and entities["invoice_number"].search(text))
        has_amount = bool(entities.get("amount") and entities["amount"].search(text))
        if has_invoice_no and has_amount:
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.65,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.7},
                    reasons=["invoice_number_pattern"],
                )
            ]
        return []


@register_detector
class POPatternDetector(Detector):
    """Purchase-order number pattern -> purchase_order affinity."""

    detector_id = "po_pattern"
    layer = "pattern"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        text = f"{doc.subject}\n{doc.body_text}"
        pattern = compiled_entities(ctx.config).get("po_number")
        if pattern and pattern.search(text):
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.55,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"purchase_order": 0.7, "invoice": 0.2},
                    reasons=["po_number_pattern"],
                )
            ]
        return []


@register_detector
class VendorTemplateDetector(Detector):
    """Document-type keyword phrases (credit note, settlement report, ...) set the type."""

    detector_id = "vendor_template"
    layer = "pattern"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        text = doc.searchable_text
        mapping = ctx.config.section("invoice_keywords").get("doc_type_keywords", {})
        signals: list[Signal] = []
        for doc_type, phrases in mapping.items():
            if doc_type == "invoice":
                continue  # invoice handled elsewhere; here we resolve the SPECIALIZED types
            if find_keywords(text, phrases):
                signals.append(
                    Signal(
                        detector_id=self.detector_id,
                        layer=self.layer,
                        strength=0.55,
                        polarity=Polarity.POSITIVE,
                        doc_type_affinity={doc_type: 0.75},
                        reasons=["financial_keywords"],
                        metadata={"doc_type": doc_type},
                    )
                )
        return signals
