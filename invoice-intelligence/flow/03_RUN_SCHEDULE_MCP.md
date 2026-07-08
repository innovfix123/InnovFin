# 03 — Run, Schedule & Connect Claude (MCP)

## A. Manual run
```bash
python cli.py collect      # read new mail from invoices@ (marks Processed)
python cli.py pipeline     # extract -> validate -> classify -> store -> label
python cli.py search       # list stored invoices
python cli.py show <id>    # one invoice in full (fields + complete text)
```
`pipeline` is **incremental** — it only extracts NEW documents and reuses everything already
stored. After changing extractor rules, force a full rebuild with `python cli.py pipeline --reprocess`.

## B. Schedule it (hands-free, every 5 minutes)

### Linux (cron)
```bash
chmod +x scripts/auto_pipeline.sh
crontab -e
# add (put your real App Password, or export it in the shell/service environment):
*/5 * * * * INVOICE_IMAP_PASSWORD=your16charcode /full/path/to/project/scripts/auto_pipeline.sh
```
Logs append to `build/auto_pipeline.log`.

### Windows (Task Scheduler)
Set the App Password once (persistent), then register the task. Use the PowerShell cmdlets below
(not plain `schtasks`) — they make the task run every 5 minutes reliably AND run on battery, which a
laptop needs. Replace `PROJECT` with the real project path.
```powershell
setx INVOICE_IMAP_PASSWORD "your16charcode"     # once; open a NEW shell after
$ps1 = "C:\PROJECT\scripts\auto_pipeline.ps1"
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ps1`""
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "InvoiceGatewayPipeline" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force
```
`scripts/auto_pipeline.ps1` auto-detects the project folder and reads the App Password from the
persistent user environment (registry fallback), so it works from the scheduler without editing.
Check `build/auto_pipeline.log` after a few minutes to confirm runs.

## C. Connect Claude — the MCP server
The pipeline is exposed to Claude as **MCP tools**: `search_invoices`, `get_invoice`,
`list_needs_review`, `list_not_invoice`, `invoice_stats`, `approve_invoice`, `reject_invoice`,
`set_invoice_field`, `run_pipeline`.

### Option 1 — Local (same machine as the DB) — simplest, no URL
Add to Claude Desktop's `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):
```json
{
  "mcpServers": {
    "invoice-intelligence": {
      "command": "python",
      "args": ["-m", "mcp_server.server"],
      "cwd": "/full/path/to/project",
      "env": { "INVOICE_CONFIG_DIR": "config" }
    }
  }
}
```
Restart Claude Desktop → the invoice tools appear. Works 100% locally, no network setup.

### Option 2 — Remote URL (any laptop connects) — for a shared connector
Run the server over HTTP (Streamable HTTP, the transport Claude Desktop connectors use):
```bash
export INVOICE_MCP_TRANSPORT=streamable-http
export INVOICE_MCP_HOST=0.0.0.0        # accept remote connections
export INVOICE_MCP_PORT=8765
python -m mcp_server.server            # serves http://<host>:8765/mcp
```
Then either:
- **On a real server with a domain/HTTPS:** put it behind your reverse proxy (nginx/Caddy) with a
  TLS cert, and share `https://your-domain/mcp`. Add that URL in Claude Desktop → Settings →
  Connectors → *Add custom connector*.
- **From a laptop, quick public URL:** use a tunnel. A helper is included —
  `scripts/run_mcp_public.ps1` (Windows) starts the server + a Cloudflare quick tunnel and prints a
  `https://xxxx.trycloudflare.com/mcp` URL. It **auto-downloads cloudflared** on first run if it's
  missing, so nothing to install manually. (Linux: install cloudflared, then
  `cloudflared tunnel --url http://127.0.0.1:8765`.) Share the printed `.../mcp` URL; anyone adds it
  in Claude Desktop → Settings → Connectors → Add custom connector.

### Auth (optional)
Set `INVOICE_MCP_TOKEN=some-secret` and the server requires `Authorization: Bearer some-secret` on
every request. Leave it unset for an open connector. **Anyone who can reach the URL can read the
invoice data — protect it (VPN / auth / trusted network) before exposing it publicly.**

### Notes
- The MCP server reads the same `config/storage.yaml` database as the CLI.
- For 24/7 remote use, run the server (and tunnel/proxy) as a service so it survives reboots, and
  keep the host always-on. A small always-on server/VM is more reliable than a laptop.
