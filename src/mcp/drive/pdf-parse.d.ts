/**
 * Minimal ambient types for pdf-parse's inner module. We import `pdf-parse/lib/pdf-parse.js` directly
 * (not the package index, whose debug branch reads a bundled test PDF when `module.parent` is falsy —
 * which happens under Next's bundler and would crash at import). pdf-parse ships no type declarations.
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
    version?: string;
  }
  const pdfParse: (dataBuffer: Buffer, options?: Record<string, unknown>) => Promise<PdfParseResult>;
  export default pdfParse;
}
