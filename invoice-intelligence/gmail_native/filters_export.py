"""Export importable Gmail FILTERS as XML.

Gmail Settings -> Filters and Blocked Addresses -> Import filters accepts this Atom/apps
format. The generated file contains two filters per the routing config:

  1. Invoice tier  -> forward to the central mailbox + apply the invoice label.
  2. Review tier   -> apply the review label only (NOT forwarded; a human checks it).

IMPORTANT: Gmail only honors ``forwardTo`` if that address is already added and VERIFIED in
the account's Forwarding settings. The setup guide covers this one-time step.
"""

from __future__ import annotations

import warnings
from xml.sax.saxutils import escape, quoteattr

from core.config import Config, ConfigError
from gmail_native.query_builder import _or_group, build_invoice_query, build_review_query
from gmail_native.query_engine import build_forward_query, generate_queries, union
from gmail_native.versioning import GeneratedQuery
from registry.label_registry import LabelRegistry
from registry.models import CentralMailbox, SourceMailbox

_HEADER = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<feed xmlns="http://www.w3.org/2005/Atom" '
    'xmlns:apps="http://schemas.google.com/apps/2006">\n'
    "  <title>Mail Filters</title>\n"
)
_FOOTER = "</feed>\n"


def _prop(name: str, value: str) -> str:
    return f'    <apps:property name={quoteattr(name)} value={quoteattr(value)}/>\n'


def _entry(title: str, props: list[tuple[str, str]]) -> str:
    out = ["  <entry>\n", '    <category term="filter"/>\n', f"    <title>{escape(title)}</title>\n"]
    out.extend(_prop(name, value) for name, value in props)
    out.append("  </entry>\n")
    return "".join(out)


def build_filters_xml(config: Config) -> str:
    """Return the full importable Gmail filters XML for the configured routing.

    .. deprecated::
        Superseded by the recall-first gateway exporters :func:`build_source_filters_xml`
        and :func:`build_central_filter_xml` (Milestone 2). Retained for backward
        compatibility and removed only in a future cleanup release once the new gateway is
        fully validated against live Gmail. Do NOT build new functionality on this function.
    """
    warnings.warn(
        "build_filters_xml is deprecated; use build_source_filters_xml / "
        "build_central_filter_xml (recall-first gateway exporters).",
        DeprecationWarning,
        stacklevel=2,
    )
    gr = config.gmail_routing()
    forward_to = gr.get("forward_to", "")
    labels = gr.get("labels", {})
    invoice_label = labels.get("invoice", "Invoice/Auto")
    review_label = labels.get("review", "Invoice/Review")

    invoice_q = build_invoice_query(config)
    review_q = build_review_query(config)

    entries = [
        _entry(
            "Invoice -> forward to central",
            [
                ("hasTheWord", invoice_q),
                ("label", invoice_label),
                ("shouldForward", "true"),
                ("forwardTo", forward_to),
                ("shouldNeverSpam", "true"),
                ("sizeOperator", "s_sl"),
                ("sizeUnit", "s_smb"),
            ],
        ),
        _entry(
            "Invoice review -> label only",
            [
                ("hasTheWord", review_q),
                ("label", review_label),
                ("shouldNeverSpam", "true"),
            ],
        ),
    ]
    return _HEADER + "".join(entries) + _FOOTER


# ==========================================================================
# Milestone 2 — gateway filter export (single broad forward + P1–P7 labels + review)
# ==========================================================================
# NOTE: `build_filters_xml` above is the legacy 2-filter exporter (kept for backward
# compatibility). The functions below are the recall-first M2 exporters and are what the
# `gmail-build` command emits. The legacy exporter can be retired once M2 is signed off.

def build_source_filters_xml(
    config: Config,
    source: SourceMailbox,
    central: CentralMailbox,
    labels: LabelRegistry,
    queries: list[GeneratedQuery] | None = None,
) -> str:
    """Importable filters for ONE source mailbox: one broad forward filter (to `central`)
    plus the P1–P7 label-only filters and the review label filter."""
    if queries is None:
        queries, _warn = generate_queries(config)

    entries: list[str] = []
    for gq in queries:
        label = labels.resolve(gq.label_key)
        props: list[tuple[str, str]] = [
            ("hasTheWord", gq.query),
            ("label", label),
            ("shouldNeverSpam", "true"),
        ]
        if gq.forwards:
            props.append(("shouldForward", "true"))
            props.append(("forwardTo", central.email))
        title = f"[{gq.full_version}] {gq.name} ({source.id})"
        entries.append(_entry(title, props))
    return _HEADER + "".join(entries) + _FOOTER


def build_central_filter_xml(
    config: Config,
    central: CentralMailbox,
    labels: LabelRegistry,
) -> str:
    """Importable filter for a CENTRAL mailbox: apply the `Invoices` label to forwarded
    invoice mail, based on the central mailbox's configurable routing rules."""
    rr = central.routing_rules
    if rr.use_invoice_signals:
        # Robust: match invoice signals (forwarded Gmail shows the ORIGINAL sender in `From`,
        # so sender-address matching in the central mailbox is unreliable). shouldNeverSpam
        # (below) then also keeps forwarded invoices out of the central Spam folder.
        criteria = build_forward_query(config)
    else:
        parts = [_or_group("from", rr.match_from), _or_group("subject", rr.match_subject)]
        if rr.plus_address:
            parts.append(f"to:{rr.plus_address}")
        criteria = union([p for p in parts if p])
    if not criteria:
        raise ConfigError(
            f"central mailbox {central.id!r} has no usable routing_rules "
            f"(set match_from / match_subject / plus_address)"
        )

    label = labels.resolve("invoice") if labels.has("invoice") else central.label
    entry = _entry(
        f"Central label -> {central.id}",
        [("hasTheWord", criteria), ("label", label), ("shouldNeverSpam", "true")],
    )
    return _HEADER + entry + _FOOTER
