# Document Type Detection — Part 2, Milestone 2.2

Classifies each collected attachment into a precise document type so later milestones can route
it (structured → parse directly; scanned/image → OCR). **No OCR/AI/extraction here.**

## Architecture
```
DocumentProvider (opaque doc_id -> bytes + metadata)
        │  (engine opens each doc ONCE via the provider — never a path/blob store)
        ▼
DocumentTypeEngine  ──►  runs configured detector plugins  ──►  collects DetectionSignals
        │                                                          (type, confidence, reason)
        ▼
   picks highest-confidence signal (ties: config order = priority)
        ▼
DocumentTypeResult {document_type, confidence, deciding_detector, reasons[], signals[]}
        │
        └──►  append-only audit line (build/audit/doctype.jsonl)
```

Key guarantees:
- **Storage-agnostic:** the engine consumes only `DocumentProvider`; detectors are pure functions
  of `(bytes, metadata, rules)`. Nothing here knows where bytes are stored.
- **Plugin architecture:** detectors live in a catalog and are enabled/ordered in
  `config/doctype_detection.yaml` — add one by registering it, no engine change.
- **Explainable:** every result carries the reasons from every detector that fired.
- **Auditable:** every decision is appended to a JSONL audit trail.
- **Config-driven:** thresholds, ambiguity default, e-invoice key hints and detector
  enable/order all come from YAML.

## Output types (`DocumentType`)
`DIGITAL_PDF` · `SCANNED_PDF` · `ENCRYPTED_PDF` · `XML_INVOICE` · `JSON_EINVOICE` ·
`IMAGE_JPG` · `IMAGE_PNG` · `IMAGE_TIFF` · `ARCHIVE_ZIP` · `UNSUPPORTED`.
Routing hints: `.is_structured` (XML/JSON → parse directly) and `.needs_ocr` (scanned/images).

## The detectors
| Detector | Recognizes | How | Confidence |
|---|---|---|---|
| `encrypted_pdf` | Password/permission-protected PDF | PDF with an `/Encrypt` dictionary (byte scan) or `is_encrypted` metadata | 1.0 |
| `pdf_layer` | Digital vs scanned PDF | Inflates content streams (zlib) and counts text-show operators (`BT`/`Tj`/`TJ`) + `/Font`; vs image markers (`/Subtype/Image`, `/DCTDecode`). Text ⇒ digital; image-only ⇒ scanned; neither ⇒ configurable `pdf_ambiguous_default` | 0.9 / 0.8 / 0.5 |
| `xml_invoice` | XML e-invoice | Content starts with `<?xml`/`<` | 0.95 |
| `json_einvoice` | GST JSON e-invoice | Content starts with `{`; confidence raised when GST keys (`Irn`, `SellerDtls`, …) are present | 0.98 / 0.7 |
| `image` | JPG / PNG / TIFF | Magic bytes (`FFD8FF` / `\x89PNG` / `II*\0`/`MM\0*`) | 1.0 |
| `archive` | ZIP | Magic bytes `PK` | 1.0 |
| *(none match)* | Unsupported | engine falls back to `UNSUPPORTED` | 1.0 |

The digital-vs-scanned heuristic is intentionally **pure Python** (no PDF library) and, per the
research, is heuristic — ambiguous PDFs fall back to the configured default and are always
explained. A future milestone can swap in a stronger PDF layer check behind the same detector.

## Commands
```
python cli.py collect      # Milestone 2.1 — collect attachments
python cli.py doctype      # Milestone 2.2 — type the collected documents (explainable output)
```

## Tests
`tests/test_doctype.py` — every required type (digital/scanned/encrypted PDF, XML, JSON e-invoice,
JPG/PNG/TIFF, ZIP, unsupported), explainability, audit trail, and config-driven plugin behavior
(unknown detector raises, disabling a detector changes the result).
