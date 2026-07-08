"""Tests for the live IMAP MailReader adapter (offline, via a fake IMAP server)."""

import pytest

from mailreader import RawEmail, build_mail_reader
from mailreader.imap import ImapMailReader

_MSG1 = b"From: a@x.com\r\nSubject: Invoice 1\r\n\r\nbody1"
_MSG2 = b"From: b@x.com\r\nSubject: Invoice 2\r\n\r\nbody2"


def _su(uid) -> str:
    return uid.decode() if isinstance(uid, (bytes, bytearray)) else str(uid)


def _unquote(value) -> str:
    s = value.decode() if isinstance(value, (bytes, bytearray)) else str(value)
    return s.strip().strip('"')


class _FakeIMAP:
    """Minimal imaplib-compatible stand-in recording the UID calls the reader makes.

    The same instance is reused for both the read() and mark_processed() connections, so a test
    can inspect what got flagged/labelled even though mark_processed opens its own connection.
    Supports Gmail ``X-GM-RAW`` ``-label:`` search and ``+X-GM-LABELS`` store so label-mode is
    testable offline.
    """

    def __init__(self, messages, labels=None):
        self._messages = messages           # {b"1": bytes, b"2": bytes, ...}
        self._labels = {}                   # uid(str) -> set(labels), seeded from `labels`
        for uid, labs in (labels or {}).items():
            self._labels[_su(uid)] = set(labs)
        self.selected = None
        self.searched = None
        self.stored = []                    # (uid, command, value) tuples STORE'd
        self.closed = False
        self.logged_out = False

    def labels_of(self, uid) -> set:
        return self._labels.get(_su(uid), set())

    def select(self, mailbox):
        self.selected = mailbox
        return ("OK", [b"2"])

    def uid(self, command, *args):
        command = command.upper()
        if command == "SEARCH":
            self.searched = args[-1]
            if args and _su(args[0]).upper() == "X-GM-RAW":
                return ("OK", [b" ".join(self._gm_raw(args[-1]))])
            return ("OK", [b" ".join(self._messages.keys())])
        if command == "FETCH":
            return ("OK", [(b"%s (RFC822)" % args[0], self._messages[args[0]])])
        if command == "STORE":
            self.stored.append((args[0], args[1], args[2]))
            if _su(args[1]).upper() == "+X-GM-LABELS":
                self._labels.setdefault(_su(args[0]), set()).add(_unquote(args[2]))
            return ("OK", [b""])
        return ("NO", [b""])

    def _gm_raw(self, query) -> list:
        q = _su(query)
        if q.startswith("-label:"):
            label = _unquote(q[len("-label:"):])
            return [uid for uid in self._messages if label not in self.labels_of(uid)]
        return list(self._messages.keys())

    def close(self):
        self.closed = True

    def logout(self):
        self.logged_out = True


def _reader(messages, labels=None, **kw):
    fake = _FakeIMAP(messages, labels=labels)   # reused for read() and mark_processed()
    r = ImapMailReader(host="imap.test", username="u", password="p",
                       connection_factory=lambda: fake, **kw)
    return r, fake


def test_reads_all_messages_as_rawemail():
    r, fake = _reader({b"1": _MSG1, b"2": _MSG2})
    out = list(r.read())
    assert [e.raw for e in out] == [_MSG1, _MSG2]
    assert all(isinstance(e, RawEmail) for e in out)
    assert out[0].source_ref == "imap:INBOX:1"
    assert fake.selected == "INBOX"
    assert fake.closed and fake.logged_out


def test_empty_mailbox_yields_nothing():
    r, fake = _reader({})            # empty mailbox -> UID SEARCH returns nothing
    assert list(r.read()) == []
    assert fake.logged_out          # still cleans up the connection


def test_limit_takes_most_recent():
    r, _ = _reader({b"1": _MSG1, b"2": _MSG2}, limit=1)
    out = list(r.read())
    assert len(out) == 1 and out[0].raw == _MSG2


def test_read_does_NOT_mark_seen_inline():
    """mark-seen-after-success: read() must never flag \\Seen by itself (crash-safety)."""
    r, fake = _reader({b"1": _MSG1}, mark_seen=True)
    list(r.read())
    assert fake.stored == []          # nothing flagged during read


