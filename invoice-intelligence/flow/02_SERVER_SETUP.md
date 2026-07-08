# 02 — Server Setup (Linux or Windows)

Follow top to bottom. Everything is deterministic and offline-first, so you can verify each step.

## A. Prerequisites
| Need | Linux | Windows |
|---|---|---|
| **Python 3.11+** | `sudo apt install python3.11 python3-pip` | python.org installer (add to PATH) |
| **Tesseract OCR** (for scanned PDFs/images) | `sudo apt install tesseract-ocr` | UB-Mannheim installer → `C:\Program Files\Tesseract-OCR\` |
| **PostgreSQL 14+** (production DB) | `sudo apt install postgresql` | postgresql.org installer |

> SQLite works with zero setup as a fallback — good for a first test (see D).

## B. Install the app
```bash
cd invoice-intelligence         # the unzipped project folder
pip install -r requirements.txt
python -m pytest -q             # sanity: all tests should pass
```

## C. Database (PostgreSQL)
Create the database and note the connection string:
```bash
sudo -u postgres psql -c "CREATE DATABASE invoices;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'CHOOSE_A_PASSWORD';"
```
Then point the app at it — EITHER edit `config/storage.yaml`:
```yaml
backend: postgres
dsn: "postgresql://postgres:CHOOSE_A_PASSWORD@localhost:5432/invoices"
fallback_to_sqlite: false      # production: fail loudly if the DB is down
```
OR (preferred, keeps the secret out of the file) set an env var and leave the dsn as a placeholder:
```bash
export INVOICE_DB_DSN="postgresql://postgres:CHOOSE_A_PASSWORD@localhost:5432/invoices"
```
The schema is created automatically on first run.

## D. Quick offline test first (recommended — no credentials needed)
Verify the whole pipeline before touching live mail:
1. In `config/attachments.yaml` set `mail_reader.type: sample`.
2. (Optional) for a no-DB test, set `config/storage.yaml` → `backend: sqlite`.
3. Run:
```bash
python cli.py collect
python cli.py pipeline
python cli.py search
python cli.py show INV-DEMO-001
```
You should see the 3 bundled sample emails classified (accepted / needs_review / not_invoice).

## E. Go live — read the real mailbox
1. **IMAP + App Password** for `invoices@innovfix.in`:
   - In that Gmail: Settings → Forwarding and POP/IMAP → **Enable IMAP**.
   - Create a Google **App Password** (`myaccount.google.com/apppasswords`), copy the 16 chars.
   - Put it in an environment variable (NEVER in a file):
     ```bash
     export INVOICE_IMAP_PASSWORD="your16charcode"       # Linux/macOS
     setx  INVOICE_IMAP_PASSWORD "your16charcode"          # Windows (new shell after)
     ```
2. In `config/attachments.yaml` set `mail_reader.type: imap` (username is already
   `invoices@innovfix.in`). Remove the `limit: 25` line to process the full backlog, or keep it
   small for the first run.
3. Verify + run:
```bash
python cli.py health          # expect HEALTHY — checks config, DB, OCR, disk, and IMAP LOGIN
python cli.py collect         # reads new mail, marks it Processed
python cli.py pipeline        # classifies + stores + labels
python cli.py search --status accepted
```
> **`health` is your go-live preflight.** If the `mailbox` line is OK, the App Password + IMAP are
> working and you can collect. If it says `IMAP login FAILED`, recheck the App Password (16 chars,
> no spaces) and that IMAP is enabled on `invoices@`. If it says `not configured`, set the
> `INVOICE_IMAP_PASSWORD` env var.

## F. Config files (all under `config/`)
| File | What to set |
|---|---|
| `attachments.yaml` | `mail_reader.type` (sample/imap), mailbox, supported file types |
| `storage.yaml` | `backend` (postgres/sqlite), `dsn`, `fallback_to_sqlite` |
| `extraction.yaml` | Tesseract `binary_path` (Windows path; on Linux leave blank if `tesseract` is on PATH) |
| `validation.yaml` | mandatory fields, GSTIN/arithmetic tolerances, `relevance_min_score` |
| `dedup.yaml` | dedup ledger path |

## Notes
- The **Google Workspace routing rule is already configured** (see doc 05) — you do NOT set it up
  again on the server. The server only READS `invoices@innovfix.in`.
- Extraction/validation are pure functions — no network calls, no data leaves your server except
  the IMAP read of your own mailbox.
