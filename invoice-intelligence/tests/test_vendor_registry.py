"""Unit tests for the Vendor Registry foundation (registry.vendor_registry)."""

import pytest

from core.config import ConfigError, ConfigLoader
from registry.vendor_registry import VendorRegistry


def test_shipped_config_loads_and_validates():
    vreg = ConfigLoader.load("config").vendor_registry()
    assert len(vreg.vendors) >= 1
    assert vreg.vendor_by_id("amazon") is not None
    assert "amazon.in" in vreg.all_domains()


def test_defaults_applied():
    reg = VendorRegistry.from_section(
        {
            "defaults": {"active": True, "trust_level": "normal"},
            "vendors": [{"id": "acme", "name": "Acme"}],
        }
    )
    v = reg.vendor_by_id("acme")
    assert v.active is True
    assert v.trust_level == "normal"
    assert v.domains == []


def test_missing_file_yields_empty_registry(tmp_path):
    # vendors.yaml is optional foundation — absence must not break anything.
    reg = VendorRegistry.from_config_dir(tmp_path)
    assert reg.vendors == []


def test_duplicate_vendor_id_raises():
    section = {"vendors": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]}
    with pytest.raises(ConfigError):
        VendorRegistry.from_section(section)


def test_invalid_trust_level_raises():
    section = {"vendors": [{"id": "a", "name": "A", "trust_level": "platinum"}]}
    with pytest.raises(ConfigError):
        VendorRegistry.from_section(section)


def test_entry_without_id_or_name_raises():
    section = {"vendors": [{"domains": ["x.com"]}]}
    with pytest.raises(ConfigError):
        VendorRegistry.from_section(section)
