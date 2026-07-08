"""Invoice pipeline (Part 2) — end-to-end deterministic orchestration.

``doctype -> extract -> fields -> validate -> dedup -> canonical -> store``. See
:mod:`pipeline.engine`. :func:`build_pipeline` assembles every stage from loaded config dicts.
"""

from __future__ import annotations

from typing import Any

from canonical import CanonicalBuilder
from dedup import InvoiceDeduper
from doctype import DocumentTypeEngine
from extraction import ExtractionEngine
from fields import FieldExtractor
from pipeline.engine import InvoicePipeline, PipelineSummary
from validation import InvoiceRelevance, InvoiceValidator

__all__ = ["InvoicePipeline", "PipelineSummary", "build_pipeline"]


def build_pipeline(cfgs: dict[str, dict[str, Any]], store=None) -> InvoicePipeline:
    """Assemble an :class:`InvoicePipeline` from loaded config dicts.

    Expected keys (all optional; each stage falls back to its own defaults):
    ``doctype_detection``, ``extraction``, ``field_patterns``, ``validation``, ``dedup``.
    """
    cfgs = cfgs or {}
    dedup_cfg = cfgs.get("dedup", {}) or {}
    validation_cfg = cfgs.get("validation", {}) or {}
    return InvoicePipeline(
        typer=DocumentTypeEngine.from_config(cfgs.get("doctype_detection", {}) or {}),
        extractor=ExtractionEngine.from_config(cfgs.get("extraction", {}) or {}),
        field_extractor=FieldExtractor.from_config(cfgs.get("field_patterns", {}) or {}),
        validator=InvoiceValidator.from_config(validation_cfg),
        deduper=InvoiceDeduper((dedup_cfg.get("registry", {}) or {}).get("index_path")),
        builder=CanonicalBuilder(),
        store=store,
        gate=InvoiceRelevance.from_config(validation_cfg),
    )
