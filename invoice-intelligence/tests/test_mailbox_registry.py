"""Unit tests for the Mailbox Registry (registry.mailbox_registry)."""

import pytest

from core.config import ConfigError, ConfigLoader
from registry.mailbox_registry import MailboxRegistry


def _valid_section():
    return {
        "defaults": {"forward_target": "central-primary", "priority": 100, "active": True},
        "central_mailboxes": [
            {
                "id": "central-primary",
                "name": "Finance Central",
                "email": "central@company.com",
                "label": "Invoices",
                "routing_rules": {"match_from": ["a@x.com", "b@y.com"]},
            }
        ],
        "source_mailboxes": [
            {"id": "src-a", "name": "A", "email": "a@x.com", "department": "Finance"},
            {"id": "src-b", "name": "B", "email": "b@y.com", "priority": 50, "active": False},
        ],
    }


def test_shipped_config_loads_and_validates():
    """The real config/mailboxes.yaml must load and validate."""
    reg = ConfigLoader.load("config").mailbox_registry()
    assert len(reg.centrals) >= 1
    assert len(reg.sources) >= 2
    assert reg.central_by_id("central-primary") is not None
    # every active source must resolve to a real central mailbox
    for s in reg.active_sources():
        assert reg.forward_target_for(s) is not None


def test_from_config_dir_matches_section():
    direct = MailboxRegistry.from_config_dir("config")
    via_config = ConfigLoader.load("config").mailbox_registry()
    assert [c.id for c in direct.centrals] == [c.id for c in via_config.centrals]


def test_defaults_are_applied_to_sources():
    reg = MailboxRegistry.from_section(_valid_section())
    src_a = reg.source_by_id("src-a")
    assert src_a.forward_target == "central-primary"   # from defaults
    assert src_a.priority == 100                        # from defaults
    assert src_a.active is True


def test_active_filtering():
    reg = MailboxRegistry.from_section(_valid_section())
    assert {m.id for m in reg.active_sources()} == {"src-a"}
    assert reg.source_by_id("src-b").active is False


def test_routing_rules_parsed():
    reg = MailboxRegistry.from_section(_valid_section())
    c = reg.central_by_id("central-primary")
    assert c.routing_rules.match_from == ["a@x.com", "b@y.com"]
    assert c.routing_rules.plus_address is None


def test_no_central_raises():
    section = _valid_section()
    section["central_mailboxes"] = []
    with pytest.raises(ConfigError):
        MailboxRegistry.from_section(section)


def test_unknown_forward_target_raises():
    section = _valid_section()
    section["source_mailboxes"][0]["forward_target"] = "does-not-exist"
    with pytest.raises(ConfigError):
        MailboxRegistry.from_section(section)


def test_duplicate_source_id_raises():
    section = _valid_section()
    section["source_mailboxes"].append(
        {"id": "src-a", "email": "dup@x.com"}
    )
    with pytest.raises(ConfigError):
        MailboxRegistry.from_section(section)


def test_missing_required_email_raises():
    section = _valid_section()
    del section["source_mailboxes"][0]["email"]
    with pytest.raises(ConfigError):
        MailboxRegistry.from_section(section)


def test_active_source_without_forward_target_raises():
    section = _valid_section()
    section["defaults"] = {}  # remove default forward_target
    # src-a is active and now has no forward_target anywhere
    with pytest.raises(ConfigError):
        MailboxRegistry.from_section(section)


def test_invalid_email_raises():
    section = _valid_section()
    section["central_mailboxes"][0]["email"] = "not-an-email"
    with pytest.raises(ConfigError):
        MailboxRegistry.from_section(section)
