"""Unit tests for core.signal.Signal."""

import pytest

from core.signal import Polarity, Signal


def test_valid_signal_construction():
    sig = Signal(
        detector_id="filename",
        layer="attachment",
        strength=0.8,
        polarity=Polarity.POSITIVE,
        doc_type_affinity={"invoice": 0.9},
        reasons=["invoice_filename"],
        metadata={"filename": "Invoice.pdf"},
    )
    assert sig.detector_id == "filename"
    assert sig.is_positive
    assert not sig.is_negative
    assert sig.affinity_for("invoice") == 0.9
    assert sig.affinity_for("credit_note") == 0.0
    assert sig.reasons == ("invoice_filename",)


def test_signal_is_immutable():
    sig = Signal(detector_id="x", layer="body", strength=0.5)
    with pytest.raises(Exception):
        sig.strength = 0.9  # frozen dataclass


def test_signal_affinity_and_metadata_are_frozen():
    sig = Signal(detector_id="x", layer="body", strength=0.5, doc_type_affinity={"invoice": 0.4})
    with pytest.raises(TypeError):
        sig.doc_type_affinity["invoice"] = 1.0  # MappingProxyType is read-only


@pytest.mark.parametrize("bad_strength", [-0.1, 1.1, "high"])
def test_invalid_strength_rejected(bad_strength):
    with pytest.raises(ValueError):
        Signal(detector_id="x", layer="body", strength=bad_strength)


def test_invalid_affinity_rejected():
    with pytest.raises(ValueError):
        Signal(detector_id="x", layer="body", strength=0.5, doc_type_affinity={"invoice": 2.0})


def test_empty_detector_id_or_layer_rejected():
    with pytest.raises(ValueError):
        Signal(detector_id="", layer="body", strength=0.5)
    with pytest.raises(ValueError):
        Signal(detector_id="x", layer="", strength=0.5)


def test_negative_polarity():
    sig = Signal(detector_id="negative_classifier", layer="negative", strength=0.9,
                 polarity=Polarity.NEGATIVE, reasons=["meeting_invitation"])
    assert sig.is_negative
    assert not sig.is_positive
