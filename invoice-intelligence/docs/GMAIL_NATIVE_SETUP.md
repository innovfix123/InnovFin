# Gmail-Native Invoice Routing — Setup & Honest Limitations (Phase 1)

This phase routes **only invoice-related emails** from the two company Gmail mailboxes into
the central mailbox using **Gmail's own filters and forwarding** — with **no IMAP, no Gmail
API, no OAuth, no Google Cloud, no App Password, no SMTP, and no polling service**.

```
satyamsahu0877@gmail.com ┐
                         ├─(Gmail native filter: invoice? )─► forward ─► satyam@innovfix.in
sat211053@gmail.com      ┘        │
                                  └─(ambiguous?)─► label "Invoice/Review" (stays in source)
                          (everything else stays untouched in the source mailbox)
```

## How it works — two tiers

- **The Python Invoice Filter is the brain.** It does **not** touch your mail. Instead it
  *authors* the best-possible Gmail rules from `config/` and *validates* them
  (`cli.py gmail-eval`). Its `classify()` logic is untouched and stays ready to later connect
  to **IMAP / Gmail API / Microsoft Graph** — those become alternative executors of the same
  decision, with **no change to the filter logic**.
- **Gmail is the executor.** You import the generated filters once per account; Gmail then
  forwards invoice mail to central and labels ambiguous mail — by itself, forever, no code
  running.

Mapping of the filter's 3-way decision to native Gmail actions:

| Filter decision | Gmail-native action |
|-----------------|---------------------|
| **Invoice** | Forward to `satyam@innovfix.in` + apply label `Invoice/Auto` |
| **Review**  | Apply label `Invoice/Review` in the source mailbox (NOT forwarded) |
| **Not Invoice** | No rule matches — mail stays untouched |

## Setup (once per source account, ~3 minutes)

1. **Generate the filters file:**
   ```
   python cli.py gmail-export --out gmail_filters.xml
   ```
2. **Verify the forwarding address** (required — Gmail only forwards to verified addresses):
   In each source Gmail → **Settings → Forwarding and POP/IMAP → Add a forwarding address →**
   `satyam@innovfix.in`. Gmail emails a confirmation code to the central mailbox; open it and
   confirm. (Do **not** enable "forward all mail" — the filters do the selective forwarding.)
3. **Import the filters:** In each source Gmail → **Settings → Filters and Blocked Addresses
   → Import filters →** choose `gmail_filters.xml` → **Open file → Create filters**
   (tick "Also apply to matching conversations" if you want existing mail routed too).
4. Done. Repeat 2–3 for the second account. Invoices now flow to central automatically.

## What Gmail-native CAN detect (with zero code running)

- **Sender**: `from:` trusted vendor domains (Amazon, AWS, Adobe, PhonePe, Razorpay, …).
- **Subject**: `subject:` invoice keywords ("tax invoice", "gst invoice", "credit note", …).
- **Attachment name**: `filename:` (invoice / bill / receipt / gst / statement …) and
  `has:attachment` — this is what catches the *"email containing an invoice"* case where the
  subject is unrelated but the attachment is named `AWS_Invoice_2026.pdf`.
- **Body words**: plain text of the email (e.g. `"amount due"`, `gstin`, `"please find attached"`).
- **Negative guards**: `-from:(linkedin.com OR github.com …)` and `-subject:(newsletter OR
  meeting OR otp …)` to suppress false forwards.

## What Gmail-native CANNOT do (the unavoidable limitations)

These are **structural** — no configuration removes them. Stated plainly:

1. **It cannot read inside attachments.** Gmail matches the attachment *filename*, never the
   PDF/XML/ZIP *contents*. A GSTIN, amount or invoice number that exists only *inside* a PDF is
   invisible to native rules. Detection therefore relies on sender + subject + filename + body
   text.
2. **No scoring, no confidence, no true Review-before-forward.** Filters are boolean
   match/no-match. The full engine's weighted scoring, ≥2-independent-signal corroboration,
   duplicate detection and confidence % **do not run live** in native mode. Consequence,
   measured on our labeled set (`cli.py gmail-eval`): native **recall ≈ 100%** but
   **precision is lower** — e.g. an unknown sender attaching `invoice.pdf` gets **forwarded**
   by Gmail, whereas the Python engine would route it to **Review**.
3. **Forwarding is a forward, not a pristine copy**, and the destination must be verified once.
4. **Password-protected / scanned / image-only PDFs** can be routed by filename but never
   content-verified (Gmail can't open them either).
5. **No de-duplication.** A re-sent/forwarded invoice will be forwarded again.

## When a heavier transport becomes justified (and why not now)

If the business needs the **full precision** of the scoring engine (content-aware detection,
Review queue, dedup, confidence, audit), Gmail native is not enough — you would connect the
**already-built** Python filter to the mailboxes via **IMAP, Gmail API, or Microsoft Graph**.
That is a **future phase** and is deliberately **not implemented now**, exactly as required.
Because the filter is transport-agnostic, that upgrade changes only the *executor*, not the
detection logic.

## Verifying before you deploy

```
python cli.py gmail-eval      # precision/recall of the native rules on labeled samples
python cli.py gmail-export     # (re)generate gmail_filters.xml + print the exact queries
python -m pytest -q            # full unit test suite (filter + native rules)
```
