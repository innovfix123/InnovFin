# Live Gmail Validation Plan (pre-Milestone 3)

**Type:** production validation task — executed by a human against **real Gmail accounts**.
It is NOT code. Its purpose is to replace the assumptions flagged in Milestone 0 and 2 with
observed facts, especially the **central-mailbox "From" behaviour**, before we commit the
central routing logic.

References: [GMAIL_NATIVE_BEHAVIOUR.md](GMAIL_NATIVE_BEHAVIOUR.md) (documented limits).

## Test accounts & setup (one-time)
- **Source A**, **Source B** — company mailboxes (the registry `source_mailboxes`).
- **Central** — the single source of truth (`central_mailboxes[0]`).
- Generate filters: `python cli.py gmail-build` → `build/filters/`.
- In **each source account**: Settings → Forwarding → add & **verify** the central address,
  then Settings → Filters → **Import filters** → the matching `gmail_filters_<source>.xml`.
- In **Central**: import `gmail_filters_central_<id>.xml`.
- Prepare a small fixed test set: 5 real invoices (mixed vendors, PDF + XML + attachment-only),
  4 clear non-invoices (newsletter, OTP, meeting invite, LinkedIn), 1 ambiguous PDF.

Record every result in a table: *test id · input · expected · observed · pass/fail · notes*.

---

## V1 — Forwarding behaviour
**Verify** the broad forward filter forwards probable invoices to Central.
- Send each of the 5 invoices to Source A.
- **Pass:** all 5 arrive in Central; each has label `Invoices/Auto` in Source A.
- **Record:** any not forwarded (critical — a silent miss).

## V2 — Original-sender ("From") behaviour  ⭐ decides central routing
**Verify** what address a forwarded message shows in Central: the **original vendor** or the
**forwarding source account**.
- Inspect 5 forwarded messages in Central; note the visible `From`, the envelope sender, and
  any `X-Forwarded-For` / "via" indicator.
- **Record:** does `from:sat211053@gmail.com` match in Central? Does `from:<vendor>` match?
- **Outcome drives the decision** (kept configurable per approval): central filter should key on
  *forwarded sender* vs *original sender* vs *subject* vs other native criteria. **Do not change
  code until this is observed.**

## V3 — Label behaviour
**Verify** labels apply automatically and nested labels are created on import.
- **Pass:** `Invoices/Auto` (source) and `Invoices` (central) appear without manual action;
  `Invoices/Tier/*` labels appear on matching mail.
- **Record:** any label not auto-created; any label applied to the wrong message.

## V4 — Multiple matching filters
**Verify** that when a message matches the forward filter AND several P1–P7 label filters, all
actions apply and labels combine as expected.
- Use `amazon_tax_invoice` (matches P1–P7).
- **Pass:** message is forwarded once and carries all matched tier labels.
- **Record:** any missing label, any conflicting-action surprise.

## V5 — Duplicate forwarding
**Verify** the single-forward-filter design prevents double forwarding (M0 risk).
- Send one invoice that matches many signals.
- **Pass:** exactly **one** copy arrives in Central.
- **Record:** any duplicate copies (would indicate multiple forward actions firing).

## V6 — High-volume forwarding
**Verify** behaviour approaching Gmail's forwarding cap (M0: ~500/day consumer, 10k/day
Workspace).
- Send a burst (e.g. 50, then 200) of invoice-class mail to a source; observe forwarding.
- **Record:** delivery latency, any throttling / "limit for sending mail" error, and how many
  were forwarded vs dropped. Note whether accounts are consumer or Workspace.
- **Pass:** all forwarded within limits; document the real ceiling observed.

## V7 — Central mailbox labeling
**Verify** the central filter applies `Invoices` to forwarded mail using the configured routing
rules — using whatever V2 proves is reliable.
- **Pass:** every forwarded invoice in Central is labelled `Invoices`.
- **Record:** any forwarded invoice that reaches Central **unlabelled** (would need the V2-based
  routing-rule change).

---

## Exit criteria (before Milestone 3)
- V1, V3, V4, V5, V7 pass.
- V2 observed and the central routing decision recorded (forwarded vs original sender vs subject).
- V6 real forwarding ceiling documented; consumer-vs-Workspace confirmed.
- Any failure logged with a proposed configurable (not hardcoded) remedy.
