"""Configuration registries for the Invoice Email Gateway.

This package holds the *configuration-driven* registries that describe the routing topology
of the system:

- :mod:`registry.mailbox_registry` — the Mailbox Registry (source + central mailboxes).
- :mod:`registry.vendor_registry`  — the Vendor Registry (foundation for later milestones).

These are distinct from ``core.registry`` (the detector *plugin* registry). Registries here
carry validated configuration only — no business logic, no credentials, no transport.
"""
