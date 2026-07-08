"""Duplicate detection — flag re-sent invoices (forward/reply chains, resends).

Read-only here: the detector reports a duplicate if any of the email's identity keys are
already in the dedup store. The pipeline records keys AFTER routing (see routing layer),
so within a run the first occurrence routes and later copies are flagged.
"""

from __future__ import annotations

import hashlib

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import register_detector
from core.signal import Polarity, Signal


def dedup_keys(doc: EmailDocument) -> list[str]:
    """Identity keys used for duplicate detection: message-id, attachment hashes, subject+sender."""
    keys: list[str] = []
    if doc.message_id:
        keys.append(f"mid:{doc.message_id}")
    for att in doc.attachments:
        if att.sha256:
            keys.append(f"att:{att.sha256}")
    norm_subject = " ".join(doc.subject.lower().split())
    if norm_subject:
        digest = hashlib.sha256(f"{doc.sender_domain}|{norm_subject}".encode("utf-8")).hexdigest()
        keys.append(f"subj:{digest}")
    return keys


@register_detector
class DuplicateDetector(Detector):
    detector_id = "duplicate"
    layer = "duplicate"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        if ctx.dedup_store is None:
            return []
        for key in dedup_keys(doc):
            if ctx.dedup_store.contains(key):
                return [
                    Signal(
                        detector_id=self.detector_id,
                        layer=self.layer,
                        strength=0.7,
                        polarity=Polarity.NEGATIVE,
                        reasons=["duplicate"],
                        metadata={"matched_key": key, "duplicate": True},
                    )
                ]
        return []
