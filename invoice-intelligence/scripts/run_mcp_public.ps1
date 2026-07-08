# =============================================================================
# Invoice Intelligence — PUBLIC MCP connector (shareable URL, no auth)
#
# Starts the MCP server (Streamable HTTP) + a Cloudflare tunnel, and prints a public
# https URL. Share that URL (with /mcp on the end) — anyone can add it in Claude Desktop:
#     Settings -> Connectors -> Add custom connector -> paste  https://XXXX.trycloudflare.com/mcp
#
# Keep this window OPEN while people use it (it is the live server + tunnel). Ctrl+C to stop.
#
# NOTE: no authentication — ANYONE with the URL can read the invoice data. Share only with people
#       you trust. The trycloudflare URL CHANGES every time you restart this script.
# =============================================================================

$proj = Split-Path -Parent $PSScriptRoot     # project root, wherever this lives
Set-Location $proj
$env:INVOICE_MCP_TRANSPORT = "streamable-http"
$env:INVOICE_MCP_HOST = "127.0.0.1"
$env:INVOICE_MCP_PORT = "8765"
$cf = Join-Path $proj "tools\cloudflared.exe"
if (-not (Test-Path $cf)) {
    $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($onPath) {
        $cf = "cloudflared"
    } else {
        Write-Host "cloudflared not found - downloading once..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Force -Path (Split-Path $cf) | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cf
    }
}

Write-Host "Starting MCP server..." -ForegroundColor Cyan
$server = Start-Process python -ArgumentList "-m", "mcp_server.server" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5

Write-Host "Starting public tunnel (URL appears below in a few seconds)..." -ForegroundColor Cyan
try {
    & $cf tunnel --url http://127.0.0.1:8765 --no-autoupdate 2>&1 | ForEach-Object {
        $line = "$_"
        if ($line -match "https://[a-z0-9-]+\.trycloudflare\.com") {
            $u = $matches[0]
            Write-Host ""
            Write-Host "================================================================" -ForegroundColor Green
            Write-Host "  SHARE THIS URL (add in Claude Desktop -> Connectors):" -ForegroundColor Green
            Write-Host "      $u/mcp" -ForegroundColor Yellow
            Write-Host "================================================================" -ForegroundColor Green
            Write-Host ""
        }
        Write-Host $line
    }
}
finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Server + tunnel stopped." -ForegroundColor Yellow
}
