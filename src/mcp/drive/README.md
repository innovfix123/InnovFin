# Google Drive tools (mounted in the gstr2b-estimate MCP)

A **live bridge to one shared Google Drive folder**. Google Drive is the Single Source of Truth: every
tool reads live from Drive on each call, so uploads/edits/renames/moves/deletes are reflected instantly
with **no synchronization step and no stored file copies**. The only cache is a 60-second in-memory list
of the folder-tree's folder IDs (pure metadata) to keep search cheap.

**There is no standalone Drive endpoint.** These tools are mounted into the Estimated GSTR-2B MCP, so
finance gets ITC numbers and the source documents on one connection:

Endpoint: `https://gst.innovfix.ai/mcp/gstr2b-estimate` · Local (stdio): `npm run mcp:gstr2b`

Inbound auth is therefore whatever gstr2b-estimate already uses (`GSTR2B_EST_MCP_TOKEN_*` + its OAuth
allowlist). Tool names are prefixed `drive_` so they never collide with the host server's `itc_*` tools.

## Tools
| Tool | Purpose |
|---|---|
| `drive_list_files` | List files & folders in the folder (drill into a subfolder with `folderId`) |
| `drive_search_files` | Search by name **and** full-text content across the whole subtree |
| `drive_latest_documents` | Most recently added/edited documents, newest first |
| `drive_read_file` | Read content as text (Google Docs→text, Sheets→CSV, Slides→text, text uploads, PDFs) |
| `drive_read_sheet` | Spreadsheet tabs as CSV (Google Sheets via export; .xlsx parsed locally) |
| `drive_read_pdf` | Extract a PDF's text (embedded text layer; notes when a scan needs OCR) |

### Write tools (Phase 3 — off by default)
Registered **only when `DRIVE_MCP_WRITE=1`** and the Google consent covers the full `drive` scope.
Read-only deployments never expose these, and the requested scope stays `drive.readonly` when the flag
is off — so a flag-off deployment cannot mutate anything even by accident.

| Tool | Purpose |
|---|---|
| `drive_create_folder` | Make a new subfolder inside the connected tree |
| `drive_upload_text_file` | Create a new text/CSV/JSON/Markdown file from content (binary → upload in Drive) |
| `drive_update_file_content` | Overwrite an existing text file's content (not Google-native Docs/Sheets) |
| `drive_rename_file` | Rename a file or folder |
| `drive_move_file` | Move a file/folder to another subfolder **within** the tree |
| `drive_trash_file` | Move to Trash — **recoverable, not a permanent delete** (by design) |

> All writes are confined to the connected folder subtree, audited (tool + arg *shape*, never content),
> and there is **no permanent-delete tool** — `drive_trash_file` is restorable from Drive Trash (~30 days).
> With user OAuth (the mode we run on) created files are owned by the consenting **user**, so the
> service-account `storageQuotaExceeded` trap does not apply.

## One-time setup

### 1. Google side — user OAuth (the mode we use)
The Cloud org enforces `iam.disableServiceAccountKeyCreation`, so **service-account JSON keys cannot be
downloaded at all**. We authorise once as the human who owns the folder instead.

1. [Google Cloud Console](https://console.cloud.google.com) → create/select a project.
2. **APIs & Services → Library → enable "Google Drive API".**
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: Desktop
   app.** Copy the client ID and client secret.
4. Put them in `.env` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Run `npm run drive:auth`. It prints a consent URL — open it in a browser signed in as the
   folder-owning account, approve, then paste the redirected URL back. It prints
   `GOOGLE_OAUTH_REFRESH_TOKEN=…`; add that to `.env`.
6. Copy the folder ID from its URL: `https://drive.google.com/drive/folders/`**`<FOLDER_ID>`** → `DRIVE_FOLDER_ID`.

> Want the write tools? Set `DRIVE_MCP_WRITE=1` **before** running `drive:auth`, so consent covers the
> full `drive` scope rather than `drive.readonly`.

<details><summary>Fallback: service account (only where key creation is permitted)</summary>

Create a service account → **Keys → Add key → JSON**, share the folder with the SA email (Viewer, or
Editor for writes), and set `GOOGLE_SA_KEY_JSON` (inline) or `GOOGLE_SA_KEY_FILE` (path). `google-auth.ts`
uses this automatically when no `GOOGLE_OAUTH_*` credential is present. Note the SA has no storage quota
of its own, so writes into a personal My-Drive folder can fail with `storageQuotaExceeded`.
</details>

### 2. `.env` (see `.env.example` → "Google Drive tools" block)
```
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
GOOGLE_OAUTH_REFRESH_TOKEN=1//...       # from `npm run drive:auth`
DRIVE_FOLDER_ID=<FOLDER_ID>
# DRIVE_MCP_WRITE=1                     # opt in to the 6 write tools
```

> **Never commit these.** `.env` is gitignored; the refresh token is a long-lived credential to that
> account's Drive.

### 3. Verify + deploy
```
npm run mcp:drive:smoke      # lists the folder, searches, reads a doc — proves live read-through
git push                     # CI: npm ci → npm run build → pm2 restart innovfin
```
No nginx change and no new pm2 process — the tools ride on the existing `innovfin` app's
`/mcp/gstr2b-estimate` endpoint.

## Design notes / trade-offs
- **Why no sync engine / webhooks?** For a single folder, reading live on every call is simpler *and*
  more reliable than a cache+Changes-API+webhook pipeline — there's nothing that can go stale. The
  cursor/webhook design is only worth it at thousands-of-docs scale where re-listing is too expensive.
- **10 MB export limit:** Google caps `files.export` at 10 MB. `drive_read_file` returns the `webViewLink`
  instead of erroring for oversized native docs.
- **Scanned PDFs:** `drive_read_pdf` returns the embedded text layer; image-only scans report "OCR required"
  (wire to the invoice-intelligence OCR service later if needed).
- **Why no separate endpoint?** One connection that answers "what ITC do I expect?" *and* "show me the
  invoice behind it" beats two. Mounting is a 1-line call (`registerDriveTools(server)`), and the
  `drive_` prefix keeps the namespaces clean.
- **Scope safety:** every read is constrained to the configured folder and its descendants; a raw file
  id outside the tree is rejected.
