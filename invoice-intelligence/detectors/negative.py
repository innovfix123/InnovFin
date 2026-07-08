"""Negative classifier — suppresses false positives (meetings, newsletters, OTP, social).

Emits NEGATIVE signals. Per the decision rules, a negative NEVER hard-rejects on its own
when positive evidence is also present; such emails go to Review.
"""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal
from detectors._helpers import find_keywords
from detectors.sender import _domain_matches

# keyword -> reason bucket, to give a specific explanation
_OTP_TERMS = ("otp", "one-time password", "verification code", "password reset",
             "verify your email", "security alert", "sign-in attempt")
_MEETING_TERMS = ("meeting", "meeting invite", "calendar invite", "webinar",
                  "zoom meeting", "microsoft teams", "google meet")


@register_detector
class NegativeClassifierDetector(Detector):
    detector_id = "negative_classifier"
    layer = "negative"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        neg = ctx.config.section("negative_keywords")
        signals: list[Signal] = []

        # 1) Calendar / meeting invite (very strong).
        if doc.header("X-Gateway-Calendar-Method") == "REQUEST":
            signals.append(self._sig(0.9, "calendar_event", {"marker": "text/calendar METHOD:REQUEST"}))

        # 2) Known non-invoice sender domains (LinkedIn, GitHub, social).
        if _domain_matches(doc.sender_domain, neg.get("domains", [])):
            signals.append(self._sig(0.8, "notification_domain", {"domain": doc.sender_domain}))

        # 3) Negative keywords in subject+body.
        matched = find_keywords(doc.searchable_text, neg.get("keywords", []))
        if matched:
            reason = self._reason_for(matched)
            strength = 0.7 if reason in ("meeting_invitation", "otp_security") else 0.6
            signals.append(self._sig(strength, reason, {"matched": matched[:8]}))

        return signals

    def _sig(self, strength: float, reason: str, metadata: dict) -> Signal:
        return Signal(
            detector_id=self.detector_id,
            layer=self.layer,
            strength=strength,
            polarity=Polarity.NEGATIVE,
            reasons=[reason],
            metadata=metadata,
        )

    @staticmethod
    def _reason_for(matched: list[str]) -> str:
        joined = " ".join(matched)
        if any(term in joined for term in _MEETING_TERMS):
            return "meeting_invitation"
        if any(term in joined for term in _OTP_TERMS):
            return "otp_security"
        return "marketing_bulk"
