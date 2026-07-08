"""Labeled sample emails covering the key cases, built as real RFC822 messages.

Used by unit tests (correctness) and by ``cli.py classify --demo`` (visual demo). This is
a small illustrative set; the large labeled corpus + metrics arrive in the evaluation
milestone.
"""

from __future__ import annotations

from email.message import EmailMessage

_PDF_BYTES = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
_ENCRYPTED_PDF = b"%PDF-1.6\n/Encrypt 5 0 R\n1 0 obj<<>>endobj\n%%EOF\n"
_XML_INVOICE = b"<?xml version='1.0'?><Invoice><ID>INV-1</ID></Invoice>"


def _build(
    *,
    sender: str,
    subject: str,
    body: str,
    to: str = "sat211053@gmail.com",
    attachments: list[tuple[str, str, bytes]] | None = None,
    extra_headers: dict[str, str] | None = None,
    auth_pass: bool = True,
) -> bytes:
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = f"<{abs(hash((sender, subject))) % 10**10}@mail>"
    if auth_pass:
        msg["Authentication-Results"] = "mx.google.com; spf=pass; dkim=pass; dmarc=pass"
    for key, value in (extra_headers or {}).items():
        msg[key] = value
    msg.set_content(body)
    for filename, mime, payload in attachments or []:
        maintype, _, subtype = mime.partition("/")
        msg.add_attachment(payload, maintype=maintype, subtype=subtype, filename=filename)
    return msg.as_bytes()


def labeled_samples() -> list[dict]:
    """Return [{name, raw, expected}] where expected is the Category value string."""
    samples: list[dict] = []

    # 1) Classic invoice email: subject says invoice, attachment + GSTIN + amount.
    samples.append({
        "name": "amazon_tax_invoice",
        "expected": "Invoice",
        "raw": _build(
            sender="Amazon <no-reply@amazon.in>",
            subject="Tax Invoice INV-2026-001",
            body=(
                "Dear Customer,\nPlease find attached invoice for your order.\n"
                "Invoice Number: INV-2026-001\nGSTIN: 27AABCU9603R1ZM\n"
                "Amount Due: INR 12,500.00\nThank you."
            ),
            attachments=[("Invoice_INV-2026-001.pdf", "application/pdf", _PDF_BYTES)],
        ),
    })

    # 2) Case B: unrelated subject, invoice lives in the attachment + trusted sender.
    samples.append({
        "name": "aws_case_b_attachment_only",
        "expected": "Invoice",
        "raw": _build(
            sender="AWS <no-reply@aws.amazon.com>",
            subject="June Cloud Services",
            body="Hello,\nPlease find the attached document for this month.\nRegards, AWS",
            attachments=[("AWS_Invoice_2026.pdf", "application/pdf", _PDF_BYTES)],
        ),
    })

    # 3) Structured e-invoice (XML) from a trusted vendor.
    samples.append({
        "name": "razorpay_xml_invoice",
        "expected": "Invoice",
        "raw": _build(
            sender="Razorpay <invoices@razorpay.com>",
            subject="Your Tax Invoice",
            body="Your GST tax invoice is attached. GSTIN: 29AAGCR1234M1Z5. Amount: INR 5,900.00",
            attachments=[("razorpay_tax_invoice.xml", "application/xml", _XML_INVOICE)],
        ),
    })

    # 4) Meeting invite -> Not Invoice (strong negative, no financial evidence).
    samples.append({
        "name": "meeting_invite",
        "expected": "Not Invoice",
        "raw": _build(
            sender="Alice <alice@company.com>",
            subject="Meeting: Project Sync",
            body="Let's meet to discuss the project.",
            attachments=[("invite.ics", "text/calendar", b"BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR")],
        ),
    })

    # 5) Marketing newsletter -> Not Invoice (List-Unsubscribe, no positive evidence).
    samples.append({
        "name": "newsletter",
        "expected": "Not Invoice",
        "raw": _build(
            sender="Deals <marketing@deals.example.com>",
            subject="Weekly Newsletter - Top Deals",
            body="Check out this week's top deals and offers!",
            extra_headers={"List-Unsubscribe": "<mailto:unsub@deals.example.com>"},
        ),
    })

    # 6) OTP / security -> Not Invoice.
    samples.append({
        "name": "otp_security",
        "expected": "Not Invoice",
        "raw": _build(
            sender="Security <security@service.com>",
            subject="Your OTP code",
            body="Your one-time password is 123456. Do not share it.",
        ),
    })

    # 7) LinkedIn notification -> Not Invoice (notification domain).
    samples.append({
        "name": "linkedin_notification",
        "expected": "Not Invoice",
        "raw": _build(
            sender="LinkedIn <notifications@linkedin.com>",
            subject="You have 3 new connection requests",
            body="See who wants to connect with you.",
        ),
    })

    # 8) Unknown sender, invoice-ish PDF, no other evidence -> Review (recall-preserving).
    samples.append({
        "name": "unknown_vendor_pdf",
        "expected": "Review",
        "raw": _build(
            sender="Vendor <accounts@smallvendor.co>",
            subject="document",
            body="Please see attached.",
            attachments=[("invoice.pdf", "application/pdf", _PDF_BYTES)],
        ),
    })

    return samples


def encrypted_pdf_sample() -> bytes:
    """A password-protected PDF from an UNKNOWN sender -> Review (unreadable, weak evidence).

    (A trusted-vendor encrypted invoice would legitimately be Invoice — the central mailbox
    is the future OCR/decryption stage. This weak-evidence case is the one that needs the
    Review safety net.)
    """
    return _build(
        sender="Billing <billing@unknownutility.co>",
        subject="Your bill",
        body="Your bill is attached (password protected).",
        attachments=[("bill.pdf", "application/pdf", _ENCRYPTED_PDF)],
    )
