"""Authentication and header-hygiene detectors."""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal


@register_detector
class EmailAuthDetector(Detector):
    """SPF/DKIM/DMARC as a trust modifier. Pass = mild positive; fail = mild negative."""

    detector_id = "email_auth"
    layer = "auth"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if doc.auth.all_pass:
            # NEUTRAL: authentication is a trust modifier, NOT invoice evidence. A passing
            # newsletter must not become "positive". Only failures carry weight (below).
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.3,
                    polarity=Polarity.NEUTRAL,
                    reasons=["auth_pass"],
                )
            ]
        if doc.auth.any_fail:
            # Anti-spoof: a failing sender is downgraded (Invoice -> Review) but never dropped.
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.5,
                    polarity=Polarity.NEGATIVE,
                    reasons=["auth_fail"],
                )
            ]
        return []


@register_detector
class HeaderHygieneDetector(Detector):
    """Bulk/marketing markers: List-Unsubscribe and Precedence: bulk are strong negatives."""

    detector_id = "header_hygiene"
    layer = "header"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        cfg = ctx.config.section("negative_keywords").get("headers", {})
        signals: list[Signal] = []

        if cfg.get("list_unsubscribe", True) and doc.header("List-Unsubscribe"):
            signals.append(
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.65,
                    polarity=Polarity.NEGATIVE,
                    reasons=["marketing_bulk"],
                    metadata={"header": "List-Unsubscribe"},
                )
            )

        precedence = doc.header("Precedence").lower()
        if cfg.get("precedence_bulk", True) and precedence in ("bulk", "list", "junk"):
            signals.append(
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.55,
                    polarity=Polarity.NEGATIVE,
                    reasons=["marketing_bulk"],
                    metadata={"header": "Precedence", "value": precedence},
                )
            )
        return signals
