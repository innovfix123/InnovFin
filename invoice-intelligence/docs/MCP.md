# Invoice Intelligence — MCP Server

Exposes the invoice pipeline + store as **Model Context Protocol** tools, so Claude (or any
agent) can query and process invoices in natural language.

## Tools
| Tool | Kya karta hai |
|---|---|
| `search_invoices` | Vendor / GSTIN / invoice number / status / date-range / amount se search |
| `get_invoice(doc_id)` | Ek invoice ka poora canonical JSON (fields, validation, provenance, dedup) |
| `list_needs_review` | Manual-review queue (low-confidence / validation-fail invoices) |
| `invoice_stats` | Counts: accepted / needs_review / duplicate / total |
| `run_pipeline` | Configured mailbox/sample padho → poora pipeline → store; summary do |

All tools run over the same backend as the CLI (PostgreSQL, SQLite fallback) from `config/storage.yaml`.

## Run (standalone)
```
python -m mcp_server.server          # stdio transport
```

## Register with Claude Desktop
`claude_desktop_config.json` mein add karo:
```json
{
  "mcpServers": {
    "invoice-intelligence": {
      "command": "python",
      "args": ["-m", "mcp_server.server"],
      "cwd": "C:\\Users\\sahuv\\IdeaProjects\\invoce_byfilter",
      "env": { "INVOICE_CONFIG_DIR": "config" }
    }
  }
}
```
*(venv use kar rahe ho to `command` mein venv ka python do, e.g. `...\\.venv\\Scripts\\python.exe`.)*

## Register with Claude Code
```
claude mcp add invoice-intelligence -- python -m mcp_server.server
```
(project folder ke andar se chalao, ya `--cwd` do.)

## Example prompts (Claude se)
- "Sabhi invoices dikhao jo review mein hain" → `list_needs_review`
- "Razorpay ki invoices dhoondo" → `search_invoices(text="razorpay")`
- "INV-2026-501 ka poora data do" → `get_invoice`
- "1 June se ab tak ki 10,000 se upar wali invoices" → `search_invoices(date_from=..., min_total=10000)`
- "Naye mails process karo" → `run_pipeline`

## Note
`run_pipeline` config/attachments.yaml ke `mail_reader` ko use karta hai — abhi `sample` (offline).
Live jaane ke liye `type: imap` karo (central `invoices@innovfix.in`) + `INVOICE_IMAP_PASSWORD` env var.
