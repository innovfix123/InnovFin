/**
 * A small RFC4180 CSV reader for the reconciliation layer.
 *
 * Written rather than pulled in as a dependency: this repo is a live production system and a
 * read-only recon module is not worth a new supply-chain edge.
 *
 * It STREAMS. PhonePe's June forward-transaction export alone is 143 MB / 441k rows, and the
 * merchant reports for one month total well over 400 MB. Materialising a `Record<string,string>`
 * per row — 55 columns each — exhausts the heap long before the month is read. `openCsv()`
 * therefore resolves the column indices ONCE from the header and then yields raw cell arrays that
 * the caller reads by index and discards. Nothing accumulates but the caller's own output.
 */

/** Split one CSV line into fields, honouring "quoted, fields" and "" escapes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

const normKey = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "");

export interface CsvCursor {
  headers: string[];
  /**
   * Index of a column by any of several candidate names, case- and space-insensitively; -1 if
   * absent. PhonePe spells the same column three different ways across its three report formats
   * ("Merchant Id" / "Merchant ID", a leading space on " PhonePe Transaction Reference Id"), so
   * every lookup goes through here rather than indexing a literal key.
   */
  index(...names: string[]): number;
  /** Data rows as raw cell arrays, one at a time. Nothing is retained between iterations. */
  rows(): Generator<string[]>;
}

/**
 * Open CSV text for streaming reads.
 *
 * Headers are resolved SEPARATELY from the rows, and deliberately so: a report can legitimately be
 * header-only. PhonePe's three June-2026 refund exports are exactly that — one header line and
 * nothing else, because there were no refunds. If the format had to be inferred from the first data
 * row, an empty file would be indistinguishable from an unrecognised one, and a month that DID have
 * refunds could be misread as a file we don't understand and silently ignored.
 */
export function openCsv(text: string): CsvCursor {
  const lines = text.split(/\r?\n/);
  let h = 0;
  while (h < lines.length && lines[h].trim() === "") h++;

  const headers = h < lines.length ? splitLine(lines[h]).map((s) => s.trim()) : [];
  const byNorm = new Map<string, number>();
  headers.forEach((name, i) => {
    const k = normKey(name);
    if (k && !byNorm.has(k)) byNorm.set(k, i);
  });
  const start = h + 1;

  return {
    headers,
    index(...names: string[]): number {
      for (const n of names) {
        const i = byNorm.get(normKey(n));
        if (i !== undefined) return i;
      }
      return -1;
    },
    *rows(): Generator<string[]> {
      for (let i = start; i < lines.length; i++) {
        if (lines[i].trim() === "") continue;
        yield splitLine(lines[i]);
      }
    },
  };
}

export interface Csv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Eager object-per-row read. Convenient for small files; do NOT use on a gateway month export. */
export function readCsv(text: string): Csv {
  const cur = openCsv(text);
  const rows: Record<string, string>[] = [];
  for (const cells of cur.rows()) {
    const row: Record<string, string> = {};
    for (let j = 0; j < cur.headers.length; j++) row[cur.headers[j]] = (cells[j] ?? "").trim();
    rows.push(row);
  }
  return { headers: cur.headers, rows };
}

/** Read a column by any of several candidate names, case- and space-insensitively. */
export function col(row: Record<string, string>, ...names: string[]): string {
  for (const n of names) if (n in row) return row[n];
  const want = names.map(normKey);
  for (const k of Object.keys(row)) if (want.includes(normKey(k))) return row[k];
  return "";
}

/** Parse a money cell to a number. Blank / unparseable → 0. Strips ₹, commas and spaces. */
export function money(v: string): number {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Cell at `i`, trimmed. Out-of-range or missing → "". */
export function at(cells: string[], i: number): string {
  return i < 0 ? "" : (cells[i] ?? "").trim();
}
