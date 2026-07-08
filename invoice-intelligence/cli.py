"""Command-line entry point for the Invoice Email Gateway.

Grows one subcommand per module. Today it can validate and summarize configuration so
the project is runnable and verifiable at this milestone.

Usage:
    python cli.py config-check [--config-dir config]
"""

from __future__ import annotations

import argparse
import sys

from core.config import ConfigError, ConfigLoader
from core.registry import DetectorRegistry, registered_detectors


def _cmd_classify(args: argparse.Namespace) -> int:
    from core.explanation import render
    from core.filter_engine import FilterEngine
    from testing.samples import labeled_samples

    engine = FilterEngine.from_config(config_dir=args.config_dir)

    if args.file:
        with open(args.file, "rb") as fh:
            raw = fh.read()
        decision = engine.classify_raw(raw)
        print(render(decision, engine.config))
        return 0

    # --demo (default): classify the labeled samples and show a routing summary.
    correct = 0
    samples = labeled_samples()
    for sample in samples:
        decision = engine.classify_raw(sample["raw"])
        ok = decision.category.value == sample["expected"]
        correct += ok
        print(f"\n### {sample['name']}  (expected: {sample['expected']})  {'OK' if ok else 'MISMATCH'}")
        print(render(decision, engine.config))
    print(f"\n{'-' * 48}\nSummary: {correct}/{len(samples)} samples matched expected routing.")
    return 0 if correct == len(samples) else 2


def _cmd_config_check(args: argparse.Namespace) -> int:
    try:
        config = ConfigLoader.load(args.config_dir)
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 1

    doc_types = config.document_type_ids()
    detectors_cfg = config.detector_configs()
    enabled = [d for d in detectors_cfg if d.get("enabled")]
    registered = registered_detectors()
    built = DetectorRegistry.from_config(config).build()

    print("Invoice Email Gateway - configuration check")
    print("-" * 48)
    print(f"Config dir           : {config.config_dir}")
    print(f"Document types       : {len(doc_types)}  ({', '.join(doc_types)})")
    print(f"Routable to central  : {', '.join(config.routable_types())}")
    print(f"Thresholds           : t_low={config.t_low()}  t_high={config.t_high()}  "
          f"min_corroboration={config.min_corroboration()}")
    print(f"Detectors configured : {len(detectors_cfg)}  (enabled: {len(enabled)})")
    print(f"Detectors registered : {len(registered)}")
    print(f"Detectors built       : {len(built)}")
    print(f"Trusted vendors      : {len(config.trusted_vendors())}")

    # Mailbox + Vendor registries (constructing them validates them).
    reg = config.mailbox_registry()
    vreg = config.vendor_registry()
    print(f"Source mailboxes     : {len(reg.sources)}  (active: {len(reg.active_sources())})")
    print(f"Central mailboxes    : {len(reg.centrals)}  (active: {len(reg.active_centrals())})")
    print(f"Vendors (registry)   : {len(vreg.vendors)}  (active: {len(vreg.active_vendors())})")
    print("OK - configuration is valid.")
    return 0


def _cmd_mailbox_check(args: argparse.Namespace) -> int:
    try:
        config = ConfigLoader.load(args.config_dir)
        reg = config.mailbox_registry()
        vreg = config.vendor_registry()
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 1

    print("Mailbox Registry")
    print("-" * 60)
    print(f"Central mailboxes ({len(reg.centrals)}):")
    for c in reg.centrals:
        state = "active" if c.active else "inactive"
        rr = c.routing_rules
        plus = rr.plus_address or "-"
        print(f"  [{c.id}] {c.name} <{c.email}>  label={c.label!r}  ({state})")
        print(f"      match_from={rr.match_from}  plus_address={plus}")

    ordered = sorted(reg.sources, key=lambda m: (not m.active, -m.priority, m.id))
    print(f"\nSource mailboxes ({len(reg.sources)}):")
    for s in ordered:
        state = "active" if s.active else "inactive"
        target = reg.forward_target_for(s)
        target_email = target.email if target else "?"
        print(f"  [{s.id}] {s.name} <{s.email}>  dept={s.department or '-'}  "
              f"prio={s.priority}  ({state})")
        print(f"      -> {s.forward_target} <{target_email}>  labels={s.labels}  "
              f"rules={s.assigned_rules}")

    print(f"\nVendor Registry (foundation): {len(vreg.vendors)} vendors "
          f"({len(vreg.active_vendors())} active)")
    print("-" * 60)
    print("OK - mailbox & vendor registry valid.")
    return 0


