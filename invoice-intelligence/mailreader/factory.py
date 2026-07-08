"""Build a MailReader from configuration — the single place that knows adapter types."""

from __future__ import annotations

import os
from typing import Any

from mailreader.base import MailReader
from mailreader.sample import SampleFolderReader


def build_mail_reader(settings: dict[str, Any]) -> MailReader:
    """Construct the configured MailReader from the ``attachments.yaml`` settings."""
    mr = (settings or {}).get("mail_reader", {}) or {}
    kind = str(mr.get("type", "sample")).lower()
    if kind == "sample":
        return SampleFolderReader(mr.get("sample_dir", "sample_data/central_emails"))
    if kind == "imap":
        from mailreader.imap import ImapMailReader
        # App password is read from an env var by default so no secret lives in the config file.
        password = mr.get("password") or os.environ.get(
            mr.get("password_env", "INVOICE_IMAP_PASSWORD"), ""
        )
        if not mr.get("host") or not mr.get("username"):
            raise ValueError("imap mail_reader requires 'host' and 'username'")
        if not password:
            raise ValueError(
                "imap mail_reader has no password; set it in the "
                f"{mr.get('password_env', 'INVOICE_IMAP_PASSWORD')!r} environment variable"
            )
        return ImapMailReader(
            host=mr["host"], username=mr["username"], password=password,
            port=int(mr.get("port", 993)), use_ssl=bool(mr.get("use_ssl", True)),
            mailbox=mr.get("mailbox", "INBOX"), search=mr.get("search", "ALL"),
            limit=mr.get("limit"), mark_seen=bool(mr.get("mark_seen", False)),
            mark_mode=str(mr.get("mark_mode", "seen")),
            processed_label=str(mr.get("processed_label", "Processed")),
        )
    raise ValueError(f"unknown mail_reader type {kind!r} (available: sample, imap)")
