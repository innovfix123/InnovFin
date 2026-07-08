# Content Extraction — Part 2, Milestone 2.3

Turns each typed document into text / structured content using the **approved, deterministic-first,
local** stack. No paid AI. Consumes only the `DocumentProvider`.

## Routing (by DocumentType)
| DocumentType | Method | Tool | Cost |
|---|---|---|---|
| `xml_invoice` | `xml` | stdlib XML parse | free/local |
| `json_einvoice` | `json` | stdlib JSON parse | free/local |
| `digital_pdf` | `pymupdf` | **PyMuPDF** text extraction | free/local |
| `scanned_pdf` | `ocr` | **Tesseract** (render pages → OCR) | free/local |
| `image_jpg/png/tiff` | `ocr` | **Tesseract** | free/local |
| `encrypted_pdf` / `archive_zip` / `unsupported` | `review` | — | manual review |

Routes are config-overridable in `config/extraction.yaml`.

## Output — `ExtractedContent`
`{ doc_id, filename, document_type, method, text, structured, confidence, needs_review, notes[] }`
- **structured** holds the parsed tree for XML/JSON e-invoices (fed directly to field mapping next
  milestone — no OCR, no AI).
- **needs_review** is set when a document is unreadable, unsupported, or OCR confidence is below
  the configured threshold — matching the "low-confidence → Manual Review" rule.

## OCR — `OCRProvider` interface
- **Default:** `TesseractOCRProvider` (local, deterministic, no recurring cost). Uses per-word
  confidence; below `ocr.min_confidence` → manual review.
- **Optional plugins (NOT integrated):** Claude Vision, Google Document AI, Azure Document
  Intelligence, AWS Textract, OpenAI Vision — added only with explicit approval + data governance.
- If the Tesseract **binary** is absent, the OCR path degrades gracefully to Manual Review with a
  clear note (it never crashes the pipeline).

## Prerequisite for the OCR path (one manual step)
Install the Tesseract binary (Windows: UB Mannheim installer) and ensure `tesseract` is on PATH.
Python libs (`pymupdf`, `pytesseract`, `pillow`) are already in `requirements.txt`. Structured and
digital-PDF extraction need **no** binary and work today.

## Commands
```
python cli.py collect     # 2.1 collect attachments
python cli.py doctype     # 2.2 detect document type
python cli.py extract     # 2.3 extract content per type (this milestone)
```

## Tests
`tests/test_extraction.py` — XML, JSON, bad-JSON→review, digital-PDF via PyMuPDF, OCR-unavailable→
review, encrypted/unsupported→review, unknown-OCR-provider raises, audit trail.