def _cmd_gmail_export(args: argparse.Namespace) -> int:
    from gmail_native.filters_export import build_filters_xml
    from gmail_native.query_builder import build_invoice_query, build_review_query

    config = ConfigLoader.load(args.config_dir)
    xml = build_filters_xml(config)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(xml)

    gr = config.gmail_routing()
    print("Gmail-native filters generated (no IMAP / API / OAuth / SMTP).")
    print("-" * 60)
    print(f"Written to      : {args.out}")
    print(f"Forward target  : {gr.get('forward_to')}")
    print(f"Source accounts : {', '.join(gr.get('source_accounts', []))}")
    print("\nINVOICE query (forwarded to central):\n  " + build_invoice_query(config))
    print("\nREVIEW query (labelled, not forwarded):\n  " + build_review_query(config))
    print("\nSetup (once per source account):")
    print("  1) Settings > Forwarding and POP/IMAP > add & VERIFY " + str(gr.get("forward_to")))
    print("  2) Settings > Filters and Blocked Addresses > Import filters > choose "
          + args.out)
    print("  3) Apply. Gmail now forwards only invoice mail to central; review mail is labelled.")
    return 0


def _cmd_gmail_eval(args: argparse.Namespace) -> int:
    from gmail_native.query_builder import build_invoice_query, build_review_query
    from gmail_native.query_sim import query_matches
    from parsing.mime_parser import parse_email
    from testing.samples import labeled_samples

    config = ConfigLoader.load(args.config_dir)
    invoice_q = build_invoice_query(config)
    review_q = build_review_query(config)

    tp = fp = fn = tn = 0
    rows = []
    for sample in labeled_samples():
        doc = parse_email(sample["raw"])
        forwarded = query_matches(invoice_q, doc)
        labelled_review = (not forwarded) and query_matches(review_q, doc)
        should_reach_central = sample["expected"] == "Invoice"
        if forwarded and should_reach_central:
            tp += 1
        elif forwarded and not should_reach_central:
            fp += 1
        elif not forwarded and should_reach_central:
            fn += 1
        else:
            tn += 1
        native = "FORWARD" if forwarded else ("review" if labelled_review else "leave")
        rows.append((sample["name"], sample["expected"], native))

    print("Gmail-native rule evaluation on labeled samples")
    print("-" * 60)
    for name, expected, native in rows:
        print(f"  {name:<30} expected={expected:<12} native={native}")
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    print("-" * 60)
    print(f"Invoice forwarding -> TP={tp} FP={fp} FN={fn} TN={tn}")
    print(f"Precision={precision:.0%}  Recall={recall:.0%}")
    print("NOTE: native rules are a boolean approximation; the full Python filter (Review "
          "tier, scoring, dedup) is coarser here by design - see docs/GMAIL_NATIVE_SETUP.md")
    return 0


