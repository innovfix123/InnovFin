"""Unit tests for the Detector base class and DetectorContext."""

import pytest

from core.config import ConfigLoader
from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.signal import Signal
from core.store import InMemoryStore


class _Echo(Detector):
    detector_id = "_echo"
    layer = "test"

    def detect(self, doc, ctx):
        return [Signal(detector_id=self.detector_id, layer=self.layer, strength=0.5,
                       reasons=["echo"], metadata={"subject": doc.subject})]


def test_detector_context_holds_config_and_stores():
    config = ConfigLoader.load("config")
    vendor = InMemoryStore()
    dedup = InMemoryStore()
    ctx = DetectorContext(config=config, vendor_store=vendor, dedup_store=dedup)
    assert ctx.config is config
    assert ctx.vendor_store is vendor
    assert ctx.dedup_store is dedup


def test_detector_detect_returns_signals():
    config = ConfigLoader.load("config")
    ctx = DetectorContext(config=config)
    signals = _Echo().detect(EmailDocument(subject="hello"), ctx)
    assert len(signals) == 1
    assert signals[0].metadata["subject"] == "hello"


def test_abstract_detector_cannot_be_instantiated():
    with pytest.raises(TypeError):
        Detector()  # abstract
