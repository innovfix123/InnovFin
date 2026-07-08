/**
 * Purchase/Vendor TDS classifier (194C / 194J / 194I / 194H on inbound vendor invoices).
 * Engine per InnovFin-Purchase-TDS-Classification-Spec.md §10 ("build now"); tax rules in config.ts
 * are ⚠ PENDING SHOYAB — validated before anything is locked for filing. Not yet wired to a live
 * MCP endpoint or the invoice store (next step, after config sign-off).
 */
export * from "./types";
export * from "./config";
export * from "./classify";
export * from "./compute";
