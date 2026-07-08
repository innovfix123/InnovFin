"""Configuration system.

Loads the YAML files under ``config/`` into a single validated :class:`Config` object.
Every tunable in the system — vendors, keywords, patterns, weights, thresholds, document
types, mailbox transport — lives in configuration. Nothing is hardcoded in the engine.

The loader validates the parts the engine relies on (document taxonomy, thresholds,
weights) and fails fast with a clear :class:`ConfigError` if they are missing or invalid.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class ConfigError(Exception):
    """Raised when configuration is missing or internally inconsistent."""


# Config files that MUST be present for the engine to operate.
_REQUIRED_SECTIONS = (
    "document_types",
    "detectors",
    "routing_rules",
    "score_weights",
    "reason_catalog",
)

# Config files loaded if present, but not strictly required by the core engine.
_OPTIONAL_SECTIONS = (
    "trusted_vendors",
    "invoice_keywords",
    "negative_keywords",
    "invoice_patterns",
    "mailboxes",
    "vendors",
    "labels",
    "query_engine",
    "gmail_routing",
)


@dataclass(frozen=True)
class Config:
    """A validated, read-only view over all configuration sections.

    Access raw sections with :meth:`section`, or use the typed convenience accessors.
    Keys are the YAML filename stems (e.g. ``routing_rules`` -> ``config/routing_rules.yaml``).
    """

    raw: dict[str, dict] = field(default_factory=dict)
    config_dir: Path | None = None

    # -- generic access -----------------------------------------------------
    def section(self, name: str) -> dict:
        """Return a configuration section (empty dict if absent)."""
        return self.raw.get(name, {})

    # -- document taxonomy --------------------------------------------------
    def document_types(self) -> dict[str, dict]:
        return self.section("document_types").get("types", {})

    def document_type_ids(self) -> list[str]:
        return list(self.document_types().keys())

    def document_type_label(self, type_id: str) -> str:
        return self.document_types().get(type_id, {}).get("label", type_id)

    def routable_types(self) -> list[str]:
        """Document types that, when confidently detected, are copied to central."""
        return list(self.section("document_types").get("routable_to_central", []))

    # -- thresholds / decision ---------------------------------------------
    def thresholds(self) -> dict[str, Any]:
        return self.section("routing_rules").get("thresholds", {})

    def t_high(self) -> float:
        return float(self.thresholds().get("t_high", 0.62))

    def t_low(self) -> float:
        return float(self.thresholds().get("t_low", 0.30))

    def min_corroboration(self) -> int:
        return int(self.thresholds().get("min_corroboration", 2))

    def strong_negative_strength(self) -> float:
        return float(
            self.section("routing_rules")
            .get("negative_override", {})
            .get("strong_negative_strength", 0.60)
        )

    def routing_actions(self) -> dict[str, str]:
        return self.section("routing_rules").get("routing_actions", {})

    # -- weights ------------------------------------------------------------
    def layer_weights(self) -> dict[str, float]:
        return self.section("score_weights").get("layer_weights", {})

    def detector_weights(self) -> dict[str, float]:
        return self.section("score_weights").get("detector_weights", {})

    def score_normalizer(self) -> float:
        return float(self.section("score_weights").get("score_normalizer", 4.0))

    def default_type(self) -> str:
        return str(self.section("score_weights").get("default_type", "invoice"))

    def corroboration_domain(self, layer: str) -> str:
        """Map a signal layer to its independent evidence domain (defaults to the layer)."""
        return self.section("score_weights").get("corroboration_domains", {}).get(layer, layer)

    def weight_for(self, detector_id: str, layer: str) -> float:
        """Resolve a detector's weight: per-detector override else layer default else 1.0."""
        overrides = self.detector_weights()
        if detector_id in overrides:
            return float(overrides[detector_id])
        return float(self.layer_weights().get(layer, 1.0))

    # -- detectors ----------------------------------------------------------
    def detector_configs(self) -> list[dict]:
        return list(self.section("detectors").get("detectors", []))

    def detectors_strict(self) -> bool:
        return bool(self.section("detectors").get("strict", False))

    # -- vendors ------------------------------------------------------------
    def trusted_vendors(self) -> list[dict]:
        return list(self.section("trusted_vendors").get("vendors", []))

    def free_mail_domains(self) -> list[str]:
        return list(self.section("trusted_vendors").get("free_mail_domains", []))

    # -- reason labels ------------------------------------------------------
    def reason_label(self, code: str) -> str:
        """Human label for a reason code, falling back to a title-cased code."""
        catalog = self.section("reason_catalog")
        if code in catalog:
            return str(catalog[code])
        return code.replace("_", " ").title()

    # -- registries (mailbox / vendor) -------------------------------------
    def mailbox_registry(self):
        """Build + validate the Mailbox Registry from the ``mailboxes`` section.

        Imported locally to avoid a circular import (the registry depends on ConfigError).
        """
        from registry.mailbox_registry import MailboxRegistry

        return MailboxRegistry.from_section(self.section("mailboxes"))

    def vendor_registry(self):
        """Build + validate the Vendor Registry (foundation) from the ``vendors`` section."""
        from registry.vendor_registry import VendorRegistry

        return VendorRegistry.from_section(self.section("vendors"))

    def label_registry(self):
        """Build + validate the Label Registry from the ``labels`` section."""
        from registry.label_registry import LabelRegistry

        return LabelRegistry.from_section(self.section("labels"))

    # -- gmail-native routing ----------------------------------------------
    def gmail_routing(self) -> dict:
        return self.section("gmail_routing")


