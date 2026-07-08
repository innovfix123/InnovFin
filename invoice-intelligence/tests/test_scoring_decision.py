"""Unit tests for the scoring and decision engines (using synthetic signals)."""

from core.config import ConfigLoader
from core.decision import Category, DecisionEngine
from core.scoring import ScoringEngine
from core.signal import Polarity, Signal


def _cfg():
    return ConfigLoader.load("config")


def _score(signals):
    return ScoringEngine(_cfg()).score(signals)


def test_no_positive_evidence_is_not_invoice():
    result = _score([])
    assert not result.has_positive
    decision = DecisionEngine(_cfg()).decide(result)
    assert decision.category is Category.NOT_INVOICE


def test_strong_positive_two_domains_is_invoice():
    signals = [
        Signal("trusted_vendor", "vendor", 0.85, Polarity.POSITIVE, {"invoice": 0.7}),
        Signal("filename", "attachment", 0.8, Polarity.POSITIVE, {"invoice": 0.8}),
    ]
    result = _score(signals)
    assert result.corroboration >= 2   # identity + attachment
    decision = DecisionEngine(_cfg()).decide(result)
    assert decision.category is Category.INVOICE
    assert decision.confidence >= 80


def test_positive_plus_strong_negative_goes_to_review():
    signals = [
        Signal("filename", "attachment", 0.8, Polarity.POSITIVE, {"invoice": 0.8}),
        Signal("trusted_vendor", "vendor", 0.8, Polarity.POSITIVE, {"invoice": 0.7}),
        Signal("header_hygiene", "header", 0.65, Polarity.NEGATIVE),  # List-Unsubscribe
    ]
    result = _score(signals)
    assert result.has_strong_negative
    decision = DecisionEngine(_cfg()).decide(result)
    assert decision.category is Category.REVIEW


def test_corroboration_domains_prevent_single_source_auto_invoice():
    # Two body-layer signals share the 'content' domain -> only ONE independent domain,
    # so this must NOT auto-route to Invoice despite a high score.
    signals = [
        Signal("body_entity", "body", 0.9, Polarity.POSITIVE, {"invoice": 0.9}),
        Signal("invoice_pattern", "pattern", 0.9, Polarity.POSITIVE, {"invoice": 0.9}),
    ]
    result = _score(signals)
    assert result.corroboration == 1  # body + pattern -> same 'content' domain
    decision = DecisionEngine(_cfg()).decide(result)
    assert decision.category is Category.REVIEW


def test_weak_positive_below_threshold_is_review_not_dropped():
    signals = [Signal("attachment_presence", "attachment", 0.25, Polarity.POSITIVE, {"invoice": 0.3})]
    decision = DecisionEngine(_cfg()).decide(_score(signals))
    assert decision.category is Category.REVIEW  # recall-first: never dropped


def test_unreadable_attachment_routes_to_review():
    signals = [
        Signal("attachment_anomaly", "attachment", 0.2, Polarity.NEUTRAL,
               reasons=["encrypted_attachment"], metadata={"unreadable": True}),
        Signal("trusted_vendor", "vendor", 0.85, Polarity.POSITIVE, {"invoice": 0.7}),
    ]
    result = _score(signals)
    assert result.unreadable
    decision = DecisionEngine(_cfg()).decide(result)
    # trusted vendor alone is one domain -> below corroboration for auto-invoice -> Review
    assert decision.category is Category.REVIEW


def test_specialized_doc_type_selected():
    signals = [
        Signal("trusted_vendor", "vendor", 0.85, Polarity.POSITIVE, {"credit_note": 0.7}),
        Signal("vendor_template", "pattern", 0.6, Polarity.POSITIVE, {"credit_note": 0.75}),
        Signal("filename", "attachment", 0.8, Polarity.POSITIVE, {"credit_note": 0.8}),
    ]
    result = _score(signals)
    assert result.best_type == "credit_note"
