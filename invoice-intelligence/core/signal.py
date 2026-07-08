"""The Signal: a single unit of evidence emitted by a detector.

The ``Signal`` is the *only* data contract between detectors and the scoring engine.
Keeping it small and stable is precisely what lets new detectors — including future OCR
and AI modules — contribute to a decision without any change to scoring or routing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Mapping


class Polarity(str, Enum):
    """Direction of the evidence a signal carries."""

    POSITIVE = "positive"   # evidence FOR a financial document
    NEGATIVE = "negative"   # evidence AGAINST (newsletter, meeting, OTP, ...)
    NEUTRAL = "neutral"     # informational only; contributes no score


@dataclass(frozen=True)
class Signal:
    """One piece of evidence about an email.

    Attributes:
        detector_id: id of the detector that produced this signal.
        layer: logical layer (e.g. ``vendor``, ``attachment``, ``negative``) — used both
            for weighting and for the *corroboration* count (distinct layers agreeing).
        strength: confidence of THIS signal in ``[0.0, 1.0]``.
        polarity: whether the evidence is positive, negative or neutral.
        doc_type_affinity: how strongly this signal points to each document type,
            e.g. ``{"invoice": 0.9, "credit_note": 0.3}``. Values in ``[0.0, 1.0]``.
        reasons: machine reason codes (rendered to human labels via the reason catalog).
        metadata: free-form detail for audit/debugging (matched text, filename, etc.).
    """

    detector_id: str
    layer: str
    strength: float
    polarity: Polarity = Polarity.POSITIVE
    doc_type_affinity: Mapping[str, float] = field(default_factory=dict)
    reasons: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.detector_id:
            raise ValueError("Signal.detector_id must be non-empty")
        if not self.layer:
            raise ValueError("Signal.layer must be non-empty")
        if not isinstance(self.strength, (int, float)) or not (0.0 <= self.strength <= 1.0):
            raise ValueError(f"Signal.strength must be a number in [0,1], got {self.strength!r}")
        for type_id, affinity in self.doc_type_affinity.items():
            if not (0.0 <= affinity <= 1.0):
                raise ValueError(
                    f"Signal.doc_type_affinity[{type_id!r}] must be in [0,1], got {affinity}"
                )
        # Freeze mutable inputs so a frozen Signal is genuinely immutable.
        object.__setattr__(self, "reasons", tuple(self.reasons))
        object.__setattr__(self, "doc_type_affinity", MappingProxyType(dict(self.doc_type_affinity)))
        object.__setattr__(self, "metadata", MappingProxyType(dict(self.metadata)))

    @property
    def is_positive(self) -> bool:
        return self.polarity is Polarity.POSITIVE

    @property
    def is_negative(self) -> bool:
        return self.polarity is Polarity.NEGATIVE

    def affinity_for(self, doc_type: str) -> float:
        """Affinity for ``doc_type`` (0.0 if this signal says nothing about it)."""
        return float(self.doc_type_affinity.get(doc_type, 0.0))
