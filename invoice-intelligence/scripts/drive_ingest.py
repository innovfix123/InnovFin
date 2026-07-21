"""Ingest documents staged out of the finance Drive folder into the invoice registry.

    .venv/bin/python scripts/drive_ingest.py [--staging DIR] [--limit N] [--reprocess] [--dry-run]

Companion to `npm run drive:stage-invoices`, which downloads the documents and writes the manifest.
This side does two things and nothing else:

  1. Registers each staged file as a CollectedAttachment (bytes into the content-addressed blob
     store, record into the AttachmentRegistry) so it becomes visible to the SAME provider the
     mailbox flow uses. Everything downstream — extraction, dedup, the review UI, the MCP tools —
     then works unchanged, with no Drive-specific code path.

  2. Runs the pipeline over them with the TRUSTED-SOURCE relevance gate. These documents were filed
     by a human under a vendor inside "Purchases & Expenses Invoices", so they are invoices by
     provenance; scoring them again would let a badly-OCR'd GSTIN mark a real purchase invoice
     ``not_invoice``. Field extraction and validation are untouched, so anything unreadable still
     lands in ``needs_review`` for a person.

Provenance is preserved rather than faked: source_ref is the document's Drive path, the message id
is ``drive:<fileId>``, the sender is "Google Drive" and the date is the file's modifiedTime — so a
record's origin is obvious next to the mailbox-sourced ones.

Dedup is by content hash, so a document already collected from email is recognised as the same
document and does not double-count.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import yaml  # noqa: E402

from attachments.classifier import classify  # noqa: E402
from attachments.models import CollectedAttachment  # noqa: E402
from attachments.registry import AttachmentRegistry  # noqa: E402
from documents import FilteredDocumentProvider, RegistryDocumentProvider  # noqa: E402
from fields.drive_hints import DriveHintEnricher  # noqa: E402
from pipeline import build_pipeline  # noqa: E402
from storage.blob_store import FilesystemBlobStore  # noqa: E402
from storage.invoice_store import build_invoice_store  # noqa: E402
from validation import TrustedSourceRelevance, TrustedSourceValidator  # noqa: E402

CONFIG_NAMES = ("attachments", "doctype_detection", "extraction",
                "field_patterns", "validation", "dedup", "storage")


def load_configs(config_dir: str) -> dict:
    cfgs = {}
    for name in CONFIG_NAMES:
        path = os.path.join(config_dir, f"{name}.yaml")
        cfgs[name] = (yaml.safe_load(open(path, encoding="utf-8")) or {}) if os.path.exists(path) else {}
    return cfgs


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest Drive-staged invoices into the registry + pipeline.")
    ap.add_argument("--staging", default="build/drive-staging")
    ap.add_argument("--config-dir", default="config")
    ap.add_argument("--limit", type=int, default=0, help="ingest at most N documents (0 = all)")
    ap.add_argument("--reprocess", action="store_true", help="re-extract documents already stored")
    ap.add_argument("--dry-run", action="store_true", help="register nothing; just report what would be ingested")
    ap.add_argument("--review", action="store_true",
                    help="send imperfect documents to the review queue instead of accepting them "
                         "(default: accept — this archive was already reviewed by finance)")
    args = ap.parse_args()

    manifest_path = Path(args.staging) / "manifest.json"
    if not manifest_path.exists():
        print(f"No manifest at {manifest_path} — run `npm run drive:stage-invoices` first.", file=sys.stderr)
        return 1
    rows = json.loads(manifest_path.read_text(encoding="utf-8"))["files"]
    if args.limit:
        rows = rows[: args.limit]
    print(f"Manifest: {len(rows)} staged documents")

    cfgs = load_configs(args.config_dir)
    att = cfgs["attachments"]
    registry = AttachmentRegistry((att.get("registry", {}) or {}).get("index_path"))
    blobs = FilesystemBlobStore((att.get("storage", {}) or {}).get("root", "build/attachments"))

    registered = reused = failed = 0
    for row in rows:
        payload_path = Path(args.staging) / "files" / row["stagedFile"]
        if not payload_path.exists():
            failed += 1
            continue
        payload = payload_path.read_bytes()
        if args.dry_run:
            registered += 1
            continue
        digest, stored_path = blobs.put(payload)
        if registry.has(digest):
            reused += 1
            continue
        atype = classify(row["name"], row.get("mimeType", ""), payload)
        registry.add(CollectedAttachment(
            source_ref=row["drivePath"],
            source_message_id=f"drive:{row['driveId']}",
            filename=row["name"],
            mime_type=row.get("mimeType", ""),
            attachment_type=atype,
            sha256=digest,
            size=len(payload),
            is_encrypted=False,
            stored_path=stored_path,
            source_sender="Google Drive",
            source_date=row.get("modifiedTime", "") or "",
        ))
        registered += 1

    if args.dry_run:
        print(f"DRY RUN — would register {registered} documents ({failed} missing on disk)")
        return 0

    registry.save()
    print(f"Registered {registered} new, {reused} already known, {failed} missing on disk")

    store = build_invoice_store(cfgs["storage"])
    try:
        pipeline = build_pipeline(cfgs, store=store)
        # The behavioural differences from the mailbox run — all three because this source is a
        # curated, already-reviewed archive rather than an inbox.
        label = "Drive purchases & expenses invoices folder"
        pipeline.gate = TrustedSourceRelevance(label)
        pipeline.enricher = DriveHintEnricher()
        if not args.review:
            pipeline.validator = TrustedSourceValidator(pipeline.validator, label)
        # HARD SCOPE. The registry holds mailbox attachments too, and the three swaps above are
        # only correct for the curated Drive archive. Without this filter a --reprocess run applies
        # them to every email attachment as well: newsletters lose their `not_invoice` label and
        # mail that genuinely needs a human is force-accepted.
        provider = FilteredDocumentProvider(
            RegistryDocumentProvider(registry, blobs),
            lambda meta: (meta.source_message_id or "").startswith("drive:"),
        )
        _, summary = pipeline.run(provider, reprocess=args.reprocess)
    finally:
        close = getattr(store, "close", None)
        if callable(close):
            close()

    print("\nPIPELINE SUMMARY")
    print(f"  total        {summary.total}")
    print(f"  processed    {summary.processed}   (skipped as already stored: {summary.skipped})")
    print(f"  accepted     {summary.accepted}")
    print(f"  needs_review {summary.needs_review}")
    print(f"  duplicate    {summary.duplicate}")
    print(f"  not_invoice  {summary.not_invoice}   <- must stay 0 for trusted-source runs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
