# Google Drive MCP

A **live bridge to one shared Google Drive folder**. Google Drive is the Single Source of Truth: every
tool reads live from Drive on each call, so uploads/edits/renames/moves/deletes are reflected instantly
with **no synchronization step and no stored file copies**. The only cache is a 60-second in-memory list
of the folder-tree's folder IDs (pure metadata) to keep search cheap.

Endpoint (networked): `https://gst.innovfix.ai/mcp/drive` · Local (stdio): `npm run mcp:drive`

## Tools
| Tool | Purpose |
|---|---|
| `list_files` | List files & folders in the folder (drill into a subfolder with `folderId`) |
| `search_files` | Search by name **and** full-text content across the whole subtree |
| `get_latest_documents` | Most recently added/edited documents, newest first |
| `read_file` | Read content as text (Google Docs→text, Sheets→CSV, Slides→text, text uploads, PDFs) |
| `read_sheet` | Spreadsheet tabs as CSV (Google Sheets via export; .xlsx parsed locally) |
| `read_pdf` | Extract a PDF's text (embedded text layer; notes when a scan needs OCR) |

## One-time setup

### 1. Google side (no Workspace admin needed)
1. [Google Cloud Console](https://console.cloud.google.com) → create/select a project.
2. **APIs & Services → Enable APIs → enable "Google Drive API".**
3. **Create a Service Account** → **Keys → Add key → JSON** → download the key file.
4. Open the finance folder in Drive → **Share** → paste the service-account email (looks like
   `name@project.iam.gserviceaccount.com`) → **Viewer** → Send.
5. Copy the folder ID from its URL: `https://drive.google.com/drive/folders/`**`<FOLDER_ID>`**.

> Read-only by design: the SA has Viewer and the OAuth scope is `drive.readonly`. To add write tools
> later, share the folder as **Editor** and widen the scope in `google-auth.ts`.

### 2. `.env` (see `.env.example` → "Google Drive MCP" block)
```
GOOGLE_SA_KEY_JSON=        # the downloaded JSON, inline (escape newlines as \n) …
# GOOGLE_SA_KEY_FILE=/var/www/innovfin/secrets/drive-sa.json   # … or a path (pick one)
DRIVE_FOLDER_ID=<FOLDER_ID>
DRIVE_MCP_TOKEN_JP=drv_...           # per-user bearer tokens (generate below)
DRIVE_MCP_ALLOWED_EMAILS=jp@innovfix.in,shoyab@innovfix.in,fida@innovfix.in
```
Generate a token: `node -e 'console.log("drv_"+require("crypto").randomBytes(24).toString("base64url"))'`

> **Never commit the SA key.** Put the JSON in `.env` (gitignored) or a gitignored `secrets/` path.

### 3. Verify + deploy
```
npm run mcp:drive:smoke      # lists the folder, searches, reads a doc — proves live read-through
git push                     # CI: npm ci → npm run build → pm2 restart innovfin
```
No nginx change and no new pm2 process — it's an in-process endpoint on the existing `innovfin` app.

## Design notes / trade-offs
- **Why no sync engine / webhooks?** For a single folder, reading live on every call is simpler *and*
  more reliable than a cache+Changes-API+webhook pipeline — there's nothing that can go stale. The
  cursor/webhook design is only worth it at thousands-of-docs scale where re-listing is too expensive.
- **10 MB export limit:** Google caps `files.export` at 10 MB. `read_file` returns the `webViewLink`
  instead of erroring for oversized native docs.
- **Scanned PDFs:** `read_pdf` returns the embedded text layer; image-only scans report "OCR required"
  (wire to the invoice-intelligence OCR service later if needed).
- **Scope safety:** every read is constrained to the configured folder and its descendants; a raw file
  id outside the tree is rejected.
