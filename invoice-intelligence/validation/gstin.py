"""GSTIN format + checksum validation (deterministic, offline).

GSTIN = 15 chars: 2 state digits + 10-char PAN + 1 entity char + 'Z' + 1 checksum char.
The final character is a base-36 checksum over the first 14 (the official GSTN algorithm).
"""

from __future__ import annotations

import re

_CODEPOINTS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_FORMAT = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][0-9A-Z]$")


def gstin_checksum(first14: str) -> str:
    """Return the checksum character for the first 14 characters of a GSTIN."""
    base = len(_CODEPOINTS)
    factor = 2
    total = 0
    for ch in reversed(first14):
        code = _CODEPOINTS.index(ch)
        addend = factor * code
        factor = 1 if factor == 2 else 2
        addend = (addend // base) + (addend % base)
        total += addend
    check = (base - (total % base)) % base
    return _CODEPOINTS[check]


def is_valid_gstin(gstin: str) -> bool:
    if not gstin:
        return False
    g = str(gstin).strip().upper()
    if not _FORMAT.match(g):
        return False
    return g[14] == gstin_checksum(g[:14])
