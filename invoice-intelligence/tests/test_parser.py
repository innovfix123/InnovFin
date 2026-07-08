"""Unit tests for the MIME parser."""

from parsing.mime_parser import parse_email
from testing.samples import labeled_samples


def _sample(name: str) -> bytes:
    return next(s["raw"] for s in labeled_samples() if s["name"] == name)


def test_parses_headers_and_sender_domain():
    doc = parse_email(_sample("amazon_tax_invoice"))
    assert doc.sender_domain == "amazon.in"
    assert "tax invoice" in doc.subject.lower()
    assert doc.message_id


def test_parses_attachment_metadata_and_hash():
    doc = parse_email(_sample("amazon_tax_invoice"))
    assert doc.attachment_count == 1
    att = doc.attachments[0]
    assert att.filename == "Invoice_INV-2026-001.pdf"
    assert att.is_pdf
    assert len(att.sha256) == 64
    assert att.size > 0


def test_detects_structured_xml_attachment():
    doc = parse_email(_sample("razorpay_xml_invoice"))
    assert any(a.is_structured_xml for a in doc.attachments)


def test_parses_authentication_results():
    doc = parse_email(_sample("amazon_tax_invoice"))
    assert doc.auth.all_pass


def test_calendar_method_marker_extracted():
    doc = parse_email(_sample("meeting_invite"))
    assert doc.header("X-Gateway-Calendar-Method") == "REQUEST"


def test_list_unsubscribe_header_preserved():
    doc = parse_email(_sample("newsletter"))
    assert doc.header("List-Unsubscribe")


def test_body_text_is_extracted():
    doc = parse_email(_sample("aws_case_b_attachment_only"))
    assert "attached document" in doc.body_text.lower()


def test_encrypted_pdf_flag():
    from testing.samples import encrypted_pdf_sample

    doc = parse_email(encrypted_pdf_sample())
    assert any(a.is_encrypted for a in doc.attachments)
