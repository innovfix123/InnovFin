"""Metric data structures (foundation).

These are plain containers describing WHAT the gateway will measure. Collection wiring
(counting live mail, persisting reports) is a later milestone. The recall / precision maths
are pure helpers on the evaluation container so the Milestone-2 recall/false-negative
analysis can report through the same shapes.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class GatewayCounts:
    """Volume counters for a run (foundation — not yet populated by a live pipeline)."""

    detected: int = 0        # mail the gateway considered a probable invoice
    forwarded: int = 0       # mail the broad forward filter would forward to central
    review: int = 0          # mail labelled for human review (never blocks forwarding)
    not_invoice: int = 0     # mail with no positive invoice signal


@dataclass
class EvaluationMetrics:
    """Confusion-matrix style evaluation, recall-first.

    ``false_negatives`` (a real invoice NOT forwarded) is the critical failure this project
    optimizes against, so the names of those items are captured explicitly.
    """

    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    true_negatives: int = 0
    false_negative_names: list[str] = field(default_factory=list)
    false_positive_names: list[str] = field(default_factory=list)

    @property
    def recall(self) -> float:
        denom = self.true_positives + self.false_negatives
        return self.true_positives / denom if denom else 1.0

    @property
    def precision(self) -> float:
        denom = self.true_positives + self.false_positives
        return self.true_positives / denom if denom else 1.0

    @property
    def zero_silent_misses(self) -> bool:
        """True when no real invoice was missed — the project's headline success criterion."""
        return self.false_negatives == 0
