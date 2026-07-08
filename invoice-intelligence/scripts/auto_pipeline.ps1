# =============================================================================
# Invoice Gateway — auto pipeline runner (for Windows Task Scheduler)
# Runs: collect (read new mail from invoices@) -> pipeline (classify + store + label).
# Idempotent: already-Processed mail is skipped; re-runs never duplicate.
#
# Requires the App Password in a PERSISTENT user env var:
#   setx INVOICE_IMAP_PASSWORD "your16charcode"     (run once, then open a new shell)
# The scheduled task inherits it automatically.
#
# Output is appended to build\auto_pipeline.log so you can see every run.
# =============================================================================

$ErrorActionPreference = "Continue"
# Project root = the folder that contains this scripts/ directory. Works wherever the project lives,
# so no path needs editing when this is copied to another machine.
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

$log = Join-Path $proj "build\auto_pipeline.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"`n========== RUN $ts ==========" | Out-File -Append -Encoding utf8 $log

# A freshly-setx'd user env var isn't in an already-open session's env block, and a scheduled task
# can inherit that stale block. Read the persistent value straight from the registry as a fallback
# so the task always finds the password (as long as `setx` was run once).
if (-not $env:INVOICE_IMAP_PASSWORD) {
    try {
        $env:INVOICE_IMAP_PASSWORD = (Get-ItemProperty -Path "HKCU:\Environment" -Name INVOICE_IMAP_PASSWORD -ErrorAction Stop).INVOICE_IMAP_PASSWORD
    } catch {}
}
if (-not $env:INVOICE_IMAP_PASSWORD) {
    "ERROR: INVOICE_IMAP_PASSWORD not set. Run: setx INVOICE_IMAP_PASSWORD ""yourcode""" |
        Out-File -Append -Encoding utf8 $log
    exit 1
}

python cli.py collect  2>&1 | Out-File -Append -Encoding utf8 $log
python cli.py pipeline 2>&1 | Out-File -Append -Encoding utf8 $log

"---------- done $((Get-Date).ToString('HH:mm:ss')) ----------" | Out-File -Append -Encoding utf8 $log
