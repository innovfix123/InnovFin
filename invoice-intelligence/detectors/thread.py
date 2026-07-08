"""Thread / conversation analysis.

Forwarded and replied invoices are common and legitimate, so this NEVER penalizes them.
A forward that still carries an attachment is a mild positive (someone forwarding a bill).
"""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal


@register_detector
class ThreadAnalysisDetector(Detector):
    detector_id = "thread_analysis"
    layer = "thread"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if doc.is_forward and doc.has_attachments:
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.2,
                    polarity=Polarity.POSITIVE,
                    doc_type_affinity={"invoice": 0.3},
                    reasons=["attachment_present"],
                    metadata={"forwarded": True},
                )
            ]
        if doc.is_reply or doc.is_forward:
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.1,
                    polarity=Polarity.NEUTRAL,
                    reasons=["reply_to_mismatch"] if doc.is_reply else ["attachment_present"],
                    metadata={"reply": doc.is_reply, "forward": doc.is_forward},
                )
            ]
        return []
