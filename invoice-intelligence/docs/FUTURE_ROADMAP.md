# Future Roadmap

## Phase 1 hardening (optional, small — before or alongside production)
- **De-duplicate the forward-query terms** to reclaim length headroom (currently 1485/~1500).
  Overlapping tiers repeat subject/finance terms; the *forward* union doesn't need the overlap.
- **Retire the deprecated exporter** (`build_filters_xml`) and remove the legacy
  `gmail_routing.yaml` `forward_to`/`source_accounts` keys.
- **Workspace Admin deployment path:** for a Workspace org, a single Admin content-compliance /
  routing rule can deploy invoice→central forwarding to *all* mailboxes at once (no per-mailbox
  import, no per-user forwarding verification, auto-covers new employees). Per-mailbox XML stays the
  fallback for consumer accounts.

## Phase 2 — Invoice Intelligence (NOT started; requires explicit approval)
The central mailbox is the hand-off boundary. Phase 2 reads what Phase 1 collected and understands
it. Suggested milestone order (each: present → approve → build → test → stop):

1. **Attachment Collector** — read the central mailbox's `Invoices` label; extract + hash
   attachments; classify PDF / XML / image / ZIP. *(This is the first point that needs real mailbox
   access — Gmail API / IMAP / Workspace service account — lifting the Phase-1 "no API" constraint
   for the central mailbox only.)*
2. **Document typing** — digital-PDF vs scanned vs XML vs image; decode GST QR/IRN when present.
3. **Extraction** — structured-first (XML / QR / digital-PDF text); OCR or vision-LLM only for
   scanned/image. Provider behind an **OCR adapter** (Claude Vision / Azure / Google Doc AI / …).
4. **AI understanding** — normalize fields (vendor, invoice no., date, GSTIN, buyer, currency,
   totals, CGST/SGST/IGST, HSN/SAC, PO, due date) into a canonical schema. Provider behind an
   **AI adapter**.
5. **Validation** — GSTIN checksum, arithmetic reconciliation, date sanity; per-field confidence;
   low-confidence → human review.
6. **Duplicate detection** — attachment hash + (vendor GSTIN + invoice no. + date + total) + IRN.
7. **Normalization** — one standardized Invoice JSON with provenance + confidence per field.
8. **Storage & search** — PostgreSQL (append-only / versioned); search by vendor / invoice no. /
   GSTIN / date / amount.

**Explicitly out of scope entirely:** finance automation, payment gateways, settlement/commission,
GSTR-2B, vendor/bank reconciliation, ERP integration.

## Foundations already in place for Phase 2
- **Vendor Registry** (category / priority / finance_type / GSTIN fields) — ready for vendor-aware
  extraction.
- **Label Registry** (`Invoices`, `Invoices/Review`) — tells the collector what to pick up.
- **Metrics foundation** — extends from recall/precision to extraction accuracy.
- **Adapter-ready ingestion boundary** — swapping Gmail-native for a real mailbox reader changes
  only the executor, not the detection core.
