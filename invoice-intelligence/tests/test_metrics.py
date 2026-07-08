"""Tests for the metrics foundation (metrics.models)."""

from metrics.models import EvaluationMetrics, GatewayCounts


def test_gateway_counts_defaults_zero():
    c = GatewayCounts()
    assert (c.detected, c.forwarded, c.review, c.not_invoice) == (0, 0, 0, 0)


def test_recall_precision_math():
    m = EvaluationMetrics(true_positives=3, false_negatives=0, false_positives=1, true_negatives=4)
    assert m.recall == 1.0
    assert round(m.precision, 2) == 0.75
    assert m.zero_silent_misses is True


def test_recall_reflects_false_negative():
    m = EvaluationMetrics(true_positives=2, false_negatives=2)
    assert m.recall == 0.5
    assert m.zero_silent_misses is False


def test_empty_metrics_are_safe():
    m = EvaluationMetrics()
    assert m.recall == 1.0
    assert m.precision == 1.0
