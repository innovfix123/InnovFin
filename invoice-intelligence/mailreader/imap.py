"""ImapMailReader — the live MailReader adapter (IMAP, the approved primary provider).

Reads raw RFC822 messages from a real mailbox (the central invoice mailbox) over IMAP and yields
them through the same :class:`MailReader` interface the offline SampleFolderReader uses — so the
Attachment Collector and the whole downstream pipeline are unchanged.

Design notes:
  * stdlib ``imaplib`` only (no new dependency); SSL by default (port 993).
  * The IMAP connection is injectable (``connection_factory``) so the adapter is fully unit-testable
    offline with a fake server — no network, no credentials in tests.
  * Credentials never live in code: the factory reads the app password from an environment variable.
  * **UID-based** commands (RFC 3501): UIDs are stable across sessions, so a message can be safely
    marked processed from a *separate* connection after it has been durably captured.
  * **mark-processed-after-success:** ``read()`` never marks a message inline. Messages are marked
    only when the caller calls :meth:`mark_processed` — AFTER their content is durably persisted.
    This closes the crash window where a message was flagged processed but not yet stored, which
    would have skipped it forever on the next run (a silent miss).

Processed-marker modes (``mark_mode``):
  * ``"seen"`` — flag ``\\Seen`` and read ``UNSEEN`` (simple, but a human opening the mailbox marks
    a message read and it would then be skipped — a miss risk on a monitored mailbox).
  * ``"label"`` — apply a Gmail label (default ``Processed``) and read only messages that do NOT
    yet carry it (Gmail ``X-GM-RAW`` search). Human reading no longer causes a miss, and the
    mailbox gains an audit trail of what the pipeline has handled. This is the production mode for
    the shared central mailbox. Outcome labels (``Invoice`` / ``Not-Invoice``) are applied
    separately by :meth:`apply_labels` after the pipeline classifies each message.
"""

from __future__ import annotations

from typing import Callable, Iterable, Iterator

from mailreader.base import RawEmail


