"""Core abstractions for the Invoice Email Gateway.

This package holds the *stable* contracts that the rest of the system depends on:

- `Signal`          — one unit of evidence emitted by a detector
- `EmailDocument`   — a normalized, parsed email (detector input)
- `Detector`        — the plugin interface every detection technique implements
- `DetectorRegistry`— builds enabled detectors from configuration
- `Store`           — persistence interface for vendor history / duplicate detection
- `Config`          — validated view over the YAML configuration

These contracts are intentionally small so that new detectors — including future OCR
and AI modules — plug in without changing the scoring or decision architecture.
"""

from core.signal import Polarity, Signal
from core.email_document import Attachment, AuthResult, AuthResults, EmailDocument
from core.detector import Detector, DetectorContext
from core.store import Store, InMemoryStore, JsonlStore
from core.registry import DetectorRegistry, register_detector, registered_detectors
from core.config import Config, ConfigLoader, ConfigError

__all__ = [
    "Polarity",
    "Signal",
    "Attachment",
    "AuthResult",
    "AuthResults",
    "EmailDocument",
    "Detector",
    "DetectorContext",
    "Store",
    "InMemoryStore",
    "JsonlStore",
    "DetectorRegistry",
    "register_detector",
    "registered_detectors",
    "Config",
    "ConfigLoader",
    "ConfigError",
]
