"""Parse raw RFC822 email (bytes or str) into a normalized EmailDocument."""

from __future__ import annotations

import re
from email import message_from_bytes, message_from_string, policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import getaddresses, parseaddr

from core.email_document import Attachment, EmailDocument
from parsing.attachment_meta import build_attachment
from parsing.auth_parser import parse_auth_results

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t]+")
_CAL_METHOD_RE = re.compile(r"^\s*METHOD\s*:\s*(\w+)", re.IGNORECASE | re.MULTILINE)


def _decode(value: str | None) -> str:
    """Decode an RFC2047-encoded header value to plain text."""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:  # pragma: no cover - defensive against malformed headers
        return value


def _strip_html(html: str) -> str:
    text = _TAG_RE.sub(" ", html)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )
    return _WS_RE.sub(" ", text)


def parse_email(raw: bytes | str) -> EmailDocument:
    """Parse ``raw`` RFC822 content into an :class:`EmailDocument`."""
    if isinstance(raw, str):
        msg: EmailMessage = message_from_string(raw, policy=policy.default)  # type: ignore[assignment]
    else:
        msg = message_from_bytes(raw, policy=policy.default)  # type: ignore[assignment]

    from_name, from_addr = parseaddr(_decode(msg.get("From")))
    _, reply_to = parseaddr(_decode(msg.get("Reply-To"))) if msg.get("Reply-To") else ("", "")
    to_addrs = tuple(addr for _, addr in getaddresses([_decode(msg.get("To", ""))]) if addr)

    references = tuple(r for r in re.split(r"\s+", (msg.get("References") or "").strip()) if r)

    headers = {k: _decode(v) for k, v in msg.items()}

    body_parts: list[str] = []
    attachments: list[Attachment] = []
    calendar_method = ""

    for part in msg.walk():
        if part.is_multipart():
            continue
        content_type = (part.get_content_type() or "").lower()
        disposition = (part.get_content_disposition() or "")
        filename = _decode(part.get_filename())

        # Calendar parts are inspected for the meeting METHOD even when sent as an
        # attachment (e.g. invite.ics) — they are a strong meeting-invite signal, not an
        # invoice document, so they are never treated as an attachment.
        if content_type == "text/calendar":
            match = _CAL_METHOD_RE.search(_get_text(part))
            if match:
                calendar_method = match.group(1).upper()
            continue

        # Attachment: explicit attachment disposition, or any part carrying a filename.
        if disposition == "attachment" or (filename and disposition != "inline"):
            payload = part.get_payload(decode=True) or b""
            attachments.append(build_attachment(filename, content_type, payload))
            continue

        if content_type == "text/plain":
            body_parts.append(_get_text(part))
        elif content_type == "text/html":
            body_parts.append(_strip_html(_get_text(part)))

    if calendar_method:
        # Normalized marker used by the negative detector to recognize meeting invites.
        headers["X-Gateway-Calendar-Method"] = calendar_method

    body_text = "\n".join(p for p in body_parts if p).strip()

    return EmailDocument(
        message_id=(msg.get("Message-ID") or "").strip(),
        from_addr=from_addr,
        from_name=from_name,
        reply_to=reply_to,
        to_addrs=to_addrs,
        subject=_decode(msg.get("Subject")),
        date=(msg.get("Date") or "").strip(),
        headers=headers,
        body_text=body_text,
        attachments=tuple(attachments),
        auth=parse_auth_results(msg.get("Authentication-Results", "")),
        in_reply_to=(msg.get("In-Reply-To") or "").strip(),
        references=references,
        raw_size=len(raw) if isinstance(raw, (bytes, bytearray)) else len(raw.encode("utf-8", "ignore")),
    )


def _get_text(part) -> str:
    """Best-effort decode of a text part to str."""
    try:
        content = part.get_content()
        if isinstance(content, bytes):
            return content.decode("utf-8", "ignore")
        return str(content)
    except Exception:  # pragma: no cover - fall back to raw payload
        payload = part.get_payload(decode=True) or b""
        return payload.decode("utf-8", "ignore")
