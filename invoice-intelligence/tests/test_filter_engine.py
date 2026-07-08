"""End-to-end tests: raw email -> FilterEngine -> Decision, over the labeled samples."""

from core.decision import Category
from core.filter_engine import FilterEngine
from testing.samples import encrypted_pdf_sample, labeled_samples


def _engine() -> FilterEngine:
    return FilterEngine.from_config()


def test_engine_builds_all_detectors():
    engine = _engine()
    # 23 detectors enabled in config (ocr/llm disabled). All should be registered+built.
    assert len(engine.detectors) >= 20


def test_labeled_samples_classify_correctly():
    engine = _engine()
    failures = []
    for sample in labeled_samples():
        decision = engine.classify_raw(sample["raw"])
        if decision.category.value != sample["expected"]:
            failures.append(f"{sample['name']}: expected {sample['expected']}, got {decision.category.value}")
    assert not failures, "Misclassifications:\n" + "\n".join(failures)


def test_invoice_decision_is_explainable():
    engine = _engine()
    raw = next(s["raw"] for s in labeled_samples() if s["name"] == "amazon_tax_invoice")
    decision = engine.classify_raw(raw)
    assert decision.category is Category.INVOICE
    assert decision.route_action == "copy_to_central"
    assert decision.confidence >= 80
    # Explanation must cite concrete positive reasons.
    codes = {r.code for r in decision.reasons}
    assert "trusted_vendor" in codes
    assert any(c in codes for c in ("invoice_pdf_attachment", "invoice_filename"))


def test_case_b_routes_to_central_without_invoice_word_in_subject():
    engine = _engine()
    raw = next(s["raw"] for s in labeled_samples() if s["name"] == "aws_case_b_attachment_only")
    decision = engine.classify_raw(raw)
    assert decision.is_invoice
    assert decision.route_action == "copy_to_central"


def test_encrypted_pdf_goes_to_review():
    engine = _engine()
    decision = engine.classify_raw(encrypted_pdf_sample())
    assert decision.category is Category.REVIEW


def test_duplicate_is_flagged_after_first_is_processed():
    engine = _engine()
    raw = next(s["raw"] for s in labeled_samples() if s["name"] == "amazon_tax_invoice")

    first = engine.classify_raw(raw)
    assert first.is_invoice
    from parsing.mime_parser import parse_email
    engine.record_processed(parse_email(raw), is_invoice=True)

    second = engine.classify_raw(raw)
    # The duplicate negative + positive evidence -> Review (never silently re-copied).
    assert second.category is Category.REVIEW
    assert any(r.code == "duplicate" for r in second.reasons)


def test_vendor_history_recorded_for_invoice():
    engine = _engine()
    from parsing.mime_parser import parse_email
    raw = next(s["raw"] for s in labeled_samples() if s["name"] == "aws_case_b_attachment_only")
    doc = parse_email(raw)
    engine.record_processed(doc, is_invoice=True)
    assert engine.vendor_store.get("aws.amazon.com", 0) == 1
