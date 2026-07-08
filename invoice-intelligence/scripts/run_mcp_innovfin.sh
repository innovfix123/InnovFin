#!/usr/bin/env bash
# innovfin: run the invoice-intelligence Python MCP (FastMCP, streamable-http, stateless+json) on
# 127.0.0.1 under pm2. Fronted by the Next.js OAuth proxy at
# https://gst.innovfix.ai/mcp/invoice-intelligence — never expose this port externally.
set -euo pipefail
cd "$(dirname "$0")/.."

# Load only INVOICE_* keys from the innovfin repo .env (INVOICE_MCP_TOKEN now; INVOICE_IMAP_PASSWORD
# + INVOICE_DB_DSN at go-live). Avoids sourcing the whole .env (other apps' secrets).
ENVFILE="/var/www/innovfin/.env"
if [ -f "$ENVFILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      INVOICE_*=*)
        key="${line%%=*}"
        val="${line#*=}"
        val="${val%\"}"; val="${val#\"}"   # strip optional surrounding double-quotes
        export "$key=$val"
        ;;
    esac
  done < "$ENVFILE"
fi

export INVOICE_MCP_TRANSPORT="streamable-http"
export INVOICE_MCP_HOST="127.0.0.1"
export INVOICE_MCP_PORT="${INVOICE_MCP_PORT:-8765}"
export INVOICE_CONFIG_DIR="config"

exec .venv/bin/python -m mcp_server.server