def _cmd_gmail_build(args: argparse.Namespace) -> int:
    import os

    from gmail_native.filters_export import build_central_filter_xml, build_source_filters_xml
    from gmail_native.query_engine import generate_queries

    try:
        config = ConfigLoader.load(args.config_dir)
        labels = config.label_registry()
        reg = config.mailbox_registry()
        queries, warnings = generate_queries(config)
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 1

    print("Recall-first Gmail queries (engine)")
    print("=" * 72)
    for gq in queries:
        role = "FORWARD" if gq.forwards else "label "
        print(f"\n[{gq.tier:<7}] {gq.name}   ({role})")
        print(f"   version={gq.full_version}  length={gq.length}  label={labels.resolve(gq.label_key)!r}")
        print(f"   {gq.query}")

    if warnings:
        print("\nLENGTH-GUARD WARNINGS:")
        for w in warnings:
            print(f"  ! {w}")
    else:
        print("\nLength guard: OK (all queries within the configured limit).")

    os.makedirs(args.outdir, exist_ok=True)
    written: list[str] = []
    for s in reg.active_sources():
        central = reg.forward_target_for(s)
        xml = build_source_filters_xml(config, s, central, labels, queries)
        path = os.path.join(args.outdir, f"gmail_filters_{s.id}.xml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(xml)
        written.append(path)
    for c in reg.active_centrals():
        xml = build_central_filter_xml(config, c, labels)
        path = os.path.join(args.outdir, f"gmail_filters_central_{c.id}.xml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(xml)
        written.append(path)

    print(f"\nWrote {len(written)} filter file(s) to {args.outdir}/:")
    for p in written:
        print(f"  {p}")
    return 0


def _cmd_recall_check(args: argparse.Namespace) -> int:
    from gmail_native.query_engine import build_forward_query, build_tier_queries
    from gmail_native.query_sim import query_matches
    from metrics.models import EvaluationMetrics
    from parsing.mime_parser import parse_email
    from testing.samples import labeled_samples

    config = ConfigLoader.load(args.config_dir)
    forward_q = build_forward_query(config)
    tiers = build_tier_queries(config)

    m = EvaluationMetrics()
    print("Recall-first forward analysis (single broad forward query)")
    print("=" * 72)
    for s in labeled_samples():
        doc = parse_email(s["raw"])
        forwarded = query_matches(forward_q, doc)
        matched = [t["id"] for t, expr in tiers if expr and query_matches(expr, doc)]
        exp = s["expected"]
        if exp == "Invoice":
            if forwarded:
                m.true_positives += 1
            else:
                m.false_negatives += 1
                m.false_negative_names.append(s["name"])
        elif exp == "Not Invoice":
            if forwarded:
                m.false_positives += 1
                m.false_positive_names.append(s["name"])
            else:
                m.true_negatives += 1
        # "Review" samples: forwarding is acceptable under recall-first (not scored FP/FN).
        flag = "FORWARD" if forwarded else "leave"
        print(f"  {s['name']:<28} expected={exp:<12} -> {flag:<8} tiers={matched}")

    print("-" * 72)
    print(f"TP={m.true_positives}  FN={m.false_negatives}  FP={m.false_positives}  TN={m.true_negatives}")
    print(f"Recall    = {m.recall:.0%}   (real invoices forwarded / real invoices)")
    print(f"Precision = {m.precision:.0%}   (real invoices / forwarded invoice-class)")
    print(f"Zero silent misses: {'YES' if m.zero_silent_misses else 'NO'}")
    if m.false_negative_names:
        print("FALSE NEGATIVES (CRITICAL — a real invoice was NOT forwarded):")
        for n in m.false_negative_names:
            print(f"  - {n}")
    else:
        print("False negatives: NONE — no real invoice was missed.")
    return 0 if m.zero_silent_misses else 2


def _cmd_collect(args: argparse.Namespace) -> int:
    import os

    import yaml

    from attachments.collector import AttachmentCollector
    from mailreader import build_mail_reader

    cfg_path = os.path.join(args.config_dir, "attachments.yaml")
    if not os.path.exists(cfg_path):
        print(f"CONFIG ERROR: missing {cfg_path}", file=sys.stderr)
        return 1
    with open(cfg_path, encoding="utf-8") as fh:
        settings = yaml.safe_load(fh) or {}
    if args.source:
        settings.setdefault("mail_reader", {})["type"] = "sample"
        settings["mail_reader"]["sample_dir"] = args.source

    reader = build_mail_reader(settings)
    collector = AttachmentCollector.from_config(settings)
    try:
        result = collector.collect(reader)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Attachment Collector (Part 2 - Milestone 2.1)")
    print("-" * 60)
    print(f"Messages seen    : {result.messages_seen}")
    print(f"Collected        : {len(result.collected)}  {result.by_type}")
    print(f"Duplicates       : {result.duplicates}   (already in registry index)")
    print(f"Unsupported      : {result.unsupported}   Oversized: {result.oversized}")
    print(f"Storage          : {(settings.get('storage', {}) or {}).get('root')}")
    for a in result.collected[:20]:
        enc = " [encrypted]" if a.is_encrypted else ""
        print(f"  {a.attachment_type.value:<8} {a.filename:<30} {a.size:>7}B  {a.sha256[:12]}{enc}")
    print("OK - collection complete.")
    return 0


def _cmd_doctype(args: argparse.Namespace) -> int:
    import os

    import yaml

    from attachments.registry import AttachmentRegistry
    from doctype import DocumentTypeEngine
    from documents import RegistryDocumentProvider
    from storage.blob_store import FilesystemBlobStore

    att_path = os.path.join(args.config_dir, "attachments.yaml")
    dt_path = os.path.join(args.config_dir, "doctype_detection.yaml")
    for p in (att_path, dt_path):
        if not os.path.exists(p):
            print(f"CONFIG ERROR: missing {p}", file=sys.stderr)
            return 1
    with open(att_path, encoding="utf-8") as fh:
        att = yaml.safe_load(fh) or {}
    with open(dt_path, encoding="utf-8") as fh:
        dt = yaml.safe_load(fh) or {}

    registry = AttachmentRegistry((att.get("registry", {}) or {}).get("index_path"))
    store = FilesystemBlobStore((att.get("storage", {}) or {}).get("root", "build/attachments"))
    provider = RegistryDocumentProvider(registry, store)

    try:
        engine = DocumentTypeEngine.from_config(dt)
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 1

    results = engine.detect_all(provider)
    print("Document Type Detection (Part 2 - Milestone 2.2)")
    print("-" * 60)
    if not results:
        print("No collected documents found. Run 'python cli.py collect' first.")
        return 0
    for r in results:
        print(f"\n{r.filename}  ->  {r.document_type.value}  ({r.confidence:.0%}, via {r.deciding_detector})")
        for reason in r.reasons:
            print(f"   - {reason}")
    print("\nOK - typing complete.")
    return 0


def _cmd_extract(args: argparse.Namespace) -> int:
    import os

    import yaml

    from attachments.registry import AttachmentRegistry
    from doctype import DocumentTypeEngine
    from documents import RegistryDocumentProvider
    from extraction import ExtractionEngine
    from storage.blob_store import FilesystemBlobStore

    paths = {n: os.path.join(args.config_dir, f"{n}.yaml")
             for n in ("attachments", "doctype_detection", "extraction")}
    for p in paths.values():
        if not os.path.exists(p):
            print(f"CONFIG ERROR: missing {p}", file=sys.stderr)
            return 1
    cfgs = {}
    for n, p in paths.items():
        with open(p, encoding="utf-8") as fh:
            cfgs[n] = yaml.safe_load(fh) or {}

    att = cfgs["attachments"]
    registry = AttachmentRegistry((att.get("registry", {}) or {}).get("index_path"))
    store = FilesystemBlobStore((att.get("storage", {}) or {}).get("root", "build/attachments"))
    provider = RegistryDocumentProvider(registry, store)

    try:
        typer = DocumentTypeEngine.from_config(cfgs["doctype_detection"])
        extractor = ExtractionEngine.from_config(cfgs["extraction"])
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 1

    print("Content Extraction (Part 2 - Milestone 2.3)")
    print("-" * 60)
    refs = provider.list_documents()
    if not refs:
        print("No collected documents. Run 'python cli.py collect' first.")
        return 0
    review = 0
    for ref in refs:
        dtype = typer.detect(provider, ref).document_type
        r = extractor.extract(provider, ref, dtype)
        review += r.needs_review
        flag = "REVIEW" if r.needs_review else "OK"
        preview = " ".join(r.text.split())[:80]
        print(f"\n{r.filename}  [{dtype.value} -> {r.method}]  {flag}  conf={r.confidence:.0%}")
        if preview:
            print(f"   text: {preview}...")
        for note in r.notes:
            print(f"   - {note}")
    print(f"\n{len(refs)} document(s); {review} routed to manual review.")
    return 0


def _load_pipeline_provider(config_dir: str):
    """Shared setup for the full pipeline: load configs + build the DocumentProvider."""
    import os

    import yaml

    from attachments.registry import AttachmentRegistry
    from documents import RegistryDocumentProvider
    from storage.blob_store import FilesystemBlobStore

    names = ("attachments", "doctype_detection", "extraction",
             "field_patterns", "validation", "dedup", "storage")
    cfgs = {}
    for n in names:
        p = os.path.join(config_dir, f"{n}.yaml")
        if not os.path.exists(p):
            # Optional configs fall back to built-in defaults; only attachments is required.
            if n == "attachments":
                print(f"CONFIG ERROR: missing {p}", file=sys.stderr)
                return None, None, None
            cfgs[n] = {}
            continue
        with open(p, encoding="utf-8") as fh:
            cfgs[n] = yaml.safe_load(fh) or {}

    att = cfgs["attachments"]
    registry = AttachmentRegistry((att.get("registry", {}) or {}).get("index_path"))
    blobs = FilesystemBlobStore((att.get("storage", {}) or {}).get("root", "build/attachments"))
    provider = RegistryDocumentProvider(registry, blobs)
    return cfgs, provider, cfgs["storage"]


def _cmd_pipeline(args: argparse.Namespace) -> int:
    from pipeline import build_pipeline
    from storage.invoice_store import build_invoice_store

    loaded = _load_pipeline_provider(args.config_dir)
    if loaded[0] is None:
        return 1
    cfgs, provider, storage_cfg = loaded

    store = build_invoice_store(storage_cfg)
    try:
        pipeline = build_pipeline(cfgs, store=store)
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 1

    print("Invoice Pipeline (Part 2 - full deterministic flow)")
    print("-" * 60)
    refs = provider.list_documents()
    if not refs:
        print("No collected documents. Run 'python cli.py collect' first.")
        store.close()
        return 0

    records, summary = pipeline.run(provider, reprocess=getattr(args, "reprocess", False))
    for rec in records:
        f = rec.fields
        tag = {"accepted": "OK", "needs_review": "REVIEW", "duplicate": "DUP",
               "not_invoice": "NOT-INVOICE"}.get(rec.status, rec.status.upper())
        print(f"\n{rec.source['filename']}  [{rec.source['document_type']}]  {tag}")
        print(f"   vendor={f.get('vendor_name') or '?'}  gstin={f.get('vendor_gstin') or '?'}  "
              f"no={f.get('invoice_number') or '?'}  date={f.get('invoice_date') or '?'}  "
              f"total={f.get('total') if f.get('total') is not None else '?'}")
        for err in rec.validation.get("errors", []):
            print(f"   ! {err}")
        if rec.status == "duplicate":
            print(f"   -> duplicate of {rec.canonical_id}")
    print(f"\n{summary.total} document(s): {summary.accepted} accepted, "
          f"{summary.needs_review} need review, {summary.duplicate} duplicate, "
          f"{summary.not_invoice} not-invoice.")
    print(f"({summary.processed} newly processed, {summary.skipped} reused from store)")
    print(f"Stored in {storage_cfg.get('backend', 'sqlite')} backend.")

    # Best-effort: tag each processed message Invoice / Not-Invoice in the mailbox (live IMAP
    # only; a no-op for the offline sample reader). Never let labelling failures affect stored data.
    try:
        from mailreader import build_mail_reader
        from mailreader.labeling import apply_outcome_labels
        reader = build_mail_reader(cfgs["attachments"])
        labelled = apply_outcome_labels(reader, provider.registry, records)
        if labelled:
            print(f"Tagged {len(labelled)} mailbox message(s) with outcome labels.")
    except Exception as exc:  # noqa: BLE001 - labelling is advisory, must not fail the pipeline
        print(f"(outcome labelling skipped: {exc})", file=sys.stderr)

    store.close()
    return 0


def _cmd_search(args: argparse.Namespace) -> int:
    from storage.invoice_store import build_invoice_store
    from storage.search import SearchQuery

    loaded = _load_pipeline_provider(args.config_dir)
    if loaded[0] is None:
        return 1
    _, _, storage_cfg = loaded

    store = build_invoice_store(storage_cfg)
    query = SearchQuery(
        text=args.text, vendor_gstin=args.gstin, invoice_number=args.number,
        status=args.status, date_from=args.date_from, date_to=args.date_to,
        received_from=getattr(args, "received_from", None), received_to=getattr(args, "received_to", None),
        sender=getattr(args, "sender", None),
        min_total=args.min_total, max_total=args.max_total, limit=args.limit,
    )
    results = store.search(query)
    print("Invoice Search (Part 2 - Milestone 2.9)")
    print("-" * 60)
    if not results:
        print("No matching invoices.")
        store.close()
        return 0
    for rec in results:
        f = rec.get("fields", {})
        print(f"{rec['doc_id']:<16} {rec['status']:<12} "
              f"{f.get('vendor_name') or '?':<24} {f.get('invoice_number') or '?':<16} "
              f"{f.get('invoice_date') or '?':<12} {f.get('total') if f.get('total') is not None else '?'}")
    print(f"\n{len(results)} match(es).")
    store.close()
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    """Show ONE invoice in full — structured fields + the complete extracted text."""
    from storage.invoice_store import build_invoice_store
    from storage.search import SearchQuery

    loaded = _load_pipeline_provider(args.config_dir)
    if loaded[0] is None:
        return 1
    _, _, storage_cfg = loaded
    store = build_invoice_store(storage_cfg)

    rec = store.get(args.id)
    if rec is None:                       # not a doc_id? try invoice number
        hits = store.search(SearchQuery(invoice_number=args.id, limit=1))
        rec = hits[0] if hits else None
    if rec is None:
        print(f"No invoice found for {args.id!r} (try a doc_id or exact invoice number).")
        store.close()
        return 1

    f = rec.get("fields", {})
    src = rec.get("source", {})
    print("=" * 60)
    print(f"Invoice {f.get('invoice_number') or '?'}   [{rec.get('status')}]")
    print("=" * 60)
    print(f"From: {src.get('sender') or '?'}   Received: {src.get('received_date') or '?'}")
    print("STRUCTURED FIELDS:")
    for k in ("vendor_name", "vendor_gstin", "buyer_name", "buyer_gstin",
              "invoice_number", "invoice_date", "due_date",
              "taxable_value", "cgst", "sgst", "igst", "cess", "total", "hsn_sac", "irn"):
        if f.get(k) is not None:
            print(f"   {k:<16}: {f.get(k)}")
    for err in rec.get("validation", {}).get("errors", []):
        print(f"   ! {err}")
    print("-" * 60)
    print("FULL EXTRACTED TEXT (verbatim, plain):")
    print(rec.get("text") or "(no text captured)")
    print("=" * 60)
    store.close()
    return 0


def _resolve_and_load(store, ident: str):
    """Return the stored record dict for a doc_id or exact invoice number, else None."""
    from storage.search import SearchQuery
    rec = store.get(ident)
    if rec is None:
        hits = store.search(SearchQuery(invoice_number=ident, limit=1))
        rec = hits[0] if hits else None
    return rec


def _apply_review(args, action) -> int:
    """Shared plumbing for approve/reject/set: load -> transform -> persist -> print."""
    from canonical.models import CanonicalInvoice
    from storage.invoice_store import build_invoice_store

    loaded = _load_pipeline_provider(args.config_dir)
    if loaded[0] is None:
        return 1
    _, _, storage_cfg = loaded
    store = build_invoice_store(storage_cfg)

    rec = _resolve_and_load(store, args.id)
    if rec is None:
        print(f"No invoice found for {args.id!r}.")
        store.close()
        return 1
    updated = action(rec)
    store.upsert(CanonicalInvoice.from_dict(updated))
    num = (updated.get("fields") or {}).get("invoice_number") or updated["doc_id"][:12]
    print(f"{num}: status -> {updated['status']}  ({updated.get('review', {}).get('action')})")
    store.close()
    return 0


def _cmd_approve(args: argparse.Namespace) -> int:
    from review import approve
    return _apply_review(args, lambda rec: approve(rec, note=args.note or ""))


def _cmd_reject(args: argparse.Namespace) -> int:
    from review import reject
    return _apply_review(args, lambda rec: reject(rec, note=args.note or ""))


def _cmd_set(args: argparse.Namespace) -> int:
    from review import set_field
    return _apply_review(args, lambda rec: set_field(rec, args.field, args.value))


def _cmd_health(args: argparse.Namespace) -> int:
    from monitoring import check_health

    report = check_health(args.config_dir)
    print("Health Check (production readiness probe)")
    print("-" * 60)
    for c in report.checks:
        print(f"  [{'OK  ' if c.ok else 'FAIL'}] {c.name:<24} {c.detail}")
    print("-" * 60)
    print("HEALTHY" if report.healthy else "UNHEALTHY")
    return 0 if report.healthy else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cli.py", description="Invoice Email Gateway (Phase 1)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser("config-check", help="Validate and summarize configuration")
    p_check.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_check.set_defaults(func=_cmd_config_check)

    p_mbox = sub.add_parser("mailbox-check", help="Validate and summarize the Mailbox/Vendor Registry")
    p_mbox.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_mbox.set_defaults(func=_cmd_mailbox_check)

    p_classify = sub.add_parser("classify", help="Classify emails and show explainable decisions")
    p_classify.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_classify.add_argument("--file", help="Path to a raw .eml file to classify (default: built-in demo set)")
    p_classify.set_defaults(func=_cmd_classify)

    p_gexport = sub.add_parser("gmail-export", help="Generate importable Gmail filters (native routing)")
    p_gexport.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_gexport.add_argument("--out", default="gmail_filters.xml", help="Output XML path")
    p_gexport.set_defaults(func=_cmd_gmail_export)

    p_geval = sub.add_parser("gmail-eval", help="Measure the native rules against labeled samples")
    p_geval.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_geval.set_defaults(func=_cmd_gmail_eval)

    p_gbuild = sub.add_parser("gmail-build", help="Generate versioned recall-first queries + per-mailbox filter XML")
    p_gbuild.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_gbuild.add_argument("--outdir", default="build/filters", help="Directory for generated filter XML")
    p_gbuild.set_defaults(func=_cmd_gmail_build)

    p_recall = sub.add_parser("recall-check", help="Recall / false-negative analysis of the forward query")
    p_recall.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_recall.set_defaults(func=_cmd_recall_check)

    p_collect = sub.add_parser("collect", help="Part 2: collect + classify + store invoice attachments")
    p_collect.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_collect.add_argument("--source", help="Override: folder of .eml files to read (offline)")
    p_collect.set_defaults(func=_cmd_collect)

    p_doctype = sub.add_parser("doctype", help="Part 2: detect the document type of collected attachments")
    p_doctype.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_doctype.set_defaults(func=_cmd_doctype)

    p_extract = sub.add_parser("extract", help="Part 2: extract content (XML/JSON/PyMuPDF/OCR) per document type")
    p_extract.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_extract.set_defaults(func=_cmd_extract)

    p_health = sub.add_parser("health", help="Production health check (config, DB backend, OCR, disk)")
    p_health.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_health.set_defaults(func=_cmd_health)

    p_pipe = sub.add_parser("pipeline", help="Part 2: full flow (extract -> fields -> validate -> dedup -> canonical -> store)")
    p_pipe.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_pipe.add_argument("--reprocess", action="store_true",
                        help="Re-extract ALL documents (default: only new ones). Use after an extractor change.")
    p_pipe.set_defaults(func=_cmd_pipeline)

    p_search = sub.add_parser("search", help="Part 2: search stored canonical invoices")
    p_search.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_search.add_argument("--text", help="Free-text substring (vendor/buyer/number/GSTIN)")
    p_search.add_argument("--gstin", help="Exact vendor GSTIN")
    p_search.add_argument("--number", help="Exact invoice number")
    p_search.add_argument("--status", choices=["accepted", "needs_review", "duplicate", "not_invoice"],
                          help="Filter by status")
    p_search.add_argument("--date-from", dest="date_from", help="Invoice date >= (YYYY-MM-DD)")
    p_search.add_argument("--date-to", dest="date_to", help="Invoice date <= (YYYY-MM-DD)")
    p_search.add_argument("--received-from", dest="received_from", help="Received (arrived) date >= (YYYY-MM-DD)")
    p_search.add_argument("--received-to", dest="received_to", help="Received (arrived) date <= (YYYY-MM-DD)")
    p_search.add_argument("--sender", help="Sender (From) substring, e.g. a name or email")
    p_search.add_argument("--min-total", dest="min_total", type=float, help="Minimum total")
    p_search.add_argument("--max-total", dest="max_total", type=float, help="Maximum total")
    p_search.add_argument("--limit", type=int, help="Max results")
    p_search.set_defaults(func=_cmd_search)

    p_show = sub.add_parser("show", help="Part 2: show one invoice in full (fields + complete text)")
    p_show.add_argument("id", help="doc_id or exact invoice number")
    p_show.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_show.set_defaults(func=_cmd_show)

    p_approve = sub.add_parser("approve", help="Review: mark a needs_review invoice as accepted (verified)")
    p_approve.add_argument("id", help="doc_id or exact invoice number")
    p_approve.add_argument("--note", help="Optional reviewer note")
    p_approve.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_approve.set_defaults(func=_cmd_approve)

    p_reject = sub.add_parser("reject", help="Review: mark an invoice as not_invoice")
    p_reject.add_argument("id", help="doc_id or exact invoice number")
    p_reject.add_argument("--note", help="Optional reviewer note")
    p_reject.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_reject.set_defaults(func=_cmd_reject)

    p_set = sub.add_parser("set", help="Review: set/correct one field, then re-validate the invoice")
    p_set.add_argument("id", help="doc_id or exact invoice number")
    p_set.add_argument("field", help="Field name (e.g. total, invoice_date, vendor_gstin)")
    p_set.add_argument("value", help="New value")
    p_set.add_argument("--config-dir", default="config", help="Path to the config directory")
    p_set.set_defaults(func=_cmd_set)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
