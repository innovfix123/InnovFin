"""Tests for the importable Gmail filters XML export."""

import xml.etree.ElementTree as ET

from core.config import ConfigLoader
from gmail_native.filters_export import build_filters_xml

_ATOM = "{http://www.w3.org/2005/Atom}"
_APPS = "{http://schemas.google.com/apps/2006}"


def _xml():
    return build_filters_xml(ConfigLoader.load("config"))


def test_export_is_well_formed_xml():
    root = ET.fromstring(_xml())
    assert root.tag == f"{_ATOM}feed"
    entries = root.findall(f"{_ATOM}entry")
    assert len(entries) == 2  # invoice + review


def test_invoice_entry_forwards_to_central():
    root = ET.fromstring(_xml())
    config = ConfigLoader.load("config")
    forward_to = config.gmail_routing()["forward_to"]

    invoice_entry = root.findall(f"{_ATOM}entry")[0]
    props = {p.get("name"): p.get("value") for p in invoice_entry.findall(f"{_APPS}property")}
    assert props.get("forwardTo") == forward_to
    assert props.get("shouldForward") == "true"
    assert props.get("label")
    assert "has:attachment" in props.get("hasTheWord", "") or "filename" in props.get("hasTheWord", "")


def test_review_entry_labels_but_does_not_forward():
    root = ET.fromstring(_xml())
    review_entry = root.findall(f"{_ATOM}entry")[1]
    props = {p.get("name"): p.get("value") for p in review_entry.findall(f"{_APPS}property")}
    assert props.get("label")
    assert "forwardTo" not in props
    assert "shouldForward" not in props


def test_special_characters_are_escaped():
    # hasTheWord contains quotes and ampersand-free operators; ensure valid XML round-trips.
    xml = _xml()
    root = ET.fromstring(xml)  # would raise if not well-formed
    assert root is not None
