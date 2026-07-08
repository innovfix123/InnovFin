"""Tests for the Label Registry (registry.label_registry)."""

import pytest

from core.config import ConfigError, ConfigLoader
from registry.label_registry import LabelRegistry


def test_shipped_labels_load_and_resolve():
    labels = ConfigLoader.load("config").label_registry()
    assert labels.resolve("invoice") == "Invoices"
    assert labels.resolve("tier_vendor") == "Invoices/Tier/Vendor"
    assert labels.has("review")


def test_unknown_key_raises():
    labels = LabelRegistry.from_section({"labels": {"invoice": "Invoices"}})
    with pytest.raises(ConfigError):
        labels.resolve("nope")


def test_empty_label_value_raises():
    with pytest.raises(ConfigError):
        LabelRegistry.from_section({"labels": {"invoice": ""}})


def test_from_config_dir_matches_section():
    direct = LabelRegistry.from_config_dir("config")
    via_config = ConfigLoader.load("config").label_registry()
    assert direct.labels == via_config.labels
