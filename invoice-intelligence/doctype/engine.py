"""DocumentTypeEngine — runs the configured detector plugins over documents.

Consumes ONLY the DocumentProvider (opens bytes + metadata by opaque ref). Picks the highest-
confidence signal (ties broken by detector order = config priority), records every reason for
explainability, and appends an audit line per decision.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core.config import ConfigError
from doctype.detectors import DETECTOR_CATALOG, TypeDetector
from doctype.models import DetectionSignal, DocumentType, DocumentTypeResult
from documents.provider import DocumentProvider


class DocumentTypeEngine:
    def __init__(
        self,
        detectors: list[TypeDetector],
        rules: dict[str, Any] | None = None,
        audit_path: str | Path | None = None,
    ) -> None:
        self.detectors = detectors
        self.rules = rules or {}
        self.audit_path = Path(audit_path) if audit_path else None

    @classmethod
    def from_config(cls, settings: dict[str, Any]) -> "DocumentTypeEngine":
        settings = settings or {}
        detectors: list[TypeDetector] = []
        for entry in settings.get("detectors", []) or []:
            if not entry.get("enabled", True):
                continue
            name = entry.get("name")
            factory = DETECTOR_CATALOG.get(name)
            if factory is None:
                raise ConfigError(
                    f"unknown doctype detector {name!r} (available: {sorted(DETECTOR_CATALOG)})"
                )
            detectors.append(factory())
        if not detectors:
            raise ConfigError("doctype_detection: no detectors enabled")
        return cls(
            detectors,
            rules=settings.get("rules", {}) or {},
            audit_path=(settings.get("audit", {}) or {}).get("path"),
        )

    def detect(self, provider: DocumentProvider, ref) -> DocumentTypeResult:
        data = provider.open(ref)          # bytes via the provider — never a path
        meta = provider.metadata(ref)

        signals: list[DetectionSignal] = []
        for detector in self.detectors:
            signals.extend(detector.detect(data, meta, self.rules))

        result = self._decide(meta.doc_id, meta.filename, signals)
        self._audit(result)
        return result

    def detect_all(self, provider: DocumentProvider) -> list[DocumentTypeResult]:
        return [self.detect(provider, ref) for ref in provider.list_documents()]

    # -- decision -----------------------------------------------------------
    @staticmethod
    def _decide(doc_id: str, filename: str, signals: list[DetectionSignal]) -> DocumentTypeResult:
        if not signals:
            return DocumentTypeResult(
                doc_id=doc_id, filename=filename,
                document_type=DocumentType.UNSUPPORTED, confidence=1.0,
                deciding_detector="", reasons=("no detector recognized this document type",),
                signals=(),
            )
        # highest confidence wins; max() keeps the FIRST on ties -> detector/config order = priority
        winner = max(signals, key=lambda s: s.confidence)
        reasons = tuple(f"[{s.detector}] {s.reason}" for s in signals)
        return DocumentTypeResult(
            doc_id=doc_id, filename=filename,
            document_type=winner.document_type, confidence=winner.confidence,
            deciding_detector=winner.detector, reasons=reasons, signals=tuple(signals),
        )

    # -- audit --------------------------------------------------------------
    def _audit(self, result: DocumentTypeResult) -> None:
        if not self.audit_path:
            return
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "doc_id": result.doc_id,
            "filename": result.filename,
            "document_type": result.document_type.value,
            "confidence": result.confidence,
            "deciding_detector": result.deciding_detector,
            "reasons": list(result.reasons),
        }
        with self.audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
