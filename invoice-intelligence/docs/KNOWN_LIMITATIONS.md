# Known Limitations — Phase 1

These are **structural properties of a Gmail-native approach**, not defects. Each is handled or
closed in Phase 2. Listed so they can be stated honestly in a demo.

## Detection (native can't read attachment contents)
| # | Limitation | Impact | Mitigation / closed by |
|---|---|---|---|
| 1 | **Cannot read inside attachments** — Gmail matches sender/subject/body/**filename**, never PDF/XML contents | A GSTIN/amount that exists only *inside* a PDF is invisible | P7 catch-all forwards **any** PDF, so PDF invoices are still caught; deep read = **Part 2 OCR** |
| 2 | **ZIP / archive attachments** with a generic name | A zipped invoice named `documents.zip` is not detected | Part 2 (attachment collection unzips) |
| 3 | **Image-only invoices** (jpg/png) with no invoice keyword/filename | Not detected natively | Part 2 (OCR) |
| 4 | **No de-duplication** | A re-sent invoice is forwarded again (2 copies) | Part 2 (dedup by hash / invoice no. / IRN) |

## Delivery (Gmail platform rules)
| # | Limitation | Impact | Mitigation |
|---|---|---|---|
| 5 | **Spam is never forwarded** | An invoice Gmail marks as spam in a source mailbox is missed | `shouldNeverSpam` on filters; mark trusted senders "Not spam"; Workspace reduces false spam |
| 6 | **Forwarding caps** — consumer ~500/day, Workspace 10,000/day per mailbox | High volume on a consumer mailbox throttles for up to 24h | Use Workspace for volume; monitor per-mailbox forward counts |
| 7 | **Central labeling depends on invoice-signal match** (not sender, since forwarded `From` = original sender) | Handled via `use_invoice_signals` | Validated and in place |

## Engineering / scalability
| # | Limitation | Impact | Mitigation |
|---|---|---|---|
| 8 | **Query length at 1485 / ~1500 chars** | Adding many more vendors/keywords could exceed Gmail's per-filter limit and truncate (silent-miss risk) | Length guard warns; **de-duplicate the forward-query terms** and/or split into multiple forward filters when scaling — see roadmap |
| 9 | **Legacy config retained** — `gmail_routing.yaml` still holds `forward_to`/`source_accounts` used only by the **deprecated** 2-filter exporter | None in production (registry is the source of truth); mild clutter | Remove the deprecated exporter + legacy keys in a cleanup release |
| 10 | **Vendor data duplicated** — `trusted_vendors.yaml` (live) vs `vendors.yaml` (Vendor Registry foundation, not yet used by generation) | None functionally | Consolidate in Part 2 when vendor-aware detection is built |

## Explicitly NOT limitations
- Forwarding a few extra finance emails (e.g. a promo with a PDF) is **by design** (recall-first);
  such mail is also flagged `Invoices/Review`.
