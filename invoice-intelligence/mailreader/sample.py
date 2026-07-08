"""SampleFolderReader — the offline MailReader.

Reads ``*.eml`` files from a folder. No mailbox credentials, so the whole Part-2 pipeline can
be built and tested without touching a live mailbox. A live reader (IMAP / Gmail API) is a
later, separate adapter implementing the same :class:`~mailreader.base.MailReader` interface.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

from mailreader.base import RawEmail


class SampleFolderReader:
    def __init__(self, sample_dir: str | Path, pattern: str = "*.eml") -> None:
        self.sample_dir = Path(sample_dir)
        self.pattern = pattern

    def read(self) -> Iterator[RawEmail]:
        if not self.sample_dir.is_dir():
            raise FileNotFoundError(f"mail_reader sample_dir not found: {self.sample_dir}")
        for path in sorted(self.sample_dir.glob(self.pattern)):
            yield RawEmail(source_ref=path.name, raw=path.read_bytes())
