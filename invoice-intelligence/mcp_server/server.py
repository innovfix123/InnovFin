"""MCP server exposing Invoice Intelligence tools (stdio transport).

Tools:
  * search_invoices  — query by vendor/GSTIN/number/status/date-range/amount
  * get_invoice      — full canonical JSON for one doc_id
  * list_needs_review— the manual-review queue
  * list_not_invoice — the junk bin (noise the broad rule forwarded, no invoice signals)
  * invoice_stats    — counts by status
  * run_pipeline     — read the configured mailbox/sample and process end-to-end

The store backend (PostgreSQL / SQLite) comes from config/storage.yaml — same as the CLI.
"""

from __future__ import annotations

import os

import yaml
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from mcp_server import tools
from storage.invoice_store import build_invoice_store

CONFIG_DIR = os.environ.get("INVOICE_CONFIG_DIR", "config")


def _storage_cfg() -> dict:
    with open(os.path.join(CONFIG_DIR, "storage.yaml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


_store = build_invoice_store(_storage_cfg())

# Host/port matter only for the HTTP/SSE transport (a remote URL). For stdio they are ignored.
# DNS-rebinding protection is disabled so the server can be reached through a tunnel on ANY
# hostname (the shareable public URL). Only do this for an intentionally open/shared connector.
mcp = FastMCP(
    "invoice-intelligence",
    host=os.environ.get("INVOICE_MCP_HOST", "127.0.0.1"),
    port=int(os.environ.get("INVOICE_MCP_PORT", "8765")),
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    # innovfin: stateless + single JSON response per POST, so the Next.js OAuth proxy at
    # gst.innovfix.ai/mcp/invoice-intelligence can relay each JSON-RPC call 1:1 (no SSE stream,
    # no Mcp-Session-Id affinity) — mirrors the in-process TS MCP routes (onlycare/hima/gateway).
    stateless_http=True,
    json_response=True,
)


@mcp.tool()
def search_invoices(
    text: str | None = None,
    vendor_gstin: str | None = None,
    invoice_number: str | None = None,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    received_from: str | None = None,
    received_to: str | None = None,
    sender: str | None = None,
    min_total: float | None = None,
    max_total: float | None = None,
    limit: int = 50,
) -> list[dict]:
    """Search stored invoices. `text` is a substring over vendor/buyer/number/GSTIN/sender;
    `status` is accepted|needs_review|duplicate|not_invoice; `date_from`/`date_to` filter the
    INVOICE date; `received_from`/`received_to` filter when the mail ARRIVED (use these for
    "today's / this week's invoices"); `sender` matches the From address (e.g. who emailed it).
    All dates are YYYY-MM-DD inclusive."""
    return tools.search_invoices(
        _store, text=text, vendor_gstin=vendor_gstin, invoice_number=invoice_number,
        status=status, date_from=date_from, date_to=date_to,
        received_from=received_from, received_to=received_to, sender=sender,
        min_total=min_total, max_total=max_total, limit=limit,
    )


@mcp.tool()
def get_invoice(doc_id: str) -> dict:
    """Full canonical invoice JSON (fields, validation, provenance, dedup) for a doc_id."""
    return tools.get_invoice(_store, doc_id)


@mcp.tool()
def list_needs_review(limit: int = 50) -> list[dict]:
    """Invoices flagged for manual review (low confidence or validation failures)."""
    return tools.list_needs_review(_store, limit=limit)


@mcp.tool()
def list_not_invoice(limit: int = 50) -> list[dict]:
    """Mail the broad routing rule forwarded that carries no invoice signals (marketing,
    newsletters, generic receipts). Kept for audit; never silently dropped."""
    return tools.list_not_invoice(_store, limit=limit)


@mcp.tool()
def invoice_stats() -> dict:
    """Counts of stored invoices by status (accepted / needs_review / duplicate / not_invoice)
    plus total."""
    return tools.invoice_stats(_store)


@mcp.tool()
def approve_invoice(invoice: str, note: str = "") -> dict:
    """Mark a reviewed invoice (doc_id or invoice number) as accepted after a human verified it."""
    return tools.approve_invoice(_store, invoice, note=note)


@mcp.tool()
def reject_invoice(invoice: str, note: str = "") -> dict:
    """Mark an invoice (doc_id or invoice number) as not_invoice (it isn't a real invoice)."""
    return tools.reject_invoice(_store, invoice, note=note)


@mcp.tool()
def set_invoice_field(invoice: str, field: str, value: str) -> dict:
    """Set/correct one field on an invoice (e.g. a total the extractor missed) and re-validate;
    the status may move from needs_review to accepted once complete."""
    return tools.set_invoice_field(_store, invoice, field, value)


@mcp.tool()
def run_pipeline() -> dict:
    """Read the configured mailbox/sample and run the full deterministic pipeline
    (collect -> type -> extract/OCR -> fields -> validate -> dedup -> canonical JSON -> store).
    Returns a summary of accepted / needs_review / duplicate / not_invoice counts."""
    from cli import _load_pipeline_provider
    from pipeline import build_pipeline

    loaded = _load_pipeline_provider(CONFIG_DIR)
    if loaded[0] is None:
        return {"error": "could not load mail provider — check config/attachments.yaml"}
    cfgs, provider, _cfg = loaded
    pipeline = build_pipeline(cfgs, store=_store)
    _records, summary = pipeline.run(provider)
    return {
        "total": summary.total,
        "accepted": summary.accepted,
        "needs_review": summary.needs_review,
        "duplicate": summary.duplicate,
        "not_invoice": summary.not_invoice,
    }


@mcp.tool()
def review_queue(limit: int = 200) -> list[dict]:
    """The manual-review queue, enriched for a human reviewer: each needs_review invoice with its
    extracted fields, WHY it was flagged (validation reasons), confidence, and source doc type."""
    return tools.review_queue(_store, limit=limit)


@mcp.tool()
def get_attachment(doc_id: str) -> dict:
    """The ORIGINAL document behind an extracted invoice: PDF/image bytes as base64
    (`content_base64`), or `text` for email-body / XML / JSON e-invoices, plus filename + mime type.
    Lets a reviewer compare what the pipeline read against the actual source document."""
    from cli import _load_pipeline_provider

    loaded = _load_pipeline_provider(CONFIG_DIR)
    if loaded[0] is None:
        return {"error": "document provider unavailable — check config/attachments.yaml"}
    _cfgs, provider, _cfg = loaded
    return tools.get_attachment(provider, doc_id)


def _run_http_with_auth(transport: str, token: str) -> None:
    """Serve the HTTP/SSE app but reject any request without ``Authorization: Bearer <token>``.

    A thin edge guard so a public (tunnelled) URL can't be read by anyone who merely knows it.
    """
    import uvicorn
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    class _BearerAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.headers.get("authorization", "") != f"Bearer {token}":
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return await call_next(request)

    app = mcp.sse_app() if transport == "sse" else mcp.streamable_http_app()
    app.add_middleware(_BearerAuth)
    uvicorn.run(app, host=mcp.settings.host, port=mcp.settings.port)


def main() -> None:
    """Run the MCP server.

    Transport is chosen by the ``INVOICE_MCP_TRANSPORT`` env var:
      * ``stdio`` (default) — Claude Desktop launches it locally via a command.
      * ``sse`` / ``streamable-http`` — serve a REMOTE URL a Claude client connects to
        (``http://HOST:PORT/sse`` or ``/mcp``). Set ``INVOICE_MCP_HOST=0.0.0.0`` for LAN/tunnel.
        Set ``INVOICE_MCP_TOKEN`` to require ``Authorization: Bearer <token>`` on every request —
        essential before exposing the URL beyond localhost.
    """
    transport = os.environ.get("INVOICE_MCP_TRANSPORT", "stdio").lower()
    token = os.environ.get("INVOICE_MCP_TOKEN")
    if transport == "stdio":
        mcp.run()
    elif token:
        _run_http_with_auth(transport, token)
    else:
        mcp.run(transport=transport)


if __name__ == "__main__":
    main()
