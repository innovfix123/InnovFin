"""Detector registry — builds the enabled detector plugins from configuration.

Detectors register themselves with :func:`register_detector` (a class decorator). The
:class:`DetectorRegistry` reads ``config/detectors.yaml`` and instantiates the enabled,
registered detectors in the order they appear in configuration.

To keep the project runnable while detectors are still being implemented, an id that is
listed in configuration but has no registered class is *skipped with a warning* unless
``strict: true`` is set in ``config/detectors.yaml``.
"""

from __future__ import annotations

import logging
from typing import Type

from core.config import Config
from core.detector import Detector

logger = logging.getLogger(__name__)

# Global registry: detector_id -> Detector subclass.
_REGISTRY: dict[str, Type[Detector]] = {}


def register_detector(cls: Type[Detector]) -> Type[Detector]:
    """Class decorator that registers a Detector subclass by its ``detector_id``."""
    detector_id = getattr(cls, "detector_id", "")
    if not detector_id:
        raise ValueError(f"{cls.__name__} must define detector_id to be registered")
    if detector_id in _REGISTRY and _REGISTRY[detector_id] is not cls:
        raise ValueError(
            f"Duplicate detector_id {detector_id!r}: "
            f"{_REGISTRY[detector_id].__name__} and {cls.__name__}"
        )
    _REGISTRY[detector_id] = cls
    return cls


def registered_detectors() -> dict[str, Type[Detector]]:
    """Return a copy of the current id -> class registry."""
    return dict(_REGISTRY)


class UnknownDetectorError(Exception):
    """Raised in strict mode when configuration references an unregistered detector."""


class DetectorRegistry:
    """Instantiates the configured, enabled detectors."""

    def __init__(self, detector_configs: list[dict], strict: bool = False) -> None:
        self._configs = detector_configs
        self._strict = strict

    @classmethod
    def from_config(cls, config: Config) -> "DetectorRegistry":
        return cls(config.detector_configs(), strict=config.detectors_strict())

    def build(self) -> list[Detector]:
        """Return instances of enabled detectors, in configuration order.

        Disabled detectors are ignored. Unregistered ids are skipped (non-strict) or
        raise :class:`UnknownDetectorError` (strict).
        """
        detectors: list[Detector] = []
        for entry in self._configs:
            detector_id = entry.get("id")
            if not entry.get("enabled", False):
                continue
            cls = _REGISTRY.get(detector_id)
            if cls is None:
                message = f"Detector {detector_id!r} is enabled in config but not registered"
                if self._strict:
                    raise UnknownDetectorError(message)
                logger.warning("%s - skipping (non-strict mode)", message)
                continue
            detectors.append(cls())
        return detectors
