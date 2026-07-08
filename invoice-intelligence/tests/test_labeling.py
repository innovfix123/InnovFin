"""Tests for outcome-label mapping and the best-effort mailbox labelling helper."""

from mailreader.labeling import apply_outcome_labels, build_outcome_labels


# -- build_outcome_labels ----------------------------------------------------

def test_invoice_status_maps_to_invoice_label():
    m = build_outcome_labels([("imap:INBOX:1", "accepted")])
    assert m == {"imap:INBOX:1": ["Invoice"]}


def test_needs_review_gets_invoice_plus_needs_review_labels():
    m = build_outcome_labels([("imap:INBOX:1", "needs_review"), ("imap:INBOX:2", "duplicate")])
    assert m == {"imap:INBOX:1": ["Invoice", "Needs-Review"], "imap:INBOX:2": ["Invoice"]}


def test_pure_noise_maps_to_not_invoice():
    m = build_outcome_labels([("imap:INBOX:9", "not_invoice")])
    assert m == {"imap:INBOX:9": ["Not-Invoice"]}


def test_any_invoice_doc_makes_the_whole_message_invoice():
    # One message (same source_ref) yields a junk body + a real invoice attachment.
    m = build_outcome_labels([
        ("imap:INBOX:5", "not_invoice"),
        ("imap:INBOX:5", "accepted"),
    ])
    assert m == {"imap:INBOX:5": ["Invoice"]}


def test_message_with_a_review_doc_gets_needs_review_even_alongside_accepted():
    m = build_outcome_labels([
        ("imap:INBOX:6", "accepted"),
        ("imap:INBOX:6", "needs_review"),
    ])
    assert m == {"imap:INBOX:6": ["Invoice", "Needs-Review"]}


def test_entries_without_source_ref_are_ignored():
    assert build_outcome_labels([(None, "accepted"), ("", "not_invoice")]) == {}


# -- apply_outcome_labels (best effort over a reader + registry) -------------

class _Rec:
    def __init__(self, doc_id, status):
        self.doc_id, self.status = doc_id, status


class _RegRecord:
    def __init__(self, source_ref):
        self.source_ref = source_ref


class _Registry:
    def __init__(self, mapping):
        self._m = mapping

    def get(self, doc_id):
        return self._m.get(doc_id)


class _Reader:
    def __init__(self):
        self.applied = None

    def apply_labels(self, mapping):
        self.applied = mapping
        return sum(len(v) for v in mapping.values())


def test_apply_outcome_labels_resolves_doc_id_to_source_ref():
    reg = _Registry({"h1": _RegRecord("imap:INBOX:1"), "h2": _RegRecord("imap:INBOX:2")})
    reader = _Reader()
    records = [_Rec("h1", "needs_review"), _Rec("h2", "not_invoice")]
    mapping = apply_outcome_labels(reader, reg, records)
    assert mapping == {"imap:INBOX:1": ["Invoice", "Needs-Review"], "imap:INBOX:2": ["Not-Invoice"]}
    assert reader.applied == mapping


def test_apply_outcome_labels_noop_when_reader_cannot_label():
    reg = _Registry({"h1": _RegRecord("imap:INBOX:1")})

    class _Dumb:  # e.g. the offline sample reader: no apply_labels
        pass

    assert apply_outcome_labels(_Dumb(), reg, [_Rec("h1", "accepted")]) == {}
