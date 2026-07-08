"""Scoring engine — combines detector signals into per-document-type scores.

For each document type ``t``:

    raw(t) = Σ_positive ( strength * weight(detector, layer) * effective_affinity(signal, t) )
    penalty = Σ_negative ( strength * negative_weight )
    net(t)  = raw(t) - penalty
    normalized(t) = clamp( net(t) / score_normalizer, 0, 1 )

``effective_affinity`` credits generic positive evidence (no explicit affinity) to the
configured default type. Corroboration is counted over independent EVIDENCE DOMAINS (not
raw layers) so that two detectors reading the same source do not double-count.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from core.config import Config
from core.signal import Polarity, Signal


@dataclass(frozen=True)
class ScoreResult:
    best_type: str
    raw_score: float                 # raw(best) before penalty
    penalty: float
    normalized_score: float          # clamp((raw-penalty)/normalizer, 0, 1)
    corroboration: int               # independent evidence domains supporting best_type
    scores: dict[str, float]         # raw score per document type
    signals: tuple[Signal, ...] = ()
    has_positive: bool = False
    has_strong_negative: bool = False
    unreadable: bool = False
    positive_domains: frozenset[str] = field(default_factory=frozenset)


class ScoringEngine:
    """Turns a list of signals into a :class:`ScoreResult` using configured weights."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.default_type = config.default_type()
        self.doc_types = config.document_type_ids()
        self.negative_weight = float(config.layer_weights().get("negative", 1.5))
        self.normalizer = config.score_normalizer()
        self.strong_negative = config.strong_negative_strength()

    def _effective_affinity(self, signal: Signal, doc_type: str) -> float:
        if signal.doc_type_affinity:
            return signal.affinity_for(doc_type)
        # Generic positive evidence -> credited to the default (dominant) type.
        return 1.0 if doc_type == self.default_type else 0.0

    def score(self, signals: list[Signal]) -> ScoreResult:
        scores: dict[str, float] = {t: 0.0 for t in self.doc_types}
        # domains that positively support each type (for corroboration)
        domains_by_type: dict[str, set[str]] = {t: set() for t in self.doc_types}
        penalty = 0.0
        has_positive = False
        has_strong_negative = False
        unreadable = False

        for sig in signals:
            if sig.metadata.get("unreadable"):
                unreadable = True

            if sig.polarity is Polarity.NEGATIVE:
                penalty += sig.strength * self.negative_weight
                if sig.strength >= self.strong_negative:
                    has_strong_negative = True
                continue

            if sig.polarity is Polarity.NEUTRAL:
                continue

            # POSITIVE
            weight = self.config.weight_for(sig.detector_id, sig.layer)
            domain = self.config.corroboration_domain(sig.layer)
            for doc_type in self.doc_types:
                affinity = self._effective_affinity(sig, doc_type)
                if affinity > 0.0:
                    contribution = sig.strength * weight * affinity
                    scores[doc_type] += contribution
                    if contribution > 0.0:
                        domains_by_type[doc_type].add(domain)
                        has_positive = True

        best_type = max(scores, key=lambda t: scores[t]) if scores else self.default_type
        raw_best = scores.get(best_type, 0.0)
        net = raw_best - penalty
        normalized = max(0.0, min(net / self.normalizer, 1.0)) if self.normalizer else 0.0
        positive_domains = frozenset(domains_by_type.get(best_type, set()))

        return ScoreResult(
            best_type=best_type,
            raw_score=raw_best,
            penalty=penalty,
            normalized_score=normalized,
            corroboration=len(positive_domains),
            scores=scores,
            signals=tuple(signals),
            has_positive=has_positive and raw_best > 0.0,
            has_strong_negative=has_strong_negative,
            unreadable=unreadable,
            positive_domains=positive_domains,
        )
