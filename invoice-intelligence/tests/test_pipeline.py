"""End-to-end tests for the full deterministic invoice pipeline (Part 2)."""

import pytest

from doctype.models import DocumentType
from extraction.models import ExtractedContent
from pipeline import build_pipeline
from storage.invoice_store import SqliteInvoiceStore

_GOOD = {
    "Irn": "irn-abc-123",
    "DocDtls": {"No": "INV-2026-501", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": "27AABCU9603R1ZN", "LglNm": "Acme Supplies"},
    "BuyerDtls": {"Gstin": "29AAGCR1234M1Z4", "LglNm": "Innovfix"},
    "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800},
    "ItemList": [{"HsnCd": "998314"}],
}


class _FakeRef:
    def __init__(self, doc_id):
        self.doc_id = doc_id


class _FakeProvider:
    """Minimal DocumentProvider stand-in yielding pre-parsed JSON e-invoices."""

    def __init__(self, docs: dict[str, dict]):
        self._docs = docs

    def list_documents(self):
        return [_FakeRef(d) for d in self._docs]


class _StubTyper:
    def detect(self, provider, ref):
        from types import SimpleNamespace
        return SimpleNamespace(document_type=DocumentType.JSON_EINVOICE)


class _StubExtractor:
    def __init__(self, docs):
        self._docs = docs

    def extract(self, provider, ref, dtype):
        return ExtractedContent(ref.doc_id, f"{ref.doc_id}.json", dtype, "json", "",
                                self._docs[ref.doc_id], 1.0, False, ())


def _pipeline(docs, store=None):
    from canonical import CanonicalBuilder
    from dedup import InvoiceDeduper
    from fields import FieldExtractor
    from pipeline.engine import InvoicePipeline
    from validation import InvoiceValidator
    return InvoicePipeline(
        typer=_StubTyper(),
        extractor=_StubExtractor(docs),
        field_extractor=FieldExtractor(),
        validator=InvoiceValidator(),
        deduper=InvoiceDeduper(),
        builder=CanonicalBuilder(),
        store=store,
    )


def test_pipeline_accepts_good_invoice():
    docs = {"d1": _GOOD}
    records, summary = _pipeline(docs).run(_FakeProvider(docs))
    assert summary.total == 1 and summary.accepted == 1
    assert records[0].status == "accepted"
    assert records[0].fields["invoice_date"] == "2026-07-06"


def test_pipeline_flags_bad_gstin_for_review():
    bad = {**_GOOD, "Irn": "irn-bad", "SellerDtls": {"Gstin": "27AABCU9603R1ZZ", "LglNm": "X"}}
    docs = {"d1": bad}
    records, summary = _pipeline(docs).run(_FakeProvider(docs))
    assert summary.needs_review == 1
    assert records[0].status == "needs_review"


def test_pipeline_labels_readable_noise_as_not_invoice():
    # A cleanly-read document with no invoice fields (marketing/newsletter) must be separated
    # out as `not_invoice`, NOT dumped into the manual-review queue.
    docs = {"junk": {"Subject": "Weekly newsletter"}}   # no invoice fields extractable
    records, summary = _pipeline(docs).run(_FakeProvider(docs))
    assert records[0].status == "not_invoice"
    assert summary.not_invoice == 1 and summary.needs_review == 0
    assert records[0].relevance["is_invoice"] is False


def test_pipeline_is_incremental_by_default():
    # Second run over the same docs must REUSE stored records, not re-extract them.
    docs = {"d1": _GOOD}
    store = SqliteInvoiceStore(":memory:")
    pipe = _pipeline(docs, store=store)
    _, s1 = pipe.run(_FakeProvider(docs))
    assert s1.processed == 1 and s1.skipped == 0
    _, s2 = pipe.run(_FakeProvider(docs))              # nothing new
    assert s2.processed == 0 and s2.skipped == 1
    _, s3 = pipe.run(_FakeProvider(docs), reprocess=True)
    assert s3.processed == 1 and s3.skipped == 0        # forced rebuild
    store.close()


def test_pipeline_preserves_human_review_on_reprocess():
    # A manual review decision must survive a re-run of the pipeline over the same document.
    docs = {"d1": _GOOD}
    store = SqliteInvoiceStore(":memory:")
    _pipeline(docs, store=store).run(_FakeProvider(docs))
    # Human rejects it, then the scheduled pipeline runs again.
    from canonical.models import CanonicalInvoice
    from review import reject
    store.upsert(CanonicalInvoice.from_dict(reject(store.get("d1"), note="not ours")))
    _pipeline(docs, store=store).run(_FakeProvider(docs))
    assert store.get("d1")["status"] == "not_invoice"      # human decision preserved
    store.close()


def test_pipeline_dedupes_repeat_invoice():
    docs = {"d1": _GOOD, "d2": dict(_GOOD)}   # same IRN => d2 is a duplicate of d1
    records, summary = _pipeline(docs).run(_FakeProvider(docs))
    assert summary.total == 2
    assert summary.duplicate == 1
    dup = [r for r in records if r.status == "duplicate"][0]
    assert dup.canonical_id == "d1"


def test_pipeline_writes_to_store():
    docs = {"d1": _GOOD}
    store = SqliteInvoiceStore(":memory:")
    _pipeline(docs, store=store).run(_FakeProvider(docs))
    assert store.count() == 1
    assert store.get("d1")["fields"]["total"] == 11800.0
    store.close()


def test_build_pipeline_from_configs_smoke():
    # build_pipeline must assemble every stage from config dicts.
    pipe = build_pipeline({
        "doctype_detection": {"detectors": [{"name": "json_einvoice", "enabled": True}]},
        "validation": {"min_confidence": 0.5},
    })
    assert pipe.validator.min_confidence == 0.5
