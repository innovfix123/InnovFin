"""Vendor Registry — FOUNDATION ONLY (Milestone 1).

This provides a clean, validated configuration structure for vendors so that later
milestones (vendor-aware detection, normalization, dedup by vendor+invoice number) can build
on it WITHOUT re-shaping config. It intentionally contains NO business logic yet.

It is separate from the existing ``config/trusted_vendors.yaml`` (used live by the detectors),
so introducing this foundation changes no working code. A future milestone will consolidate
the two once the vendor-aware features are designed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from core.config import ConfigError
from registry.models import Vendor

_ALLOWED_TRUST = {"normal", "trusted", "strategic"}


@dataclass(frozen=True)
class VendorRegistry:
    """A validated, read-only view over configured vendors (foundation)."""

    vendors: list[Vendor] = field(default_factory=list)

    # -- accessors ----------------------------------------------------------
    def active_vendors(self) -> list[Vendor]:
        return [v for v in self.vendors if v.active]

    def vendor_by_id(self, vendor_id: str) -> Vendor | None:
        return next((v for v in self.vendors if v.id == vendor_id), None)

    def all_domains(self) -> list[str]:
        seen: list[str] = []
        for v in self.vendors:
            for d in v.domains:
                if d not in seen:
                    seen.append(d)
        return seen

    # -- construction -------------------------------------------------------
    @classmethod
    def from_section(cls, raw: dict[str, Any] | None) -> "VendorRegistry":
        raw = raw or {}
        defaults = raw.get("defaults", {}) or {}
        vendors = [cls._vendor(v, defaults) for v in (raw.get("vendors") or [])]
        registry = cls(vendors=vendors)
        cls._validate(registry)
        return registry

    @classmethod
    def from_config_dir(cls, config_dir: str | Path = "config") -> "VendorRegistry":
        """Load from ``<config_dir>/vendors.yaml``; a missing file yields an empty registry
        (the foundation is optional and must never break the system by its absence)."""
        path = Path(config_dir) / "vendors.yaml"
        if not path.exists():
            return cls(vendors=[])
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        if not isinstance(data, dict):
            raise ConfigError(f"vendors.yaml must be a mapping, got {type(data).__name__}")
        return cls.from_section(data)

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _vendor(entry: dict, defaults: dict) -> Vendor:
        vid = entry.get("id") or entry.get("name")
        if not vid:
            raise ConfigError(f"vendors: entry missing both 'id' and 'name': {entry!r}")
        trust = str(entry.get("trust_level", defaults.get("trust_level", "normal")))
        return Vendor(
            id=str(vid),
            name=str(entry.get("name") or vid),
            active=bool(entry.get("active", defaults.get("active", True))),
            trust_level=trust,
            category=str(entry.get("category", defaults.get("category", ""))),
            priority=str(entry.get("priority", defaults.get("priority", "normal"))),
            finance_type=str(entry.get("finance_type", defaults.get("finance_type", ""))),
            domains=list(entry.get("domains") or []),
            gstins=list(entry.get("gstins") or []),
            aliases=list(entry.get("aliases") or []),
        )

    @staticmethod
    def _validate(reg: "VendorRegistry") -> None:
        seen: set[str] = set()
        for v in reg.vendors:
            if v.id in seen:
                raise ConfigError(f"duplicate vendor id: {v.id!r}")
            seen.add(v.id)
            if v.trust_level not in _ALLOWED_TRUST:
                raise ConfigError(
                    f"vendor {v.id!r} has invalid trust_level {v.trust_level!r} "
                    f"(allowed: {sorted(_ALLOWED_TRUST)})"
                )
