"""Shared helpers for detectors: cached regex compilation and keyword matching.

Patterns and keyword lists live in configuration; these helpers compile them once per
Config instance (memoized) so detectors stay fast without embedding any literals.
"""

from __future__ import annotations

import re
from typing import Iterable

from core.config import Config

# Memo keyed by id(config) -> compiled artifacts. Config objects are long-lived.
_ENTITY_CACHE: dict[int, dict[str, re.Pattern]] = {}
_FILENAME_CACHE: dict[int, list[re.Pattern]] = {}


def compiled_entities(config: Config) -> dict[str, re.Pattern]:
    key = id(config)
    if key not in _ENTITY_CACHE:
        entities = config.section("invoice_patterns").get("entities", {})
        _ENTITY_CACHE[key] = {
            name: re.compile(pattern) for name, pattern in entities.items()
        }
    return _ENTITY_CACHE[key]


def compiled_filename_patterns(config: Config) -> list[re.Pattern]:
    key = id(config)
    if key not in _FILENAME_CACHE:
        patterns = config.section("invoice_patterns").get("filename_patterns", [])
        _FILENAME_CACHE[key] = [re.compile(p, re.IGNORECASE) for p in patterns]
    return _FILENAME_CACHE[key]


def entity_affinity(config: Config, entity: str) -> dict[str, float]:
    """Document-type affinity carried by an entity match (from invoice_patterns.yaml)."""
    return dict(
        config.section("invoice_patterns")
        .get("entity_doc_type_affinity", {})
        .get(entity, {})
    )


def find_keywords(text: str, keywords: Iterable[str]) -> list[str]:
    """Return the keywords (lower-cased) that appear as substrings in ``text``."""
    lowered = text.lower()
    return [kw for kw in keywords if kw and kw.lower() in lowered]
