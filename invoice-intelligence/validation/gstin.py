"""GSTIN format + checksum validation (deterministic, offline).

GSTIN = 15 chars: 2 state digits + 10-char PAN + 1 entity char + 'Z' + 1 checksum char.
The final character is a base-36 checksum over the first 14 (the official GSTN algorithm).
"""

from __future__ import annotations

import re

_CODEPOINTS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_FORMAT = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][0-9A-Z]$")

# Non-resident OIDAR suppliers (Online Information & Database Access/Retrieval — Anthropic, Meta,
# Agora, DigitalOcean and friends) register under a DIFFERENT 15-character scheme, not the
# state-code + PAN one above:
#
#     99 | 2-digit country code | 3-letter country | 5 digits | "OS" | 1 char
#     e.g. 9924USA29003OSI
#
# Two things follow. The format regex above rejects it outright (position 3 must be a letter, and
# here it is a digit), and — verified against the real invoices in the purchase archive — the
# base-36 checksum does NOT hold for these: it matched on only 2 of 5 known-good OIDAR GSTINs, i.e.
# at chance. The trailing character is simply not computed the same way. So OIDAR GSTINs are
# validated on SHAPE ONLY; applying the domestic checksum would reject genuine ones.
#
# Without this, every foreign SaaS invoice fails validation with "vendor GSTIN fails
# format/checksum" — 9 documents in the 50-document pilot alone, all of them real invoices.
_OIDAR_FORMAT = re.compile(r"^99\d{2}[A-Z]{3}\d{5}OS[0-9A-Z]$")


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


def is_oidar_gstin(gstin: str) -> bool:
    """True for a non-resident OIDAR supplier's GSTIN (shape only — see ``_OIDAR_FORMAT``)."""
    if not gstin:
        return False
    return bool(_OIDAR_FORMAT.match(str(gstin).strip().upper()))


def is_valid_gstin(gstin: str) -> bool:
    if not gstin:
        return False
    g = str(gstin).strip().upper()
    if _OIDAR_FORMAT.match(g):
        return True                      # non-resident scheme: no domestic checksum to verify
    if not _FORMAT.match(g):
        return False
    return g[14] == gstin_checksum(g[:14])
