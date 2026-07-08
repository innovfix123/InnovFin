"""Mail Reader adapters.

A pluggable boundary between the invoice pipeline and the mailbox it reads from. The
collector depends only on the :class:`~mailreader.base.MailReader` interface, so a new email
provider (IMAP, Gmail API, Microsoft Graph) is added by writing one adapter and registering it
in :func:`~mailreader.factory.build_mail_reader` — with no change to the collector.
"""

from mailreader.base import MailReader, RawEmail
from mailreader.factory import build_mail_reader
from mailreader.imap import ImapMailReader
from mailreader.sample import SampleFolderReader

__all__ = ["MailReader", "RawEmail", "build_mail_reader", "ImapMailReader", "SampleFolderReader"]
