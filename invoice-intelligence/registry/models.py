"""Typed configuration models for the Mailbox Registry and Vendor Registry.

Plain frozen dataclasses, consistent with ``core.config``'s dataclass style. They hold
*validated configuration only* — NO business logic. Later milestones layer detection,
routing and normalization on top of these models without changing their shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Semantic mailbox priorities → numeric ordering weight (higher = more important).
# Numeric priorities remain fully supported; semantic labels map onto this scale so the
# two can coexist and sort consistently.
SEMANTIC_PRIORITY: dict[str, int] = {
    "critical": 400,
    "high": 300,
    "normal": 200,
    "low": 100,
}


@dataclass(frozen=True)
class CentralRoutingRules:
    """Gmail-native criteria used to recognise forwarded invoice mail *inside* a central
    mailbox, so a central-side filter can apply the ``Invoices`` label.

    Sender-address matching (``match_from``) is the default, reliable native mechanism.
    ``plus_address`` is an OPTIONAL optimization (e.g. ``finance+invoices@company.com``) —
    offered only if the customer's environment supports it, never required.
    """

    match_from: list[str] = field(default_factory=list)
    match_subject: list[str] = field(default_factory=list)
    plus_address: str | None = None
    # When true, the central filter matches INVOICE SIGNALS (same detection as the forward
    # query) instead of the source addresses — robust because forwarded Gmail shows the
    # ORIGINAL sender in `From`, so sender-address matching in central does not work.
    use_invoice_signals: bool = False


@dataclass(frozen=True)
class CentralMailbox:
    """A central "single source of truth" mailbox that invoices are forwarded into."""

    id: str
    name: str
    email: str
    active: bool = True
    label: str = "Invoices"
    routing_rules: CentralRoutingRules = field(default_factory=CentralRoutingRules)


@dataclass(frozen=True)
class SourceMailbox:
    """A company mailbox monitored for invoices. Unlimited of these are supported."""

    id: str
    name: str
    email: str
    department: str = ""
    active: bool = True
    priority: int = 200                   # numeric ordering weight (higher = more important)
    priority_label: str = ""              # semantic label if one was configured (else "")
    forward_target: str = ""              # id of a CentralMailbox
    labels: list[str] = field(default_factory=list)
    assigned_rules: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Vendor:
    """A known invoice-sending vendor. FOUNDATION ONLY in this milestone — no logic yet."""

    id: str
    name: str
    active: bool = True
    trust_level: str = "normal"           # normal | trusted | strategic
    category: str = ""                    # future-ready: e.g. cloud, payments, telecom, saas
    priority: str = "normal"              # future-ready semantic priority (critical/high/normal/low)
    finance_type: str = ""                # future-ready: e.g. invoice, subscription, utility
    domains: list[str] = field(default_factory=list)
    gstins: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)
