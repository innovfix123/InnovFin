"""Tests for the recall-first gateway exporters (source + central filter XML).

Covers the production filter generation that `gmail-build` emits, including the
`use_invoice_signals` central-labeling fix (forwarded Gmail shows the ORIGINAL sender, so
the central filter must match invoice signals, not the source address).
"""

import xml.etree.ElementTree as ET

import pytest

from core.config import ConfigError, ConfigLoader
from gmail_native.filters_export import build_central_filter_xml, build_source_filters_xml
from gmail_native.query_engine import build_forward_query, generate_queries
from registry.models import CentralMailbox, CentralRoutingRules

_ATOM = "{http://www.w3.org/2005/Atom}"
_APPS = "{http://schemas.google.com/apps/2006}"


def _cfg():
    return ConfigLoader.load("config")


def _entries(xml):
    return ET.fromstring(xml).findall(f"{_ATOM}entry")


def _props(entry):
    return {p.get("name"): p.get("value") for p in entry.findall(f"{_APPS}property")}


# -- source mailbox filters -------------------------------------------------

def test_source_filters_have_exactly_one_forwarding_filter():
    cfg = _cfg()
    reg, labels = cfg.mailbox_registry(), cfg.label_registry()
    src = reg.active_sources()[0]
    central = reg.forward_target_for(src)

    xml = build_source_filters_xml(cfg, src, central, labels)
    entries = _entries(xml)

    # one entry per generated query (forward + tiers + review)
    queries, _warn = generate_queries(cfg)
    assert len(entries) == len(queries)

    forwarding = [e for e in entries if _props(e).get("shouldForward") == "true"]
    assert len(forwarding) == 1, "there must be EXACTLY one forwarding filter (no duplicates)"

    fp = _props(forwarding[0])
    assert fp["forwardTo"] == central.email
    assert fp["label"] == labels.resolve("invoice_auto")


def test_source_label_only_filters_never_forward():
    cfg = _cfg()
    reg, labels = cfg.mailbox_registry(), cfg.label_registry()
    src = reg.active_sources()[0]
    xml = build_source_filters_xml(cfg, src, reg.forward_target_for(src), labels)

    for e in _entries(xml):
        p = _props(e)
        if p.get("shouldForward") != "true":
            assert "forwardTo" not in p, "label-only filters must not forward"


# -- central mailbox filter (the use_invoice_signals fix) -------------------

def test_central_filter_matches_invoice_signals_when_enabled():
    """The shipped central mailbox uses use_invoice_signals=true, so its filter must match
    the forward query (robust to forwarded 'From' showing the original sender)."""
    cfg = _cfg()
    labels = cfg.label_registry()
    central = cfg.mailbox_registry().active_centrals()[0]
    assert central.routing_rules.use_invoice_signals is True

    p = _props(_entries(build_central_filter_xml(cfg, central, labels))[0])
    assert p["hasTheWord"] == build_forward_query(cfg)
    assert p["label"] == labels.resolve("invoice")
    assert p["shouldNeverSpam"] == "true"
    assert "shouldForward" not in p, "central filter only labels, never forwards"


def test_central_filter_falls_back_to_sender_match_when_disabled():
    cfg = _cfg()
    labels = cfg.label_registry()
    central = CentralMailbox(
        id="c", name="C", email="c@example.com", label="Invoices",
        routing_rules=CentralRoutingRules(
            match_from=["a@x.com", "b@y.com"], use_invoice_signals=False
        ),
    )
    p = _props(_entries(build_central_filter_xml(cfg, central, labels))[0])
    assert "from:(a@x.com OR b@y.com)" in p["hasTheWord"]


def test_central_filter_with_no_usable_rules_raises():
    cfg = _cfg()
    labels = cfg.label_registry()
    central = CentralMailbox(
        id="c", name="C", email="c@example.com",
        routing_rules=CentralRoutingRules(),  # nothing set, signals off
    )
    with pytest.raises(ConfigError):
        build_central_filter_xml(cfg, central, labels)
