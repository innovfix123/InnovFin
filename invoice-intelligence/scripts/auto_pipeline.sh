#!/usr/bin/env bash
# =============================================================================
# invoice-intelligence — auto pipeline runner (innovfin droplet, for cron)
# Runs: collect (read new mail from invoices@innovfix.in) -> pipeline (classify + store + label).
# Incremental + idempotent: already-processed mail is skipped; re-runs never duplicate.
# Cron (every 5 min):
#   */5 * * * * /var/www/innovfin/invoice-intelligence/scripts/auto_pipeline.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mkdir -p build

# Load INVOICE_* (incl. INVOICE_IMAP_PASSWORD) from the innovfin repo .env — cron gets a bare env.
ENVFILE="/var/www/innovfin/.env"
if [ -f "$ENVFILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      INVOICE_*=*)
        key="${line%%=*}"; val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
        export "$key=$val" ;;
    esac
  done < "$ENVFILE"
fi

PY=".venv/bin/python"
LOG="build/auto_pipeline.log"
{
  echo "===== RUN $(date '+%Y-%m-%d %H:%M:%S') ====="
  if [ -z "${INVOICE_IMAP_PASSWORD:-}" ]; then
    echo "ERROR: INVOICE_IMAP_PASSWORD not set (add it to $ENVFILE)"; exit 1
  fi
  "$PY" cli.py collect
  "$PY" cli.py pipeline
  echo "----- done $(date '+%H:%M:%S') -----"
} >> "$LOG" 2>&1