class ImapMailReader:
    def __init__(
        self,
        host: str,
        username: str,
        password: str,
        port: int = 993,
        use_ssl: bool = True,
        mailbox: str = "INBOX",
        search: str = "ALL",
        limit: int | None = None,
        mark_seen: bool = False,
        mark_mode: str = "seen",
        processed_label: str = "Processed",
        include_processed: bool = False,
        connection_factory: Callable[[], object] | None = None,
    ) -> None:
        self.host = host
        self.username = username
        self.password = password
        self.port = int(port)
        self.use_ssl = bool(use_ssl)
        self.mailbox = mailbox
        self.search = search or "ALL"
        self.limit = limit
        self.mark_seen = bool(mark_seen)
        self.mark_mode = str(mark_mode or "seen").lower()
        self.processed_label = processed_label or "Processed"
        # Backfill/full-resync: when True, read the mailbox regardless of the Processed label AND
        # ignore the fetch limit (still marks Processed after capture). Off = normal incremental read.
        self.include_processed = bool(include_processed)
        self._connection_factory = connection_factory

    # -- connection ---------------------------------------------------------
    def _connect(self):
        if self._connection_factory is not None:
            return self._connection_factory()
        import imaplib
        conn = (imaplib.IMAP4_SSL(self.host, self.port) if self.use_ssl
                else imaplib.IMAP4(self.host, self.port))
        conn.login(self.username, self.password)
        return conn

    @staticmethod
    def _cleanup(conn) -> None:
        for method in ("close", "logout"):
            try:
                getattr(conn, method)()
            except Exception:
                pass

    def _uid_of(self, source_ref: str) -> str | None:
        prefix = f"imap:{self.mailbox}:"
        return source_ref[len(prefix):] if source_ref.startswith(prefix) else None

    def _search_criteria(self) -> tuple:
        """What to fetch. In label mode, only messages that do NOT yet carry the processed
        label (Gmail server-side search); otherwise the configured IMAP criterion."""
        if self.include_processed:
            return ("ALL",)                  # backfill: every message, regardless of label OR \Seen
        if self.mark_mode == "label":
            return ("X-GM-RAW", f'-label:{_gm_quote(self.processed_label)}')
        return (self.search,)

    # -- read (never marks the message) -------------------------------------
    def read(self) -> Iterator[RawEmail]:
        conn = self._connect()
        try:
            sel_typ, sel_data = conn.select(_qbox(self.mailbox))
            mailbox_total = _int_or(sel_data[0] if sel_data else None, -1) if sel_typ == "OK" else -1
            typ, data = conn.uid("SEARCH", *self._search_criteria())
            matched = data[0].split() if (typ == "OK" and data and data[0] not in (None, b"", "")) else []
            # Normal runs cap to the most-recent N; a backfill (include_processed) takes everything.
            uids = matched[-int(self.limit):] if (self.limit and not self.include_processed) else matched
            # Diagnostic (stderr → pm2/cron log): tells "read 0 messages" (empty/auth) apart from
            # "read N, none were invoices". messages_in_mailbox = ALL mail in the box (incl. already
            # Processed); matched_by_search = what this run is eligible to fetch, before the limit cap.
            _log_read(self.username, self.mailbox, self.mark_mode, mailbox_total, len(matched), len(uids))
            for uid in uids:
                typ, msg_data = conn.uid("FETCH", uid, "(RFC822)")
                if typ != "OK" or not msg_data or not msg_data[0]:
                    continue
                raw = msg_data[0][1]
                if not isinstance(raw, (bytes, bytearray)):
                    continue
                uid_s = uid.decode() if isinstance(uid, (bytes, bytearray)) else str(uid)
                # Nothing marked here — deferred to mark_processed() after durable capture.
                yield RawEmail(source_ref=f"imap:{self.mailbox}:{uid_s}", raw=bytes(raw))
        finally:
            self._cleanup(conn)

    # -- mark-processed-after-success --------------------------------------
    def mark_processed(self, source_refs: Iterable[str]) -> int:
        """Mark the given messages processed — call ONLY after their content is durably stored.

        In ``label`` mode this adds the Gmail ``Processed`` label; in ``seen`` mode it flags
        ``\\Seen``. Returns the number of messages marked. No-op when ``mark_seen`` is disabled.
        Uses UIDs (stable across sessions) on a fresh connection, so it is safe to run after
        ``read()`` has closed. Partial failures are harmless: unmarked messages are simply re-read
        next run and de-duplicated (at-least-once + idempotent = no miss, no duplicate).
        """
        if not self.mark_seen:
            return 0
        uids = [u for u in (self._uid_of(r) for r in source_refs) if u]
        if not uids:
            return 0
        command, value = (
            ("+X-GM-LABELS", _gm_quote(self.processed_label))
            if self.mark_mode == "label" else ("+FLAGS", "\\Seen")
        )
        conn = self._connect()
        marked = 0
        try:
            conn.select(_qbox(self.mailbox))
            for uid in uids:
                typ, _ = conn.uid("STORE", uid, command, value)
                if typ == "OK":
                    marked += 1
        finally:
            self._cleanup(conn)
        return marked

    # -- outcome labels (Invoice / Not-Invoice) -----------------------------
    def apply_labels(self, ref_to_labels: dict[str, str | list[str]]) -> int:
        """Apply Gmail label(s) to each message (``source_ref`` -> label name or list of names).

        Called after the pipeline classifies each message, to tag it ``Invoice`` / ``Needs-Review``
        / ``Not-Invoice`` in the mailbox so a human sees a clean, pipeline-driven view. Additive
        (``+X-GM-LABELS``), so it never removes existing labels; best-effort, so a labelling failure
        never affects the already-stored invoice data. No-op unless in ``label`` mode.
        """
        if self.mark_mode != "label" or not ref_to_labels:
            return 0
        pairs: list[tuple[str, str]] = []
        for ref, labels in ref_to_labels.items():
            uid = self._uid_of(ref)
            if not uid:
                continue
            if isinstance(labels, str):
                labels = [labels]
            for label in labels:
                if label:
                    pairs.append((uid, label))
        if not pairs:
            return 0
        conn = self._connect()
        labelled = 0
        try:
            conn.select(_qbox(self.mailbox))
            for uid, label in pairs:
                typ, _ = conn.uid("STORE", uid, "+X-GM-LABELS", _gm_quote(label))
                if typ == "OK":
                    labelled += 1
        finally:
            self._cleanup(conn)
        return labelled


def _gm_quote(label: str) -> str:
    """Quote a Gmail label/query token so multi-word labels (e.g. ``Not-Invoice``) are safe."""
    label = str(label)
    return f'"{label}"' if (" " in label or ":" in label) else label


def _qbox(mailbox: str) -> str:
    """Quote an IMAP mailbox name containing spaces (e.g. ``[Gmail]/All Mail``) for SELECT."""
    return f'"{mailbox}"' if " " in mailbox else mailbox


def _int_or(value, default: int) -> int:
    """Parse an IMAP numeric response (often bytes, e.g. b'12') to int, else the default."""
    try:
        return int(value.decode() if isinstance(value, (bytes, bytearray)) else value)
    except (TypeError, ValueError, AttributeError):
        return default


def _log_read(account: str, mailbox: str, mark_mode: str,
              mailbox_total: int, matched: int, fetching: int) -> None:
    """One stderr line per read(): what the mailbox actually returned, before invoice filtering.
    Lets ops distinguish an empty/wrong mailbox or silent auth-empty from 'read N, none matched'."""
    import sys
    print(
        f"[imap.read] account={account} mailbox={mailbox!r} mark_mode={mark_mode} "
        f"messages_in_mailbox={mailbox_total} matched_by_search={matched} fetching={fetching}",
        file=sys.stderr, flush=True,
    )
