"""Render a Decision into the human-readable, explainable format.

Every decision explains WHY. Positive reasons render with a check mark, negative reasons
with a cross. Reason codes are mapped to labels via config/reason_catalog.yaml.
"""

from __future__ import annotations

from core.config import Config
from core.decision import Category, Decision
from core.signal import Polarity

# ASCII-safe glyphs so output renders correctly in a Windows terminal demo.
_POS_MARK = "[+]"
_NEG_MARK = "[-]"
_NEU_MARK = "[.]"


def _mark(polarity: Polarity) -> str:
    if polarity is Polarity.POSITIVE:
        return _POS_MARK
    if polarity is Polarity.NEGATIVE:
        return _NEG_MARK
    return _NEU_MARK


def reason_lines(decision: Decision, config: Config) -> list[str]:
    """Return one 'mark label' line per reason, positives first."""
    ordered = sorted(
        decision.reasons,
        key=lambda r: 0 if r.polarity is Polarity.POSITIVE else (1 if r.polarity is Polarity.NEUTRAL else 2),
    )
    return [f"{_mark(r.polarity)} {config.reason_label(r.code)}" for r in ordered]


def render(decision: Decision, config: Config) -> str:
    """Full multi-line explanation block for a single email."""
    lines = [
        f"Decision:   {decision.category.value}",
        f"Confidence: {decision.confidence}%",
    ]
    # Document type is only meaningful when we believe it IS a financial document.
    if decision.category is not Category.NOT_INVOICE:
        lines.append(f"Type:       {config.document_type_label(decision.doc_type)}")
    lines.append(f"Route:      {decision.route_action}")
    lines.append("Reasons:")
    lines.extend(f"  {line}" for line in reason_lines(decision, config))
    return "\n".join(lines)
