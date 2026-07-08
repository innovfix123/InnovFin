"""Unit tests for the configuration system (core.config)."""

import textwrap

import pytest

from core.config import Config, ConfigError, ConfigLoader


def test_load_real_project_config():
    """The shipped config/ directory must load and validate."""
    config = ConfigLoader.load("config")
    assert "invoice" in config.document_type_ids()
    assert "commission_report" in config.document_type_ids()
    assert config.t_low() <= config.t_high()
    assert config.min_corroboration() >= 1
    assert len(config.detector_configs()) > 0
    assert len(config.trusted_vendors()) > 0


def test_weight_resolution_prefers_detector_override():
    config = ConfigLoader.load("config")
    # structured_einvoice has a detector override (1.6) distinct from its layer weight.
    assert config.weight_for("structured_einvoice", "attachment") == 1.6
    # a detector with no override falls back to the layer weight.
    assert config.weight_for("attachment_presence", "attachment") == config.layer_weights()["attachment"]
    # unknown layer falls back to 1.0
    assert config.weight_for("whatever", "no_such_layer") == 1.0


def test_reason_label_fallback():
    config = ConfigLoader.load("config")
    assert config.reason_label("trusted_vendor") == "Trusted Vendor"
    assert config.reason_label("some_unknown_code") == "Some Unknown Code"


def _write_min_config(root):
    """Write a minimal valid config tree under ``root`` and return the path."""
    cfg = root / "config"
    cfg.mkdir()
    (cfg / "document_types.yaml").write_text(
        textwrap.dedent(
            """
            types:
              invoice: {label: Invoice}
            routable_to_central: [invoice]
            """
        ),
        encoding="utf-8",
    )
    (cfg / "detectors.yaml").write_text("strict: false\ndetectors: []\n", encoding="utf-8")
    (cfg / "routing_rules.yaml").write_text(
        "thresholds: {t_low: 0.3, t_high: 0.6, min_corroboration: 2}\n", encoding="utf-8"
    )
    (cfg / "score_weights.yaml").write_text(
        "layer_weights: {body: 1.0}\nscore_normalizer: 4.0\n", encoding="utf-8"
    )
    (cfg / "reason_catalog.yaml").write_text("trusted_vendor: Trusted Vendor\n", encoding="utf-8")
    return cfg


def test_minimal_config_loads(tmp_path):
    cfg = _write_min_config(tmp_path)
    config = ConfigLoader.load(cfg)
    assert config.document_type_ids() == ["invoice"]


def test_missing_required_file_raises(tmp_path):
    cfg = _write_min_config(tmp_path)
    (cfg / "routing_rules.yaml").unlink()
    with pytest.raises(ConfigError):
        ConfigLoader.load(cfg)


def test_thresholds_out_of_order_raises(tmp_path):
    cfg = _write_min_config(tmp_path)
    (cfg / "routing_rules.yaml").write_text(
        "thresholds: {t_low: 0.8, t_high: 0.4, min_corroboration: 2}\n", encoding="utf-8"
    )
    with pytest.raises(ConfigError):
        ConfigLoader.load(cfg)


def test_routable_unknown_type_raises(tmp_path):
    cfg = _write_min_config(tmp_path)
    (cfg / "document_types.yaml").write_text(
        "types: {invoice: {label: Invoice}}\nroutable_to_central: [invoice, ghost]\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError):
        ConfigLoader.load(cfg)


def test_missing_config_dir_raises():
    with pytest.raises(ConfigError):
        ConfigLoader.load("no_such_dir_xyz")
