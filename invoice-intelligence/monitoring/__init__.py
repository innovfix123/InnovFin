"""Production monitoring: health checks + completeness reconciliation.

- :func:`~monitoring.health.check_health` — is the system able to run? (config, DB + live backend,
  OCR, disk). Catches a silent SQLite fallback (Category-A DB risk) by reporting the LIVE backend.
- :func:`~monitoring.health.reconcile` — proves every email in a collection run was accounted for
  (captured as a document, captured as a body doc, or explicitly logged) — the "no silent miss" proof.
"""

from monitoring.health import Check, HealthReport, check_health, reconcile

__all__ = ["Check", "HealthReport", "check_health", "reconcile"]
