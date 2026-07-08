"""Sender & vendor intelligence detectors."""

from __future__ import annotations

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal


def _domain_matches(domain: str, candidates) -> bool:
    """True if ``domain`` equals or is a subdomain of any candidate."""
    domain = domain.lower()
    for cand in candidates:
        cand = cand.lower()
        if domain == cand or domain.endswith("." + cand):
            return True
    return False


@register_detector
class TrustedVendorDetector(Detector):
    """Sender domain matches a known invoice-sending vendor (config/trusted_vendors.yaml)."""

    detector_id = "trusted_vendor"
    layer = "vendor"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        domain = doc.sender_domain
        if not domain:
            return []
        for vendor in ctx.config.trusted_vendors():
            if _domain_matches(domain, vendor.get("domains", [])):
                doc_types = vendor.get("doc_types", ["invoice"]) or ["invoice"]
                affinity = {t: 0.7 for t in doc_types}
                return [
                    Signal(
                        detector_id=self.detector_id,
                        layer=self.layer,
                        strength=0.85,
                        polarity=Polarity.POSITIVE,
                        doc_type_affinity=affinity,
                        reasons=["trusted_vendor"],
                        metadata={"vendor": vendor.get("name"), "domain": domain},
                    )
                ]
        return []


@register_detector
class SenderReputationDetector(Detector):
    """Corporate (non free-mail) sender domain — a mild positive trust signal."""

    detector_id = "sender_reputation"
    layer = "sender"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        domain = doc.sender_domain
        if not domain:
            return []
        if _domain_matches(domain, ctx.config.free_mail_domains()):
            return []  # free-mail handled by FreeMailDetector
        # A corporate domain is CONTEXT, not invoice evidence — NEUTRAL so it never turns a
        # marketing email into a false positive. Real invoice evidence comes from the
        # attachment/body/vendor layers.
        return [
            Signal(
                detector_id=self.detector_id,
                layer=self.layer,
                strength=0.2,
                polarity=Polarity.NEUTRAL,
                reasons=["corporate_domain"],
                metadata={"domain": domain},
            )
        ]


@register_detector
class VendorHistoryDetector(Detector):
    """Have we routed invoices from this sender domain before? (read-only history lookup)."""

    detector_id = "vendor_history"
    layer = "vendor"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if ctx.vendor_store is None or not doc.sender_domain:
            return []
        count = ctx.vendor_store.get(doc.sender_domain, 0) or 0
        if count <= 0:
            return []
        strength = min(0.3 + 0.1 * count, 0.7)
        return [
            Signal(
                detector_id=self.detector_id,
                layer=self.layer,
                strength=strength,
                polarity=Polarity.POSITIVE,
                doc_type_affinity={"invoice": 0.6},
                reasons=["vendor_history_match"],
                metadata={"domain": doc.sender_domain, "prior_invoices": count},
            )
        ]


@register_detector
class FreeMailDetector(Detector):
    """Sender uses a free/consumer mail provider — informational (recall-preserving)."""

    detector_id = "free_mail"
    layer = "sender"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if _domain_matches(doc.sender_domain, ctx.config.free_mail_domains()):
            # NEUTRAL so it never penalizes a genuine invoice from a small vendor on gmail;
            # it only appears in the explanation for context.
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.3,
                    polarity=Polarity.NEUTRAL,
                    reasons=["free_mail_sender"],
                    metadata={"domain": doc.sender_domain},
                )
            ]
        return []


@register_detector
class ReplyToMismatchDetector(Detector):
    """Reply-To differs from From — informational only (normal for no-reply invoicing)."""

    detector_id = "reply_to_mismatch"
    layer = "sender"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if doc.reply_to_domain and doc.reply_to_domain != doc.sender_domain:
            return [
                Signal(
                    detector_id=self.detector_id,
                    layer=self.layer,
                    strength=0.2,
                    polarity=Polarity.NEUTRAL,
                    reasons=["reply_to_mismatch"],
                    metadata={"from": doc.sender_domain, "reply_to": doc.reply_to_domain},
                )
            ]
        return []
