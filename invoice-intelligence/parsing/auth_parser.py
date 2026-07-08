"""Parse the ``Authentication-Results`` header into SPF / DKIM / DMARC results.

These are trust signals (a real invoice sender almost always authenticates; a spoofed one
often fails). Failures never hard-reject — they downgrade a would-be Invoice to Review.
"""

from __future__ import annotations

import re

from core.email_document import AuthResult, AuthResults

_METHOD_RE = {
    "spf": re.compile(r"\bspf\s*=\s*(\w+)", re.IGNORECASE),
    "dkim": re.compile(r"\bdkim\s*=\s*(\w+)", re.IGNORECASE),
    "dmarc": re.compile(r"\bdmarc\s*=\s*(\w+)", re.IGNORECASE),
}


def _classify(token: str | None) -> AuthResult:
    if not token:
        return AuthResult.NONE
    token = token.lower()
    if token == "pass":
        return AuthResult.PASS
    if token in ("fail", "softfail", "permerror", "temperror", "none", "neutral"):
        # Treat only explicit fail/softfail as FAIL; the rest are "not proven".
        return AuthResult.FAIL if token in ("fail", "softfail") else AuthResult.NONE
    return AuthResult.NONE


def parse_auth_results(header_value: str) -> AuthResults:
    """Parse one or more Authentication-Results header values."""
    if not header_value:
        return AuthResults()
    results = {}
    for method, pattern in _METHOD_RE.items():
        match = pattern.search(header_value)
        results[method] = _classify(match.group(1) if match else None)
    return AuthResults(spf=results["spf"], dkim=results["dkim"], dmarc=results["dmarc"])
