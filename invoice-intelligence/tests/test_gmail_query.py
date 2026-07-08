"""Tests for the Gmail query builder and the query simulator."""

from core.config import ConfigLoader
from core.email_document import Attachment, EmailDocument
from gmail_native.query_builder import build_invoice_query, build_review_query
from gmail_native.query_sim import parse_query, query_matches, tokenize
from parsing.mime_parser import parse_email
from testing.samples import labeled_samples


def _cfg():
    return ConfigLoader.load("config")


# -- simulator primitives ---------------------------------------------------

def test_tokenizer_keeps_quoted_phrases():
    toks = tokenize('subject:"tax invoice" OR invoice')
    assert 'subject:"tax invoice"' in toks
    assert "OR" in toks


def test_tokenizer_splits_negated_group():
    toks = tokenize("invoice -(from:linkedin.com OR from:github.com)")
    assert "-" in toks and "(" in toks and ")" in toks


def test_has_attachment_atom():
    doc = EmailDocument(attachments=(Attachment("a.pdf", "application/pdf"),))
    assert query_matches("has:attachment", doc)
    assert not query_matches("has:attachment", EmailDocument())


def test_from_and_subject_atoms():
    doc = EmailDocument(from_addr="billing@amazon.in", subject="Tax Invoice INV-1")
    assert query_matches("from:amazon.in", doc)
    assert query_matches('subject:"tax invoice"', doc)
    assert not query_matches("from:aws.amazon.com", doc)


def test_filename_atom_matches_name_and_extension():
    doc = EmailDocument(attachments=(Attachment("AWS_Invoice.pdf", "application/pdf"),))
    assert query_matches("filename:invoice", doc)
    assert query_matches("filename:pdf", doc)
    assert not query_matches("filename:xml", doc)


def test_or_and_negation_semantics():
    doc = EmailDocument(from_addr="x@github.com", subject="pull request")
    assert query_matches("from:github.com OR from:linkedin.com", doc)
    assert not query_matches("invoice -(from:github.com)", doc)  # negation excludes it
    assert query_matches("(pull request) -from:linkedin.com", doc)


def test_attachment_contents_are_invisible():
    # The word is only 'inside' a (simulated) attachment; body/subject/name don't contain it.
    doc = EmailDocument(subject="hello", body_text="see file",
                        attachments=(Attachment("scan001.pdf", "application/pdf"),))
    assert not query_matches("gstin", doc)  # cannot see inside the PDF — by design


# -- generated queries on the labeled corpus --------------------------------

def test_invoice_query_forwards_clear_invoices():
    cfg = _cfg()
    q = build_invoice_query(cfg)
    for name in ("amazon_tax_invoice", "aws_case_b_attachment_only", "razorpay_xml_invoice"):
        raw = next(s["raw"] for s in labeled_samples() if s["name"] == name)
        assert query_matches(q, parse_email(raw)), f"{name} should be forwarded natively"


def test_invoice_query_excludes_obvious_negatives():
    cfg = _cfg()
    q = build_invoice_query(cfg)
    for name in ("meeting_invite", "newsletter", "otp_security", "linkedin_notification"):
        raw = next(s["raw"] for s in labeled_samples() if s["name"] == name)
        assert not query_matches(q, parse_email(raw)), f"{name} must NOT be forwarded"


def test_review_query_excludes_strong_invoices():
    cfg = _cfg()
    invoice_q = build_invoice_query(cfg)
    review_q = build_review_query(cfg)
    raw = next(s["raw"] for s in labeled_samples() if s["name"] == "amazon_tax_invoice")
    doc = parse_email(raw)
    # A strong invoice is forwarded, so it should NOT also fall into the review tier.
    assert query_matches(invoice_q, doc)
    assert not query_matches(review_q, doc)
