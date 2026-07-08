# Milestone 0 — Gmail Native Behaviour Research

Purpose: establish the **documented, official** limits and behaviours of Gmail-native
filtering + forwarding so the Enterprise Invoice Email Gateway is designed *around* them
rather than discovering them in production. Recall-first mandate: **any limit that can cause
a silently-dropped invoice is treated as a first-class design constraint.**

Sources are cited per section. Figures are tagged:
- **[OFFICIAL]** — stated on an official Google support/knowledge page (verified July 2026).
- **[REPORTED]** — widely and consistently reported by third parties but **not** confirmed on
  an official Google page; must be treated as an assumption and re-verified before we rely on it.

---

## 1. Forwarding behaviour

- **Filter-based forwarding only affects NEW incoming mail.** Existing/historical mail is not
  forwarded by a forwarding filter. **[OFFICIAL]**
  > "When you create a filter to forward messages, only new messages will be affected."
- **Spam is never forwarded.** Gmail forwards "all new messages … except for spam."
  **[OFFICIAL]** → *Recall risk: an invoice misclassified as spam is unrecoverable in native mode.*
- **Forwarding to multiple addresses requires one filter per address.** **[OFFICIAL]**
  > "To forward messages to multiple accounts, create a filter for every forwarding email address."
- **Forward target must be added and VERIFIED** in the source account's Forwarding settings
  before a filter's `forwardTo` takes effect. **[OFFICIAL]** (already handled in setup docs)

Sources: [Create rules to filter your emails](https://support.google.com/mail/answer/6579?hl=en),
[Automatically forward Gmail messages](https://support.google.com/mail/answer/10957?hl=en)

## 2. Forwarding / sending volume limits (the scaling ceiling)

| Account type | Limit | Value | Tag |
|---|---|---|---|
| **Consumer @gmail.com** | Emails sent per day (forwarding counts as sending) | **~500 / day** | [OFFICIAL] |
| Consumer | Recipients per single email | 500 | [OFFICIAL] |
| Consumer | Recovery after hitting limit | 1–24 hours | [OFFICIAL] |
| **Workspace** | Messages auto-forwarded per day | **10,000 / day** | [OFFICIAL] |
| **Workspace** | Account filters for auto-forwarding | **40** | [OFFICIAL] |
| Workspace | Messages sent per user per day | 2,000 | [OFFICIAL] |
| Workspace | External recipients per day | 3,000 | [OFFICIAL] |

**Key consequence:** on **consumer Gmail**, sustained volume approaching **~500 forwards/day per
mailbox** will throttle for up to 24h → **silent invoice misses**. Workspace raises this to
**10,000/day**. For the target of *hundreds–low-thousands/day*, consumer accounts are viable
per-mailbox but must be **monitored**; genuine high volume requires Workspace.

Sources: [Limits for sending & getting mail](https://support.google.com/mail/answer/22839?hl=en),
[Gmail sending limits in Google Workspace](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace?hl=en)

## 3. Filter count & query-length limits

- **Auto-forwarding filters per account (Workspace): 40.** **[OFFICIAL]** — a hard cap on how
  many *forwarding* filters may exist. **This validates the single-broad-forward-filter design:
  label-only filters do not consume this budget.**
- **Total filters per account: ~1,000.** **[REPORTED]** (not found on an official page).
- **Per-filter criteria length: ~1,500 characters.** **[REPORTED]** (not found on an official
  page). The existing code already emits compact grouped `op:(a OR b)` form specifically to stay
  short — a good instinct we must keep and enforce with a length guard.

Sources: [Gmail sending limits in Google Workspace](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace?hl=en) (40 forwarding filters); filter-count/length figures are third-party [REPORTED] and flagged for re-verification.

## 4. Search operators usable in filters

Confirmed operators (all used by our query builder): `from:`, `to:`, `subject:`,
`has:attachment`, `filename:`, `larger:`/`smaller:`, `OR` (and `{ }`), implicit `AND`,
`-` (exclusion), `" "` (exact phrase), `( )` (grouping), plus `label:`, `in:`, `cc:`, `after:`/`before:`.
**[OFFICIAL]**

> Gmail matches sender, recipient, subject, body text, and **attachment NAME/type** — it
> **cannot** read attachment *contents*. (Confirmed limitation; already modelled by `query_sim`.)

Source: [Refine searches in Gmail](https://support.google.com/mail/answer/7190?hl=en)

## 5. Label behaviour

- Filters can **apply a label** and Gmail **auto-creates nested labels** (`Invoices/Auto`) on
  filter import. **[OFFICIAL]**
- A label applied by a **source-account** filter exists only in the source account. To guarantee
  the `Invoices` label **in the central mailbox**, a **filter inside the central account** is
  required (see §8). **[Derived]**

Source: [Create rules to filter your emails](https://support.google.com/mail/answer/6579?hl=en)

## 6. Filter execution model

- Filters run **server-side, per message, at delivery.** There is **no user-visible queue**;
  volume does not "back up" filter evaluation. **[Derived from official behaviour]**
- **Multiple filters can match one message**, and their actions combine. **[Derived]** —
  implication for forwarding in §7.
- Replies are only re-filtered if they independently match the same criteria. **[OFFICIAL]**

## 7. Duplicate-forwarding behaviour

- Because "forward to multiple addresses = one filter per address," **each forwarding filter that
  matches a message performs its own forward.** If **two forwarding filters both match** the same
  message and both forward to central, the message can be **forwarded twice.** Not explicitly
  documented → treated as a **risk**. **[REPORTED/Derived]**
- **Design response:** exactly **ONE forwarding filter per source account** eliminates duplicate
  forwards structurally.

## 8. High-volume behaviour (synthesis)

At 100 / 500 / 1000 / 5000 mails arriving:
- **Filter matching/labelling**: applied per-message at delivery; no throttling of *matching*. ✅
- **Forwarding**: bounded by §2 caps. Consumer throttles near ~500/day/mailbox → silent misses.
  Workspace safe to 10,000/day. ⚠️
- **Mitigations**: (a) one lean forward filter; (b) monitor per-mailbox forward volume and alert
  before the cap; (c) prefer Workspace for high volume; (d) `shouldNeverSpam` on trusted senders
  to keep invoices out of spam (spam is never forwarded).

---

## 9. Architecture implications (feeds Milestone 1+)

1. **One forwarding filter per source account** — validated by both the 40-forward-filter cap and
   duplicate-forward risk. P1–P7 stay **label-only**.
2. **Query-length guard** — the generator must measure the forward query and warn/split before the
   ~1,500-char [REPORTED] limit; keep compact grouped form.
3. **Central-mailbox labelling needs its own filter** in the central account. Recommended robust
   technique: forward to a **plus-addressed alias** (e.g. `central+invoices@…`) and filter
   `to:(central+invoices)` in central to deterministically apply `Invoices`. ⚠️ Verify plus-address
   is acceptable as a *verified forwarding target* before committing; fallback = match on source
   addresses / a marker label.
4. **Spam is an unrecoverable native gap** — set `shouldNeverSpam`, document residual risk.
5. **Consumer forwarding cap is an operational limit, not a code bug** — surface it in monitoring
   docs; recommend Workspace for scale.
6. **Re-verify [REPORTED] figures** (1,000 filters, 1,500 chars) before relying on them as hard
   guarantees.

_All limits recorded here are as of July 2026 and should be re-checked periodically._
