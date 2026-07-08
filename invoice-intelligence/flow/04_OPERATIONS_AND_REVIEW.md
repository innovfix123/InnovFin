# 04 — Daily Operations & Review

## Where the invoices are
Three ways to see them — use whichever you like:

1. **Gmail labels** in `invoices@innovfix.in` (visual): click **`Invoice`** to see real invoices,
   and **`Needs-Review`** to see just the ones a human must verify. (`Processed` = the pipeline
   handled it; `Not-Invoice` = junk. A mail carries several labels, so it can appear under more than
   one — that is expected; a review invoice has both `Invoice` and `Needs-Review`.)
2. **CLI:**
   ```bash
   python cli.py search --status accepted          # clean, ready
   python cli.py search --status needs_review       # the human queue
   python cli.py search --status not_invoice        # junk (audit only)
   python cli.py search --gstin 27AABCU9603R1ZN      # by vendor GSTIN
   python cli.py search --number INV-778             # by number
   python cli.py search --sender vaibhav             # by who emailed it (From)
   python cli.py search --received-from 2026-07-07   # arrived on/after a date ("today's")
   python cli.py show INV-778                         # full detail (incl. From/Received) + text
   ```
3. **Claude (MCP):** "show today's invoices" (by arrival date), "invoices from Vaibhav",
   "how many need review", "INV-778 details", "Acme's invoices".

## What each captured invoice contains
vendor name & GSTIN, buyer GSTIN, invoice number, date, due date, currency, taxable value,
CGST / SGST / IGST / cess, total, HSN/SAC, IRN — plus the **full extracted text** of the document,
the validation result, and provenance (where each value came from).
> The original PDF always stays in the `invoices@` mailbox for an exact visual copy.

## The review workflow (the only manual work)
Only **needs_review** invoices need a human — usually a missing/failed field. Open one, check the
flagged reason and the full text (or the original PDF), then act:

```bash
python cli.py show CF/26-27/54529            # see what's flagged + full text
python cli.py approve CF/26-27/54529 --note "verified"   # -> accepted
python cli.py reject  <id> --note "not an invoice"       # -> not_invoice
python cli.py set     <id> total 885746.18               # fill/fix a field, auto re-validates
```
From Claude: "approve CF/26-27/54529", "reject <id>", "set INV-9 total to 5900".

**Human decisions are preserved** — the 5-minute re-run will never overwrite an approve/reject/edit.

## Status meanings (quick reference)
| Status | Action |
|---|---|
| `accepted` | none — it's clean and stored |
| `needs_review` | verify/correct the flagged field, then approve |
| `duplicate` | none — already captured under the first copy |
| `not_invoice` | ignore (kept for audit) |

## Health & integrity
```bash
python cli.py health          # config, DB backend (live), OCR, disk — expect HEALTHY
```
- The collector marks mail `Processed` only AFTER it is durably stored, so a crash never loses a
  message (it is simply re-read next run).
- Storage is content-addressed and dedup is business-keyed, so re-running is always safe.

## Tuning (optional)
- Too much junk reaching `needs_review`? Raise `relevance_min_score` in `config/validation.yaml`.
- A real invoice mis-parsed? Its fields are still captured; approve it, or add a pattern in
  `fields/extractor.py` and `python cli.py pipeline --reprocess`.
- Foreign-vendor invoices (non-Indian GSTIN) naturally land in `needs_review` — that is correct;
  approve them after a glance.