class ConfigLoader:
    """Loads and validates configuration from a directory of YAML files."""

    @classmethod
    def load(cls, config_dir: str | Path = "config") -> Config:
        directory = Path(config_dir)
        if not directory.is_dir():
            raise ConfigError(f"Configuration directory not found: {directory}")

        raw: dict[str, dict] = {}
        for name in _REQUIRED_SECTIONS + _OPTIONAL_SECTIONS:
            path = directory / f"{name}.yaml"
            if not path.exists():
                if name in _REQUIRED_SECTIONS:
                    raise ConfigError(f"Required configuration file missing: {path}")
                continue
            raw[name] = cls._read_yaml(path)

        config = Config(raw=raw, config_dir=directory)
        cls._validate(config)
        return config

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _read_yaml(path: Path) -> dict:
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = yaml.safe_load(fh)
        except yaml.YAMLError as exc:  # pragma: no cover - defensive
            raise ConfigError(f"Invalid YAML in {path}: {exc}") from exc
        if data is None:
            return {}
        if not isinstance(data, dict):
            raise ConfigError(f"Top-level YAML in {path} must be a mapping, got {type(data).__name__}")
        return data

    @staticmethod
    def _validate(config: Config) -> None:
        # Document taxonomy must be non-empty.
        if not config.document_type_ids():
            raise ConfigError("document_types.yaml defines no document types")

        # routable_to_central must reference known types.
        known = set(config.document_type_ids())
        for t in config.routable_types():
            if t not in known:
                raise ConfigError(f"routable_to_central references unknown document type: {t!r}")

        # Thresholds must be sane and ordered.
        t_low, t_high = config.t_low(), config.t_high()
        for label, value in (("t_low", t_low), ("t_high", t_high)):
            if not (0.0 <= value <= 1.0):
                raise ConfigError(f"routing_rules threshold {label} must be in [0,1], got {value}")
        if t_low > t_high:
            raise ConfigError(f"routing_rules t_low ({t_low}) must be <= t_high ({t_high})")
        if config.min_corroboration() < 1:
            raise ConfigError("routing_rules min_corroboration must be >= 1")

        # Weights must be numeric.
        for scope, weights in (("layer", config.layer_weights()), ("detector", config.detector_weights())):
            for key, value in weights.items():
                if not isinstance(value, (int, float)):
                    raise ConfigError(f"score_weights {scope} weight {key!r} must be numeric, got {value!r}")
        if config.score_normalizer() <= 0:
            raise ConfigError("score_weights score_normalizer must be > 0")
