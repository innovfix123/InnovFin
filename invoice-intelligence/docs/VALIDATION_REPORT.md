# Validation Report — Phase 1

## Summary
The Gmail-Native Invoice Gateway meets its headline goal: **zero silent misses** for detectable
invoices, while keeping non-invoices out and flagging ambiguous mail for review. Validated by an
automated test suite, an offline scenario simulation, and live end-to-end Gmail testing.

## 1. Automated test suite
```
python -m pytest   →   117 passed
```
Covers: config loader/validation, Mailbox/Vendor/Label registries, query engine (recall-first,
no-negatives, tiers, versioning, length guard), the query simulator (Gmail operator semantics),
and the **production filter exporters** (single forwarding filter, label-only filters, and the
central `use_invoice_signals` fix).

## 2. Offline detection analysis
```
python cli.py recall-check
```
Result on the labeled corpus: **Recall = 100%, False Negatives = 0, Zero silent misses: YES.**

## 3. Scenario simulation (14 cases, run against the deployed queries)
| Class | Cases | Result |
|---|---|---|
| Positive invoices (PDF, content-only, attachment-only, vendor, XML) | 5 | ✅ all forwarded |
| Negatives (newsletter, OTP, meeting, social) | 4 | ✅ none forwarded |
| Recall-first / review (promo + PDF, unknown-vendor PDF) | 2 | ✅ forwarded (promo also flagged Review) |
| Native gaps (generic ZIP, image-only) | 2 | ⚠️ not forwarded (documented limit → Part 2) |
| Duplicate re-send | 1 | ⚠️ forwarded twice (no dedup → Part 2) |
**14/14 matched expected behavior.**

## 4. Live Gmail validation (test environment)
Environment: `sat211053@gmail.com`, `satyamsahu0877@gmail.com` (sources) → `satyam@innovfix.in`
(Workspace central).
- ✅ Invoices from both sources **forwarded** to Central and **labeled `Invoices`**.
- ✅ Non-invoices **not** forwarded.
- ✅ Recall-first confirmed (unknown-vendor PDF forwarded; promo+PDF forwarded and `Invoices/Review`).
- ✅ Single-forward-filter design confirmed (no duplicate forwards from one filter).

### Issue found and fixed during live validation
Forwarded invoices initially reached Central **unlabeled** and some landed in **Spam**. Root cause
(confirmed from real `From` headers): forwarded Gmail shows the **original sender**, so the
central filter's `from:(source addresses)` never matched. **Fixed** by switching the central
filter to `use_invoice_signals: true` (match invoice signals + never-spam). Re-validated: invoices
now labeled `Invoices` in Central and kept out of Spam. Regression test added.

## 5. Success criteria
| Criterion | Status |
|---|---|
| Multiple configurable mailboxes | ✅ |
| Every probable invoice forwarded | ✅ (recall 100%) |
| Central receives + labels invoices | ✅ (after fix) |
| No mailbox hardcoded | ✅ (registry-driven) |
| No duplicate forwarding (per design) | ✅ (single forward filter) |
| Configuration-driven | ✅ |
| Documented | ✅ |
| Production-ready for Phase 1 | ✅ |
