# =============================================================================
# Invoice Intelligence — MCP server as a REMOTE URL (for Claude Desktop connector)
#
# Starts the MCP server over SSE so a Claude client can connect by URL:
#     http://<THIS-MACHINE-IP>:8765/sse
#
# Keep this window open while the manager uses it. The server reads the same PostgreSQL
# store as the pipeline, so it must run on the machine that has the project + DB (this one).
#
# SECURITY: this exposes invoice data on the network. Host 0.0.0.0 accepts LAN connections
# (same office network). Do NOT expose it to the public internet without an authenticated
# tunnel. Windows Firewall must allow inbound TCP 8765 for other machines to reach it.
# =============================================================================

Set-Location (Split-Path -Parent $PSScriptRoot)   # project root, wherever this lives
$env:INVOICE_MCP_TRANSPORT = "sse"
$env:INVOICE_MCP_HOST = "0.0.0.0"     # 0.0.0.0 = accept LAN; use 127.0.0.1 for this-machine-only
$env:INVOICE_MCP_PORT = "8765"

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
       Select-Object -First 1).IPAddress
Write-Host "MCP server URL for Claude Desktop:  http://$ip`:8765/sse" -ForegroundColor Green
Write-Host "(this machine only:                 http://127.0.0.1:8765/sse)"
Write-Host "Keep this window open. Ctrl+C to stop." -ForegroundColor Yellow

python -m mcp_server.server
