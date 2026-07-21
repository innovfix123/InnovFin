/**
 * Minimal, dependency-free ZIP reader for the Drive tools.
 *
 * 291 archives sit in the connected folder and real invoice sets are stored that way
 * (`CFInvoices.zip`, `1. Purchase Invoices- Apr'26.zip`). Without this, a question whose answer is
 * inside one of them cannot be answered at all — the tools could only say "open the link".
 *
 * Reads the central directory rather than scanning local headers, so listing is cheap and correct even
 * when entries were streamed. Only STORE (0) and DEFLATE (8) are supported — those cover essentially
 * every archive produced by Windows, macOS, Drive and the usual tooling; anything else is reported by
 * name instead of guessed at.
 *
 * Everything is bounded on purpose: a hostile or merely careless archive should not be able to exhaust
 * this process's memory. See MAX_ENTRIES / MAX_ENTRY_BYTES / MAX_TOTAL_BYTES.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

/** Caps. A 2 GB entry inside a 3 MB archive is a zip bomb, not a document. */
const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** Directory markers are listed but hold nothing to read. */
  isDirectory: boolean;
  encrypted: boolean;
  /** null when the compression method is one we don't decode. */
  method: "store" | "deflate" | null;
  offset: number;
}

export class ZipError extends Error {}

/** Locate the End Of Central Directory record, which lives at the very end (after any comment). */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError("Not a ZIP archive (no end-of-central-directory record found).");
}

export function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  // Zip64 archives put the real offsets elsewhere; say so rather than mis-reading 32-bit fields.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new ZipError("ZIP64 archive — too large or too many entries for this reader. Download it instead.");
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count && i < MAX_ENTRIES; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ZipError("Corrupt ZIP: central directory entry not where the archive says it is.");
    }
    const flags = buf.readUInt16LE(p + 8);
    const methodCode = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      isDirectory: name.endsWith("/"),
      encrypted: (flags & 0x1) === 1,
      method: methodCode === 0 ? "store" : methodCode === 8 ? "deflate" : null,
      offset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Raw bytes of one entry, decompressed. Throws a ZipError the caller can surface verbatim. */
export function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.isDirectory) throw new ZipError(`"${entry.name}" is a folder inside the archive, not a file.`);
  if (entry.encrypted) throw new ZipError(`"${entry.name}" is password-protected — it cannot be read here.`);
  if (entry.method === null) throw new ZipError(`"${entry.name}" uses an unsupported compression method.`);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError(`"${entry.name}" is ${(entry.uncompressedSize / 1024 / 1024).toFixed(1)} MB uncompressed — too large to read here.`);
  }

  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new ZipError(`Corrupt ZIP: "${entry.name}" is not at the offset the archive claims.`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === "store") return Buffer.from(data);
  try {
    // maxOutputLength makes zlib itself refuse a decompression bomb rather than us noticing afterwards.
    return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch (e) {
    throw new ZipError(`Could not decompress "${entry.name}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Guard applied before an archive is even downloaded/parsed. */
export function assertArchiveSize(bytes: number): void {
  if (bytes > MAX_TOTAL_BYTES) {
    throw new ZipError(`Archive is ${(bytes / 1024 / 1024).toFixed(0)} MB — too large to open here. Download it instead.`);
  }
}

export const ZIP_LIMITS = { MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES };
