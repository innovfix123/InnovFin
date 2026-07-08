"""Build Gmail search queries from our detection configuration.

Queries are emitted in Gmail's *compact grouped* form — e.g. ``from:(a OR b)`` — which is
how Gmail itself writes filters and is far shorter than the distributed form (important:
Gmail truncates over-long filter criteria). Our query simulator normalizes this grouped
form before evaluating, so the exact exported string stays testable.
"""

from __future__ import annotations

from core.config import Config


def _fmt(term: str) -> str:
    """Quote a term if Gmail would otherwise mis-parse it (spaces or '-' operator)."""
    term = term.strip()
    if " " in term or "-" in term:
        return f'"{term}"'
    return term


def _or_group(op: str, terms: list[str]) -> str:
    """Return Gmail's compact ``op:(t1 OR t2 ...)`` for a non-empty term list, else ''."""
    terms = [t for t in terms if t]
    if not terms:
        return ""
    return f"{op}:(" + " OR ".join(_fmt(t) for t in terms) + ")"


def _word_group(terms: list[str]) -> str:
    terms = [t for t in terms if t]
    if not terms:
        return ""
    return "(" + " OR ".join(_fmt(t) for t in terms) + ")"


def _vendor_domains(config: Config) -> list[str]:
    seen: list[str] = []
    for vendor in config.trusted_vendors():
        for domain in vendor.get("domains", []):
            if domain not in seen:
                seen.append(domain)
    return seen


def _strong_invoice_expr(config: Config) -> str:
    """The positive core: any strong invoice signal Gmail can actually see."""
    gr = config.gmail_routing()
    q = gr.get("query", {})
    groups: list[str] = []

    if q.get("use_vendor_from", True):
        vendors = _or_group("from", _vendor_domains(config))
        if vendors:
            # trusted vendor WITH an attachment is the strongest native signal
            groups.append(f"({vendors} has:attachment)")
    if q.get("use_filename_patterns", True):
        fn = _or_group("filename", gr.get("filename_tokens", []))
        if fn:
            groups.append(fn)
    if q.get("use_subject_keywords", True):
        subj = _or_group("subject", config.section("invoice_keywords").get("strong_subject", []))
        if subj:
            groups.append(subj)
    if q.get("use_body_keywords", True):
        body = _word_group(gr.get("body_tokens", []))
        if body:
            groups.append(body)

    return "(" + " OR ".join(groups) + ")" if groups else ""


def _negative_guard(config: Config) -> str:
    gr = config.gmail_routing()
    parts: list[str] = []
    neg_from = _or_group("from", gr.get("negative_from", []))
    if neg_from:
        parts.append("-" + neg_from)
    neg_subject = _or_group("subject", gr.get("negative_subject", []))
    if neg_subject:
        parts.append("-" + neg_subject)
    if gr.get("query", {}).get("exclude_chats", True):
        parts.append("-in:chats")
    return " ".join(parts)


def build_invoice_query(config: Config) -> str:
    """Query for mail that should be FORWARDED to central (the Invoice tier)."""
    strong = _strong_invoice_expr(config)
    guard = _negative_guard(config)
    return f"{strong} {guard}".strip()


def build_review_query(config: Config) -> str:
    """Query for ambiguous mail to LABEL for review (has a PDF but not a strong invoice)."""
    strong = _strong_invoice_expr(config)
    guard = _negative_guard(config)
    exclude_strong = f"-{strong}" if strong else ""
    return f"has:attachment filename:pdf {exclude_strong} {guard}".strip()
