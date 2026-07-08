"""Mailbox Registry — the configuration-driven source of truth for which company mailboxes
exist, where each forwards, and how each central mailbox labels invoices.

Gmail Native ONLY: this registry carries NO credentials, NO IMAP/SMTP, NO protocol — just the
routing topology that the filter generator (later milestones) turns into Gmail filters.

Nothing is hardcoded. Unlimited source and central mailboxes are supported. The registry
validates itself and fails fast with a clear :class:`ConfigError`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from core.config import ConfigError
from registry.models import (
    SEMANTIC_PRIORITY,
    CentralMailbox,
    CentralRoutingRules,
    SourceMailbox,
)


def _resolve_priority(value: Any) -> tuple[int, str]:
    """Return (numeric_priority, semantic_label) from a numeric OR semantic priority value.

    Semantic labels (critical/high/normal/low) map onto a numeric scale so numeric and
    semantic priorities coexist and sort consistently. Numeric input keeps an empty label.
    """
    if isinstance(value, str):
        key = value.strip().lower()
        if key not in SEMANTIC_PRIORITY:
            raise ConfigError(
                f"invalid semantic priority {value!r} (allowed: {sorted(SEMANTIC_PRIORITY)})"
            )
        return SEMANTIC_PRIORITY[key], key
    return int(value), ""


def _req(entry: dict, key: str, ctx: str) -> str:
    """Return a required, non-empty string field or raise a clear ConfigError."""
    if key not in entry or entry[key] in (None, ""):
        raise ConfigError(f"{ctx}: entry missing required {key!r}: {entry!r}")
    return str(entry[key])


def _check_unique(ids: list[str], what: str) -> None:
    seen: set[str] = set()
    for i in ids:
        if i in seen:
            raise ConfigError(f"duplicate {what}: {i!r}")
        seen.add(i)


@dataclass(frozen=True)
class MailboxRegistry:
    """A validated, read-only view over the configured source and central mailboxes."""

    sources: list[SourceMailbox] = field(default_factory=list)
    centrals: list[CentralMailbox] = field(default_factory=list)

    # -- accessors ----------------------------------------------------------
    def active_sources(self) -> list[SourceMailbox]:
        return [m for m in self.sources if m.active]

    def active_centrals(self) -> list[CentralMailbox]:
        return [m for m in self.centrals if m.active]

    def source_by_id(self, mailbox_id: str) -> SourceMailbox | None:
        return next((m for m in self.sources if m.id == mailbox_id), None)

    def central_by_id(self, mailbox_id: str) -> CentralMailbox | None:
        return next((m for m in self.centrals if m.id == mailbox_id), None)

    def forward_target_for(self, source: SourceMailbox) -> CentralMailbox | None:
        """The central mailbox a source forwards to (None if unset/unknown)."""
        return self.central_by_id(source.forward_target)

    # -- construction -------------------------------------------------------
    @classmethod
    def from_section(cls, raw: dict[str, Any] | None) -> "MailboxRegistry":
        """Build and validate a registry from the parsed ``mailboxes`` config section."""
        raw = raw or {}
        defaults = raw.get("defaults", {}) or {}
        centrals = [cls._central(c) for c in (raw.get("central_mailboxes") or [])]
        sources = [cls._source(s, defaults) for s in (raw.get("source_mailboxes") or [])]
        registry = cls(sources=sources, centrals=centrals)
        cls._validate(registry)
        return registry

    @classmethod
    def from_config_dir(cls, config_dir: str | Path = "config") -> "MailboxRegistry":
        """Load the registry directly from ``<config_dir>/mailboxes.yaml``."""
        path = Path(config_dir) / "mailboxes.yaml"
        if not path.exists():
            raise ConfigError(f"Mailbox Registry file missing: {path}")
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        if not isinstance(data, dict):
            raise ConfigError(f"mailboxes.yaml must be a mapping, got {type(data).__name__}")
        return cls.from_section(data)

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _central(entry: dict) -> CentralMailbox:
        rr = entry.get("routing_rules", {}) or {}
        return CentralMailbox(
            id=_req(entry, "id", "central_mailboxes"),
            name=str(entry.get("name") or entry.get("id")),
            email=_req(entry, "email", "central_mailboxes"),
            active=bool(entry.get("active", True)),
            label=str(entry.get("label", "Invoices")),
            routing_rules=CentralRoutingRules(
                match_from=list(rr.get("match_from") or []),
                match_subject=list(rr.get("match_subject") or []),
                plus_address=(rr.get("plus_address") or None),
                use_invoice_signals=bool(rr.get("use_invoice_signals", False)),
            ),
        )

    @staticmethod
    def _source(entry: dict, defaults: dict) -> SourceMailbox:
        def pick(key: str, fallback: Any) -> Any:
            if key in entry:
                return entry[key]
            return defaults.get(key, fallback)

        priority, priority_label = _resolve_priority(pick("priority", "normal"))
        return SourceMailbox(
            id=_req(entry, "id", "source_mailboxes"),
            name=str(entry.get("name") or entry.get("id")),
            email=_req(entry, "email", "source_mailboxes"),
            department=str(pick("department", "")),
            active=bool(pick("active", True)),
            priority=priority,
            priority_label=priority_label,
            forward_target=str(pick("forward_target", "") or ""),
            labels=list(pick("labels", []) or []),
            assigned_rules=list(pick("assigned_rules", []) or []),
        )

    @staticmethod
    def _validate(reg: "MailboxRegistry") -> None:
        if not reg.centrals:
            raise ConfigError("Mailbox Registry defines no central_mailboxes")

        _check_unique([c.id for c in reg.centrals], "central mailbox id")
        _check_unique([s.id for s in reg.sources], "source mailbox id")

        for c in reg.centrals:
            if "@" not in c.email:
                raise ConfigError(f"central mailbox {c.id!r} has invalid email: {c.email!r}")

        central_ids = {c.id for c in reg.centrals}
        for s in reg.sources:
            if "@" not in s.email:
                raise ConfigError(f"source mailbox {s.id!r} has invalid email: {s.email!r}")
            if s.active and not s.forward_target:
                raise ConfigError(
                    f"active source mailbox {s.id!r} has no forward_target "
                    f"(set it on the mailbox or in defaults)"
                )
            if s.forward_target and s.forward_target not in central_ids:
                raise ConfigError(
                    f"source mailbox {s.id!r} forward_target {s.forward_target!r} does not "
                    f"reference a known central mailbox {sorted(central_ids)}"
                )
