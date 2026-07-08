"""Metrics foundation for future reporting.

FOUNDATION ONLY: this package defines the *structure* of the metrics the gateway will report
(detected / forwarded / review counts, and recall / precision / false-negative evaluation).
There is no collection pipeline yet — later milestones will populate these from live runs.

The evaluation structure is deliberately usable now so the recall / false-negative analysis
in Milestone 2 reports through the same shapes future reporting will use.
"""

from metrics.models import EvaluationMetrics, GatewayCounts

__all__ = ["EvaluationMetrics", "GatewayCounts"]
