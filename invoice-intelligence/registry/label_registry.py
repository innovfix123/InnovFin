"""Label Registry — the single source of truth for Gmail label strings.

Filters reference a label by KEY (e.g. ``tier_vendor``); this registry resolves the key to
the actual Gmail label (e.g. ``Invoices/Tier/Vendor``). No label string is hardcoded in the
generator — renaming a label here updates every generated filter with no code change.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from core.config import ConfigError


@dataclass(frozen=True)
class LabelRegistry:
    """A validated, read-only key → Gmail-label mapping."""

    labels: dict[str, str] = field(default_factory=dict)

    def resolve(self, key: str) -> str:
        """Return the Gmail label for a key, or raise a clear ConfigError if unknown."""
        if key not in self.labels:
            raise ConfigError(
                f"unknown label key {key!r} (known: {sorted(self.labels)})"
            )
        return self.labels[key]

    def has(self, key: str) -> bool:
        return key in self.labels

    def keys(self) -> list[str]:
        return list(self.labels)

    # -- construction -------------------------------------------------------
    @classmethod
    def from_section(cls, raw: dict[str, Any] | None) -> "LabelRegistry":
        raw = raw or {}
        labels = raw.get("labels", {}) or {}
        if not isinstance(labels, dict):
            raise ConfigError("labels.yaml 'labels' must be a mapping of key -> label")
        resolved: dict[str, str] = {}
        for key, value in labels.items():
            if not value or not str(value).strip():
                raise ConfigError(f"label key {key!r} has an empty label value")
            resolved[str(key)] = str(value)
        return cls(labels=resolved)

    @classmethod
    def from_config_dir(cls, config_dir: str | Path = "config") -> "LabelRegistry":
        path = Path(config_dir) / "labels.yaml"
        if not path.exists():
            raise ConfigError(f"Label Registry file missing: {path}")
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        if not isinstance(data, dict):
            raise ConfigError(f"labels.yaml must be a mapping, got {type(data).__name__}")
        return cls.from_section(data)
