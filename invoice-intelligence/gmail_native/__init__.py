"""Gmail-native routing (Phase 1).

The Python Invoice Filter is the brain; Gmail is the executor. This package translates our
detection configuration into:

  * `query_builder` — the best-possible Gmail SEARCH QUERY (boolean approximation of the
    filter, using only operators Gmail supports: from/subject/filename/has:attachment/words);
  * `filters_export` — an importable Gmail FILTERS XML that forwards invoices to central;
  * `query_sim` — a small evaluator of Gmail-style queries, used ONLY to test/measure how
    well the native rules classify our labeled corpus (it does not touch real Gmail).

No IMAP/SMTP/API/OAuth here — Gmail performs the forwarding itself once filters are imported.
"""

from gmail_native.query_builder import build_invoice_query, build_review_query
from gmail_native.filters_export import build_filters_xml
from gmail_native.query_sim import query_matches

__all__ = [
    "build_invoice_query",
    "build_review_query",
    "build_filters_xml",
    "query_matches",
]
