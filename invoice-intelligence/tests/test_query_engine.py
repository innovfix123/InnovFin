"""Tests for the recall-first query engine (gmail_native.query_engine)."""

import pytest

from core.config import ConfigError, ConfigLoader
from gmail_native.query_engine import (
    build_forward_query,
    build_review_query,
    build_tier_queries,
    generate_queries,
)
from gmail_native.query_sim import query_matches
from gmail_native.versioning import GeneratedQuery, revision_of
from parsing.mime_parser import parse_email
from testing.samples import labeled_samples


def _cfg():
    return ConfigLoader.load("config")


def _sample(name):
    return parse_email(next(s["raw"] for s in labeled_samples() if s["name"] == name))


# -- recall-first forwarding ------------------------------------------------

def test_forward_query_forwards_every_invoice():
    q = build_forward_query(_cfg())
    for name in ("amazon_tax_invoice", "aws_case_b_attachment_only", "razorpay_xml_invoice"):
        assert query_matches(q, _sample(name)), f"{name} MUST be forwarded (zero silent miss)"


def test_forward_query_contains_no_negatives():
    """Recall-first: the forward query must never contain a negation / exclusion."""
    q = build_forward_query(_cfg())
    assert "-from:" not in q
    assert "-subject:" not in q
    assert "-(" not in q
    assert "linkedin.com" not in q  # negative domains must not appear in the forward path


def test_forward_query_leaves_obvious_non_invoices():
    q = build_forward_query(_cfg())
    for name in ("meeting_invite", "newsletter", "otp_security", "linkedin_notification"):
        assert not query_matches(q, _sample(name)), f"{name} has no positive signal"


def test_negatives_only_affect_review_label():
    """A negative marker produces a Review query, never a change to forwarding."""
    review = build_review_query(_cfg())
    assert review  # non-empty
    # review requires a negative marker present
    assert "newsletter" in review or "linkedin.com" in review or "unsubscribe" in review


# -- tiers ------------------------------------------------------------------

def test_seven_tiers_present_and_labelled():
    tiers = build_tier_queries(_cfg())
    ids = [t["id"] for t, _q in tiers]
    assert ids == ["P1", "P2", "P3", "P4", "P5", "P6", "P7"]
    for t, expr in tiers:
        assert expr, f"tier {t['id']} produced an empty query"
        assert t["label"]


def test_unknown_signal_raises(tmp_path):
    # Point the engine at a bad tier signal to prove config validation.
    import textwrap

    from tests.test_config import _write_min_config  # reuse the minimal config helper

    cfg = _write_min_config(tmp_path)
    (cfg / "query_engine.yaml").write_text(
        textwrap.dedent(
            """
            version: v1
            tiers:
              - {id: P1, name: Bad, signal: does_not_exist, label: tier_keyword}
            """
        ),
        encoding="utf-8",
    )
    with pytest.raises(ConfigError):
        build_tier_queries(ConfigLoader.load(cfg))


# -- generation, versioning, length guard -----------------------------------

def test_generate_queries_forward_is_first_and_forwards():
    queries, warnings = generate_queries(_cfg())
    assert queries[0].tier == "FORWARD"
    assert queries[0].forwards is True
    assert all(not q.forwards for q in queries[1:])  # only ONE forwarding filter
    assert warnings == []  # shipped config is within the length limit


def test_generated_query_versioning_is_stable_and_content_addressed():
    gq = GeneratedQuery(
        name="x", tier="P1", purpose="p", query="subject:invoice",
        label_key="tier_keyword", forwards=False, engine_version="v1",
    )
    assert gq.full_version == f"v1-{revision_of('subject:invoice')}"
    # a different query text yields a different revision
    other = GeneratedQuery(
        name="x", tier="P1", purpose="p", query="subject:bill",
        label_key="tier_keyword", forwards=False, engine_version="v1",
    )
    assert other.revision != gq.revision


def test_length_guard_warns_and_strict_raises(tmp_path):
    import textwrap

    from tests.test_config import _write_min_config

    cfg = _write_min_config(tmp_path)
    # minimal vendor/keyword vocab so a query is produced
    (cfg / "invoice_keywords.yaml").write_text("strong_subject: [invoice]\n", encoding="utf-8")
    (cfg / "gmail_routing.yaml").write_text("filename_tokens: [invoice]\n", encoding="utf-8")
    base = """
        version: v1
        length_guard: {{max_chars: 1, strict: {strict}}}
        catch_all: {{require_attachment_pdf: true}}
        tiers:
          - {{id: P1, name: K, signal: invoice_keywords, label: tier_keyword}}
    """
    # non-strict → warnings, no raise
    (cfg / "query_engine.yaml").write_text(textwrap.dedent(base.format(strict="false")), encoding="utf-8")
    _q, warns = generate_queries(ConfigLoader.load(cfg))
    assert warns and any("truncate" in w for w in warns)
    # strict → raises
    (cfg / "query_engine.yaml").write_text(textwrap.dedent(base.format(strict="true")), encoding="utf-8")
    with pytest.raises(ConfigError):
        generate_queries(ConfigLoader.load(cfg))
