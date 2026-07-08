"""Decision engine — turns a ScoreResult into a routed, explainable decision.

Decision rules (all thresholds from config/routing_rules.yaml):

    no positive evidence                                   -> NOT_INVOICE
    strong negative AND some positive                      -> REVIEW   (never auto-anything)
    score >= t_high AND corroboration >= min AND routable  -> INVOICE
    score >= t_low  OR  unreadable-but-likely attachment   -> REVIEW
    otherwise (weak positive below t_low)                  -> REVIEW   (recall-first)

The ONLY path to NOT_INVOICE is 'no positive evidence', which keeps hard false negatives
(an invoice silently dropped) near zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from core.config import Config
from core.scoring import ScoreResult
from core.signal import Polarity


class Category(str, Enum):
    INVOICE = "Invoice"
    REVIEW = "Review"
    NOT_INVOICE = "Not Invoice"


@dataclass(frozen=True)
class ReasonItem:
    code: str
    polarity: Polarity


@dataclass(frozen=True)
class Decision:
    category: Category
    doc_type: str
    confidence: int                 # 0..100
    reasons: tuple[ReasonItem, ...]
    route_action: str
    score: ScoreResult

    @property
    def is_invoice(self) -> bool:
        return self.category is Category.INVOICE


class DecisionEngine:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.t_high = config.t_high()
        self.t_low = config.t_low()
        self.min_corroboration = config.min_corroboration()
        self.routable = set(config.routable_types())
        self.actions = config.routing_actions()

    def decide(self, score: ScoreResult) -> Decision:
        category = self._categorize(score)
        confidence = self._confidence(category, score)
        reasons = self._collect_reasons(category, score)
        action = self._action_for(category)
        return Decision(
            category=category,
            doc_type=score.best_type,
            confidence=confidence,
            reasons=reasons,
            route_action=action,
            score=score,
        )

    # -- rules --------------------------------------------------------------
    def _categorize(self, s: ScoreResult) -> Category:
        if not s.has_positive:
            return Category.NOT_INVOICE
        if s.has_strong_negative:
            return Category.REVIEW  # positive + strong negative -> human
        if (
            s.normalized_score >= self.t_high
            and s.corroboration >= self.min_corroboration
            and s.best_type in self.routable
        ):
            return Category.INVOICE
        # some positive evidence but not confident enough -> Review (recall-first),
        # including unreadable-but-likely attachments.
        return Category.REVIEW

    def _confidence(self, category: Category, s: ScoreResult) -> int:
        if category is Category.INVOICE:
            # Map score in [t_high, 1] -> [82, 99], with a small corroboration bonus.
            span = max(1e-6, 1.0 - self.t_high)
            base = 82 + (s.normalized_score - self.t_high) / span * 15
            bonus = min(3, (s.corroboration - self.min_corroboration))
            return int(min(99, round(base + bonus)))
        if category is Category.NOT_INVOICE:
            # Confidence that it's NOT an invoice grows with negative penalty.
            return int(min(99, round(85 + min(14, s.penalty * 6))))
        # REVIEW: express uncertainty around the middle.
        span = max(1e-6, self.t_high - self.t_low)
        pos = (s.normalized_score - self.t_low) / span
        return int(max(40, min(70, round(45 + pos * 20))))

    def _collect_reasons(self, category: Category, s: ScoreResult) -> tuple[ReasonItem, ...]:
        items: list[ReasonItem] = []
        seen: set[tuple[str, Polarity]] = set()
        for sig in s.signals:
            # Neutral signals only surface as context for the NOT case (e.g. no attachment).
            if sig.polarity is Polarity.NEUTRAL and category is not Category.NOT_INVOICE:
                continue
            for code in sig.reasons:
                key = (code, sig.polarity)
                if key not in seen:
                    seen.add(key)
                    items.append(ReasonItem(code=code, polarity=sig.polarity))
        if category is Category.NOT_INVOICE and not any(i.polarity is Polarity.POSITIVE for i in items):
            # Ensure the NOT explanation always states the absence of evidence.
            for code in ("no_financial_evidence",):
                if (code, Polarity.NEGATIVE) not in seen:
                    items.append(ReasonItem(code=code, polarity=Polarity.NEGATIVE))
        return tuple(items)

    def _action_for(self, category: Category) -> str:
        mapping = {
            Category.INVOICE: self.actions.get("invoice", "copy_to_central"),
            Category.REVIEW: self.actions.get("review", "label_review"),
            Category.NOT_INVOICE: self.actions.get("not_invoice", "leave"),
        }
        return mapping[category]
