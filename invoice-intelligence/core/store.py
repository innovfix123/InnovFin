"""Persistence interface for stateful detectors.

Two detectors need state:
  * vendor history  — how often we have seen invoices from a sender before;
  * duplicate detection — message-ids / attachment hashes already processed.

Phase 1 has NO database (by design), so the default implementations are an in-memory
store and a JSONL file-backed store. The interface is deliberately tiny so a future
phase can drop in a real database without touching detectors.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Iterator


class Store(ABC):
    """A minimal key/value store."""

    @abstractmethod
    def get(self, key: str, default: Any = None) -> Any: ...

    @abstractmethod
    def put(self, key: str, value: Any) -> None: ...

    @abstractmethod
    def contains(self, key: str) -> bool: ...

    def add(self, key: str) -> bool:
        """Record ``key`` as seen. Returns True if it was new, False if already present."""
        if self.contains(key):
            return False
        self.put(key, True)
        return True


class InMemoryStore(Store):
    """Non-persistent store — ideal for tests and simulation runs."""

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def put(self, key: str, value: Any) -> None:
        self._data[key] = value

    def contains(self, key: str) -> bool:
        return key in self._data

    def __len__(self) -> int:
        return len(self._data)

    def items(self) -> Iterator[tuple[str, Any]]:
        return iter(self._data.items())


class JsonlStore(Store):
    """File-backed store: one JSON object ``{"k":..., "v":...}`` per line (append-only).

    On construction it replays the file into memory. ``put`` updates memory and appends a
    line. Last-write-wins on load. Suitable for POC volumes; not concurrency-safe.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._data: dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    self._data[record["k"]] = record["v"]
                except (json.JSONDecodeError, KeyError):
                    continue  # tolerate a corrupt trailing line

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def put(self, key: str, value: Any) -> None:
        self._data[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"k": key, "v": value}) + "\n")

    def contains(self, key: str) -> bool:
        return key in self._data

    def __len__(self) -> int:
        return len(self._data)
