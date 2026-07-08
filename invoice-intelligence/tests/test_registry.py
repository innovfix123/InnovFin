"""Unit tests for core.registry (detector registration + building)."""

import pytest

from core.detector import Detector, DetectorContext
from core.email_document import EmailDocument
from core.registry import (
    DetectorRegistry,
    UnknownDetectorError,
    register_detector,
    registered_detectors,
)
from core.signal import Signal


@register_detector
class _DummyDetector(Detector):
    detector_id = "_dummy"
    layer = "test"

    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        return [Signal(detector_id=self.detector_id, layer=self.layer, strength=1.0)]


def test_detector_is_registered():
    assert "_dummy" in registered_detectors()


def test_build_instantiates_enabled_registered_detectors():
    registry = DetectorRegistry(
        [{"id": "_dummy", "layer": "test", "enabled": True}], strict=False
    )
    built = registry.build()
    assert len(built) == 1
    assert built[0].detector_id == "_dummy"


def test_build_skips_disabled():
    registry = DetectorRegistry(
        [{"id": "_dummy", "layer": "test", "enabled": False}], strict=False
    )
    assert registry.build() == []


def test_build_skips_unregistered_in_non_strict():
    registry = DetectorRegistry(
        [{"id": "does_not_exist", "layer": "x", "enabled": True}], strict=False
    )
    assert registry.build() == []


def test_build_raises_on_unregistered_in_strict():
    registry = DetectorRegistry(
        [{"id": "does_not_exist", "layer": "x", "enabled": True}], strict=True
    )
    with pytest.raises(UnknownDetectorError):
        registry.build()


def test_duplicate_registration_rejected():
    with pytest.raises(ValueError):
        @register_detector
        class _Dup(Detector):
            detector_id = "_dummy"  # collides with _DummyDetector
            layer = "test"

            def detect(self, doc, ctx):
                return []


def test_detector_requires_id_and_layer():
    class _NoId(Detector):
        detector_id = ""
        layer = "x"

        def detect(self, doc, ctx):
            return []

    with pytest.raises(ValueError):
        _NoId()
