# Architecture — Phase 1

## Design principles
Modular · configuration-driven · explainable · testable · nothing hardcoded · every mailbox and
vendor replaceable via YAML.

## High-level flow
```
config/*.yaml
   │  (Mailbox / Vendor / Label registries + query-engine + keyword/vendor vocab)
   ▼
Query Engine  ──►  builds ONE broad forward query + P1–P7 tier queries + a review query
   │                (recall-first: forward query has NO negatives)
   ▼
Filter Generator  ──►  per source mailbox: 9 filters (1 forward + 7 tier + 1 review)
   │                    per central mailbox: 1 label filter
   ▼
build/filters/*.xml  ──►  imported into each Gmail account (manual, one-time)
   │
   ▼
Gmail executes the filters  ──►  invoices forwarded to central + labeled `Invoices`
```

The **Query Simulator** models Gmail's operator semantics offline so every generated query is
unit-tested against a labeled corpus without touching Gmail.

## Modules
| Package | Responsibility |
|---|---|
| `registry/` | **Mailbox Registry** (sources + central, priorities, forward targets), **Vendor Registry** (foundation), **Label Registry** (no hardcoded labels), typed models |
| `gmail_native/` | **Query Engine** (`query_engine.py`), **Filter Generator** (`filters_export.py`), **Query Simulator** (`query_sim.py`), query **versioning** |
| `core/` | Config loader/validator, and the detection engine reused for offline evaluation |
| `metrics/` | Metrics foundation (recall/precision/counts) — structure for future reporting |
| `config/` | All YAML: `mailboxes`, `vendors`, `labels`, `query_engine`, `invoice_keywords`, `trusted_vendors`, `gmail_routing`, `negative_keywords`, … |
| `tests/` | 117 unit tests incl. query engine, registries, gateway exporters, simulator |
| `cli.py` | Entry point: `gmail-build`, `mailbox-check`, `config-check`, `recall-check`, `gmail-eval` |

## The recall-first query engine
- **Forward query** = union of ALL positive tier signals (P1 keywords, P2 vendor domains,
  P3 filename, P4 body, P5 subject, P6 finance, P7 catch-all `has:attachment filename:pdf`).
  It contains **no negative terms**, so nothing can ever suppress forwarding.
- **P1–P7 label filters** = each signal family isolated, label-only (observability of *why*).
- **Review filter** = `filename:pdf` AND a negative marker → `Invoices/Review`. Negatives only
  label; they never block forwarding.
- **Query-length guard** = every generated query is measured against Gmail's ~1500-char limit and
  warns (or, in strict mode, fails) before truncation risk.
- **Versioning** = each query carries `engineVersion-contentHash`, so filter changes are diffable.

## Central-mailbox labeling (validated design)
Forwarded Gmail shows the **original sender** in `From`, so matching source addresses in central
is unreliable. The central filter therefore uses `routing_rules.use_invoice_signals: true` — it
matches the **invoice-signal query** and applies `Invoices` + **Never send to Spam**. Robust
regardless of `From`. (Sender-address matching remains available as a fallback via config.)

## Key patterns
Detector/registry plugin pattern · evidence-based detection · adapter-ready ingestion boundary
(so a future Gmail-API/IMAP executor is a swap, not a rewrite) · fail-fast config validation.