def test_mark_processed_flags_after_success():
    r, fake = _reader({b"1": _MSG1}, mark_seen=True)
    refs = [e.source_ref for e in r.read()]
    marked = r.mark_processed(refs)
    assert marked == 1
    assert fake.stored == [("1", "+FLAGS", "\\Seen")]


def test_mark_processed_is_noop_when_disabled():
    r, fake = _reader({b"1": _MSG1}, mark_seen=False)
    refs = [e.source_ref for e in r.read()]
    assert r.mark_processed(refs) == 0 and fake.stored == []


def test_crash_before_mark_processed_leaves_message_unread():
    """Simulate: read() succeeds, process crashes before mark_processed -> message NOT flagged,
    so the next UNSEEN run re-reads it (no silent miss)."""
    r, fake = _reader({b"1": _MSG1}, mark_seen=True)
    list(r.read())                    # read, then 'crash' (never call mark_processed)
    assert fake.stored == []          # message stays UNSEEN -> re-read next run


def test_search_criteria_passed_through():
    r, fake = _reader({b"1": _MSG1}, search="UNSEEN")
    list(r.read())
    assert fake.searched == "UNSEEN"


def test_custom_mailbox_in_source_ref():
    r, _ = _reader({b"1": _MSG1}, mailbox="Invoices")
    out = list(r.read())
    assert out[0].source_ref == "imap:Invoices:1"


# -- label mode (Gmail label lifecycle, no-miss on human-read) ---------------

def test_label_mode_reads_only_unprocessed_messages():
    # m1 already Processed, m2 not -> only m2 is read.
    r, fake = _reader({b"1": _MSG1, b"2": _MSG2}, labels={b"1": {"Processed"}},
                      mark_mode="label")
    out = list(r.read())
    assert [e.source_ref for e in out] == ["imap:INBOX:2"]
    assert "-label:Processed" in _su(fake.searched)


def test_label_mode_marks_with_processed_label_not_seen():
    r, fake = _reader({b"1": _MSG1}, mark_mode="label", mark_seen=True)
    refs = [e.source_ref for e in r.read()]
    assert r.mark_processed(refs) == 1
    assert fake.stored == [("1", "+X-GM-LABELS", "Processed")]
    assert "Processed" in fake.labels_of("1")


def test_label_mode_human_read_does_not_cause_miss():
    # Human opens the message (marks \Seen) but it is NOT yet Processed -> still re-read.
    r, fake = _reader({b"1": _MSG1}, labels={b"1": set()}, mark_mode="label")
    assert [e.source_ref for e in r.read()] == ["imap:INBOX:1"]


def test_apply_labels_tags_outcome():
    r, fake = _reader({b"1": _MSG1, b"2": _MSG2}, mark_mode="label")
    n = r.apply_labels({"imap:INBOX:1": "Invoice", "imap:INBOX:2": "Not-Invoice"})
    assert n == 2
    assert "Invoice" in fake.labels_of("1")
    assert "Not-Invoice" in fake.labels_of("2")


def test_apply_labels_is_noop_in_seen_mode():
    r, fake = _reader({b"1": _MSG1}, mark_mode="seen")
    assert r.apply_labels({"imap:INBOX:1": "Invoice"}) == 0
    assert fake.stored == []


def test_factory_builds_imap_from_config(monkeypatch):
    monkeypatch.setenv("INVOICE_IMAP_PASSWORD", "app-pw")
    reader = build_mail_reader({"mail_reader": {
        "type": "imap", "host": "imap.gmail.com", "username": "central@innovfix.in",
        "mailbox": "INBOX", "search": "UNSEEN",
    }})
    assert isinstance(reader, ImapMailReader)
    assert reader.password == "app-pw"
    assert reader.host == "imap.gmail.com"


def test_factory_errors_without_password(monkeypatch):
    monkeypatch.delenv("INVOICE_IMAP_PASSWORD", raising=False)
    with pytest.raises(ValueError, match="password"):
        build_mail_reader({"mail_reader": {"type": "imap", "host": "h", "username": "u"}})


def test_factory_errors_without_host():
    with pytest.raises(ValueError, match="host"):
        build_mail_reader({"mail_reader": {"type": "imap", "username": "u", "password": "p"}})
