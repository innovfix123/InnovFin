"""Enterprise Invoice Intelligence — MCP server.

Exposes the invoice pipeline + store as Model Context Protocol tools so Claude / agents can
query invoices, inspect a single canonical record, list the manual-review queue, get stats, and
run the pipeline — all over the same deterministic backend the CLI uses.

Run:  python -m mcp_server.server      (stdio transport)
"""
