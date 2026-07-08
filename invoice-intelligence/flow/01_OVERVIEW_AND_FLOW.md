# 01 — Overview & End-to-End Flow

## The complete flow (start → end)

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ 1. INTAKE (Google Workspace — already configured, no server code)           │
 │                                                                            │
 │   Vendor / employee emails an invoice to ANY company mailbox               │
 │        (e.g. accounts@, prajwal@, fida@ … or internal forwards)            │
 │                          │                                                 │
 │        Admin "content + attachment compliance" rule matches invoice        │
 │        signals (subject/body keywords, attachment file names)              │
 │                          │  adds a copy as an extra recipient              │
 │                          ▼                                                 │
 │              invoices@innovfix.in   (one central mailbox)                  │
 │              + "Processed" / "Invoice" / "Not-Invoice" Gmail labels        │
 └────────────────────────────────────────────────────────────────────────────┘
                             │  IMAP (App Password)
                             ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ 2. COLLECT   (python cli.py collect)                                        │
 │   • Reads only mail WITHOUT the "Processed" label (no re-reads, no misses   │
 │     even if a human opens the mailbox).                                     │
 │   • Saves each attachment (PDF/XML/JSON/JPG) — and the email BODY when      │
 │     there is no attachment — into a content-addressed blob store.          │
 │   • De-duplicates by content hash. Marks each message "Processed".          │
 └────────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ 3. PIPELINE  (python cli.py pipeline)  — deterministic, no paid AI          │
 │                                                                            │
 │   doctype    → digital-PDF vs scanned vs XML/JSON vs email-body            │
 │   extract    → PyMuPDF text  |  Tesseract OCR  |  XML/JSON parse           │
 │   fields     → GSTIN, invoice no, date, taxable, CGST/SGST/IGST, total,    │
 │                HSN, IRN  (regex + structured mapping)                       │
 │   validate   → GSTIN checksum, mandatory fields, dates, arithmetic recon.  │
 │   relevance  → "is this really an invoice?"  (junk → not_invoice)          │
 │   dedup      → IRN, else vendor_gstin+invoice_number                        │
 │   canonical  → one clean, versioned JSON record (+ full extracted text)    │
 │   store      → PostgreSQL (SQLite fallback for dev)                         │
 │                                                                            │
 │   Then labels each mailbox message Invoice / Not-Invoice by the OUTCOME.    │
 │   Incremental: only NEW documents are extracted; re-runs reuse the store.  │
 └────────────────────────────────────────────────────────────────────────────┘
                             │
             ┌───────────────┼─────────────────────────┐
             ▼               ▼                         ▼
     accepted          needs_review               not_invoice
   (clean, done)    (human verifies —          (newsletter / resume /
                     see Operations)            notification: ignore)
             │
             ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ 4. USE                                                                      │
 │   • CLI:  python cli.py search / show <id>                                  │
 │   • MCP:  ask Claude — "show today's invoices", "INV-778 details",          │
 │           "how many need review", "approve INV-123"                         │
 │   • Review: approve / reject / correct a field (human decisions are kept    │
 │     even when the pipeline re-runs).                                        │
 └────────────────────────────────────────────────────────────────────────────┘
```

## Design principles
- **Recall-first, precision-second.** The Workspace rule is deliberately broad so **no invoice is
  missed**; the pipeline is the precise filter that separates real invoices from the noise the
  broad rule inevitably forwards.
- **No silent miss.** A document that can't be read (failed OCR, encrypted) goes to `needs_review`,
  never to the junk bin. Nothing is deleted — `not_invoice` records are still stored & searchable.
- **Deterministic & idempotent.** No paid AI. Content-addressed storage + business-key dedup mean
  every stage is safe to re-run.
- **Human-in-the-loop.** The system is confident about what it's sure of, and routes the rest to a
  small review queue — it never guesses a value into an "accepted" invoice.

## The statuses (what downstream switches on)
| Status | Meaning | Who acts |
|---|---|---|
| `accepted` | Complete, all checks pass | nobody — ready to use |
| `needs_review` | An invoice with a gap (missing/failed field) | a human verifies/corrects |
| `duplicate` | Same invoice already seen (by IRN or GSTIN+number) | nobody |
| `not_invoice` | Read cleanly, but no invoice signals (junk) | ignore |

## Component map (folders)
| Folder | Role |
|---|---|
| `mailreader/` | Read the mailbox (IMAP live / sample offline) + Gmail label lifecycle |
| `attachments/` | Download, classify, de-dupe, store attachments + email bodies |
| `storage/` | Content-addressed blob store + PostgreSQL/SQLite invoice store + search |
| `documents/` | The opaque `doc_id` interface OCR/extraction read through |
| `doctype/` | Digital vs scanned vs XML/JSON vs body detection |
| `extraction/` | PyMuPDF / Tesseract OCR / XML-JSON content extraction |
| `fields/` | Deterministic field extraction (regex + structured mapping) |
| `validation/` | Checks + GSTIN checksum + the invoice-relevance gate |
| `dedup/` | Duplicate detection ledger |
| `canonical/` | The final clean invoice record (JSON) |
| `pipeline/` | Orchestrates every stage end-to-end |
| `review/` | Human approve / reject / correct actions |
| `monitoring/` | Health checks + reconciliation (no-miss proof) |
| `mcp_server/` | Exposes everything to Claude via MCP (stdio or URL) |
| `cli.py` | The command-line entry point for every operation |
