"""Unit tests for core.email_document."""

from core.email_document import Attachment, AuthResult, AuthResults, EmailDocument


def test_sender_domain_extraction():
    doc = EmailDocument(from_addr="billing@amazon.in")
    assert doc.sender_domain == "amazon.in"


def test_sender_domain_with_display_name_form():
    doc = EmailDocument(from_addr="no-reply@aws.amazon.com")
    assert doc.sender_domain == "aws.amazon.com"


def test_sender_domain_empty_when_no_at():
    doc = EmailDocument(from_addr="not-an-email")
    assert doc.sender_domain == ""


def test_attachment_helpers():
    pdf = Attachment(filename="Invoice_2026.PDF", mime_type="application/pdf", size=1024)
    assert pdf.extension == ".pdf"
    assert pdf.is_pdf
    xml = Attachment(filename="einvoice.xml", mime_type="application/xml", is_structured_xml=True)
    assert xml.extension == ".xml"
    assert not xml.is_pdf


def test_reply_and_forward_detection():
    assert EmailDocument(subject="Re: Invoice INV-1").is_reply
    assert EmailDocument(subject="FWD: Tax Invoice").is_forward
    assert EmailDocument(in_reply_to="<abc@x>").is_reply
    assert not EmailDocument(subject="Tax Invoice INV-1").is_reply


def test_has_attachments_and_count():
    doc = EmailDocument(attachments=(Attachment("a.pdf", "application/pdf"),))
    assert doc.has_attachments
    assert doc.attachment_count == 1
    assert not EmailDocument().has_attachments


def test_case_insensitive_header_lookup():
    doc = EmailDocument(headers={"List-Unsubscribe": "<mailto:x>"})
    assert doc.header("list-unsubscribe") == "<mailto:x>"
    assert doc.header("Missing", "default") == "default"


def test_auth_results():
    auth = AuthResults(spf=AuthResult.PASS, dkim=AuthResult.PASS, dmarc=AuthResult.PASS)
    assert auth.all_pass
    assert not auth.any_fail
    failing = AuthResults(spf=AuthResult.FAIL)
    assert failing.any_fail
    assert not failing.all_pass


def test_searchable_text_is_lowercase_subject_plus_body():
    doc = EmailDocument(subject="Tax Invoice", body_text="Amount Due 100")
    assert "tax invoice" in doc.searchable_text
    assert "amount due 100" in doc.searchable_text


def test_document_is_immutable():
    doc = EmailDocument(subject="x")
    try:
        doc.subject = "y"
        assert False, "expected immutability"
    except Exception:
        pass
