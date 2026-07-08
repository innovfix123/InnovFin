"""Recall-first Gmail query engine (Milestone 2).

Produces:
  * ONE broad FORWARD query — the union of ALL positive signals. It contains NO negative
    terms, so nothing can ever suppress forwarding. This is the single forwarding filter.
  * P1–P7 label-only queries — each isolates one signal family for observability (WHY a
    mail was considered an invoice). They never forward.
  * A REVIEW query — positive signal AND a negative marker → a Review label for a human.
    Negatives influence ONLY this label (and, later, metrics); they never block forwarding.

Every query is wrapped in :class:`GeneratedQuery` and carries a version. A configurable
length guard flags any query that risks Gmail's per-filter truncation limit.

Low-level query primitives are reused from :mod:`gmail_native.query_builder`.
"""

from __future__ import annotations

from core.config import Config, ConfigError
from gmail_native.query_builder import _or_group, _vendor_domains, _word_group
from gmail_native.versioning import GeneratedQuery


def union(parts: list[str]) -> str:
    """OR-combine non-empty expressions into a single grouped expression."""
    parts = [p for p in parts if p]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return "(" + " OR ".join(parts) + ")"


# --------------------------------------------------------------------------
# Per-tier signal builders (config -> query expression). Recall-first: positive only.
# --------------------------------------------------------------------------

def _sig_invoice_keywords(config: Config) -> str:
    ik = config.section("invoice_keywords")
    subj = _or_group("subject", ik.get("strong_subject", []))
    core = _word_group(["tax invoice", "gst invoice", "e-invoice", "invoice"])
    return union([subj, core])


def _sig_vendor_domains(config: Config) -> str:
    return _or_group("from", _vendor_domains(config))


def _sig_filename_tokens(config: Config) -> str:
    return _or_group("filename", config.gmail_routing().get("filename_tokens", []))


def _sig_body_keywords(config: Config) -> str:
    body = list(config.gmail_routing().get("body_tokens", []))
    for term in config.section("invoice_keywords").get("body_financial", []):
        if term not in body:
            body.append(term)
    return _word_group(body)


def _sig_subject_keywords(config: Config) -> str:
    ik = config.section("invoice_keywords")
    terms = list(ik.get("strong_subject", [])) + list(ik.get("medium_subject", []))
    return _or_group("subject", terms)


def _sig_finance_keywords(config: Config) -> str:
    return _word_group(config.section("query_engine").get("finance_keywords", []))


def _sig_catch_all(config: Config) -> str:
    ca = config.section("query_engine").get("catch_all", {}) or {}
    if ca.get("require_attachment_pdf", True):
        return "has:attachment filename:pdf"
    return "has:attachment"


_SIGNALS = {
    "invoice_keywords": _sig_invoice_keywords,
    "vendor_domains": _sig_vendor_domains,
    "filename_tokens": _sig_filename_tokens,
    "body_keywords": _sig_body_keywords,
    "subject_keywords": _sig_subject_keywords,
    "finance_keywords": _sig_finance_keywords,
    "catch_all": _sig_catch_all,
}


# --------------------------------------------------------------------------
# Query composition
# --------------------------------------------------------------------------

def build_tier_queries(config: Config) -> list[tuple[dict, str]]:
    """Return [(tier_config, query_expr)] for each configured P1–P7 tier, in order."""
    out: list[tuple[dict, str]] = []
    for tier in config.section("query_engine").get("tiers", []):
        signal = tier.get("signal")
        builder = _SIGNALS.get(signal)
        if builder is None:
            raise ConfigError(
                f"query_engine tier {tier.get('id')!r}: unknown signal {signal!r} "
                f"(known: {sorted(_SIGNALS)})"
            )
        out.append((tier, builder(config)))
    return out


def build_forward_query(config: Config) -> str:
    """The single broad recall-first forward query: union of ALL positive tier signals."""
    return union([expr for _tier, expr in build_tier_queries(config) if expr])


def build_review_query(config: Config) -> str:
    """A PDF attachment AND a negative marker → Review label. Never blocks forwarding.

    Anchored on ``filename:pdf`` (a lean, invoice-relevant positive) rather than the full
    7-tier union, so the review query stays well under Gmail's per-filter length limit while
    still flagging "looks like it could be an invoice, but smells negative" for a human.
    """
    neg = config.section("negative_keywords")
    neg_union = union([_word_group(neg.get("keywords", [])), _or_group("from", neg.get("domains", []))])
    if not neg_union:
        return ""
    return f"filename:pdf {neg_union}"


# --------------------------------------------------------------------------
# Generation + length guard
# --------------------------------------------------------------------------

def generate_queries(config: Config) -> tuple[list[GeneratedQuery], list[str]]:
    """Return (all generated queries, length-guard warnings). Raises in strict mode."""
    qe = config.section("query_engine")
    version = str(qe.get("version", "v1"))
    guard = qe.get("length_guard", {}) or {}
    max_chars = int(guard.get("max_chars", 1500))
    strict = bool(guard.get("strict", False))

    queries: list[GeneratedQuery] = [
        GeneratedQuery(
            name="Forward (single broad recall-first)",
            tier="FORWARD",
            purpose="Union of ALL positive signals; forwards probable invoices. No negatives.",
            query=build_forward_query(config),
            label_key="invoice_auto",
            forwards=True,
            engine_version=version,
        )
    ]

    for tier, expr in build_tier_queries(config):
        if not expr:
            continue
        queries.append(
            GeneratedQuery(
                name=f"{tier['id']} {tier.get('name', '')}".strip(),
                tier=str(tier["id"]),
                purpose=f"Label-only observability for the {tier.get('name', '')} signal.",
                query=expr,
                label_key=str(tier["label"]),
                forwards=False,
                engine_version=version,
            )
        )

    review = build_review_query(config)
    if review:
        queries.append(
            GeneratedQuery(
                name="Review (negatives -> label only)",
                tier="REVIEW",
                purpose="Positive signal AND a negative marker -> human review. Never blocks forwarding.",
                query=review,
                label_key="review",
                forwards=False,
                engine_version=version,
            )
        )

    return queries, _guard_lengths(queries, max_chars, strict)


def _guard_lengths(queries: list[GeneratedQuery], max_chars: int, strict: bool) -> list[str]:
    warnings: list[str] = []
    for gq in queries:
        if gq.length > max_chars:
            msg = (
                f"query {gq.name!r} ({gq.tier}) is {gq.length} chars > limit {max_chars} — "
                f"Gmail may truncate it (silent-miss risk); split or trim the signal vocabulary"
            )
            if strict:
                raise ConfigError(msg)
            warnings.append(msg)
    return warnings
