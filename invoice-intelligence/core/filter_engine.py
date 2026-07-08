"""FilterEngine — the top-level orchestrator and the public API of Phase 1.

    parse -> run detectors -> score -> decide -> (explainable) Decision

This is the module the routing layer calls: for each email it returns a Decision whose
``route_action`` tells the router whether to COPY the email to the central mailbox, label
it for Review, or leave it in place.
"""

from __future__ import annotations

from core.config import Config, ConfigLoader
from core.decision import Decision, DecisionEngine
from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import DetectorRegistry
from core.scoring import ScoringEngine
from core.store import InMemoryStore, Store


class FilterEngine:
    """Classify emails into Invoice / Review / Not-Invoice with explainable reasons."""

    def __init__(
        self,
        config: Config,
        detectors: list[Detector],
        vendor_store: Store | None = None,
        dedup_store: Store | None = None,
    ) -> None:
        self.config = config
        self.detectors = detectors
        self.vendor_store = vendor_store or InMemoryStore()
        self.dedup_store = dedup_store or InMemoryStore()
        self._scoring = ScoringEngine(config)
        self._decision = DecisionEngine(config)

    @classmethod
    def from_config(
        cls,
        config: Config | None = None,
        config_dir: str = "config",
        vendor_store: Store | None = None,
        dedup_store: Store | None = None,
    ) -> "FilterEngine":
        """Build an engine with all registered, enabled detectors."""
        import detectors as _detectors  # noqa: F401 - triggers detector registration

        cfg = config or ConfigLoader.load(config_dir)
        built = DetectorRegistry.from_config(cfg).build()
        return cls(cfg, built, vendor_store=vendor_store, dedup_store=dedup_store)

    def classify(self, doc: EmailDocument) -> Decision:
        ctx = DetectorContext(
            config=self.config,
            vendor_store=self.vendor_store,
            dedup_store=self.dedup_store,
        )
        signals = []
        for detector in self.detectors:
            signals.extend(detector.detect(doc, ctx))
        score = self._scoring.score(signals)
        return self._decision.decide(score)

    def classify_raw(self, raw: bytes | str) -> Decision:
        """Parse raw RFC822 content and classify it."""
        from parsing.mime_parser import parse_email

        return self.classify(parse_email(raw))

    # -- state updates (used by the pipeline after routing) -----------------
    def record_processed(self, doc: EmailDocument, is_invoice: bool) -> None:
        """Record dedup keys and (for invoices) increment vendor history."""
        from detectors.duplicate import dedup_keys

        for key in dedup_keys(doc):
            self.dedup_store.add(key)
        if is_invoice and doc.sender_domain:
            prior = self.vendor_store.get(doc.sender_domain, 0) or 0
            self.vendor_store.put(doc.sender_domain, prior + 1)
