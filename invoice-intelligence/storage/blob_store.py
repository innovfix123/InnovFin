"""Content-addressed blob store.

Raw attachment bytes are stored under their SHA-256. Because the path is derived from the
content hash, identical bytes map to the same path and are stored **once** — de-duplication is
a property of the store, not extra logic. (Full invoice-level dedup is a later milestone.)
"""

from __future__ import annotations

import hashlib
from pathlib import Path


class FilesystemBlobStore:
    """Store/retrieve immutable blobs on the local filesystem, keyed by SHA-256."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def put(self, data: bytes) -> tuple[str, str]:
        """Store ``data`` (idempotently) and return ``(sha256_hex, path)``."""
        digest = hashlib.sha256(data).hexdigest()
        path = self._path(digest)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return digest, str(path)

    def get(self, digest: str) -> bytes:
        """Return the bytes stored under ``digest`` (raises KeyError if absent)."""
        path = self._path(digest)
        if not path.exists():
            raise KeyError(f"blob not found: {digest}")
        return path.read_bytes()

    def exists(self, digest: str) -> bool:
        return self._path(digest).exists()

    def _path(self, digest: str) -> Path:
        # shard by first 2 hex chars to avoid one huge directory
        return self.root / digest[:2] / f"{digest}.bin"
