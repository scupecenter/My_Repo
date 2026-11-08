import { inflateRawSync } from 'node:zlib';

/**
 * Safety checks on an uploaded workbook before any library parses it (file upload safety, CLAUDE.md "Approved templates only"):
 * it must be a plain OOXML workbook (.xlsx), never a macro-enabled one (.xlsm, a renamed file with a VBA project), and it must not expand to
 * an unreasonable size (zip bomb). The zip directory is read by hand, so a hostile file never reaches the parser first.
 */
export type GuardReject = 'not_xlsx' | 'macros_not_allowed' | 'size_or_rows_exceeded';

export interface GuardResult {
  ok: boolean;
  reason?: GuardReject;
  detail?: string;
}

interface Entry {
  name: string;
  compressed: number;
  size: number;
  method: number;
  offset: number;
}

const MAX_ENTRIES = 500;
export const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const MAX_RATIO = 200;

function readDirectory(buf: Buffer): Entry[] | null {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff) return null; // zip64: not produced by Excel for a data template
  if (count > MAX_ENTRIES || dirOffset + dirSize > buf.length) return null;
  const out: Entry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) return null;
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), compressed, size, method, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readSmall(buf: Buffer, e: Entry): string | null {
  if (e.size > 1024 * 1024 || e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.compressed);
  try {
    return (e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw, { maxOutputLength: 2 * 1024 * 1024 }) : null)?.toString('utf8') ?? null;
  } catch {
    return null;
  }
}

/** The real inflated size of an entry, inflating at most `budget` bytes; 'too_big' past it, -1 when it cannot be read. */
function realSize(buf: Buffer, e: Entry, budget: number): number | 'too_big' {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return -1;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.compressed > buf.length) return -1;
  const raw = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return raw.length;
  if (e.method !== 8) return -1;
  try {
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) }).length;
  } catch (err) {
    return (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_big' : -1;
  }
}

/** Anything in the package that can run or pull code or data from outside. */
const FORBIDDEN_PARTS = [/vbaproject/i, /^xl\/macrosheets\//i, /^xl\/dialogsheets\//i, /^xl\/activex\//i, /^xl\/embeddings\//i, /^xl\/externallinks\//i, /^xl\/ctrlprops\//i, /^xl\/vbaprojectsignature/i];

export function guardXlsx(fileName: string, buf: Buffer): GuardResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsm') || lower.endsWith('.xlsb') || lower.endsWith('.xls') || lower.endsWith('.xltm')) {
    return { ok: false, reason: 'macros_not_allowed', detail: 'Only plain .xlsx workbooks made from GSDN Workspace template are accepted (no macros, no .xls, .xlsb or .xlsm).' };
  }
  if (!lower.endsWith('.xlsx')) return { ok: false, reason: 'not_xlsx', detail: 'The file must be an .xlsx workbook.' };
  const entries = readDirectory(buf);
  if (!entries) return { ok: false, reason: 'not_xlsx', detail: 'The file is not a valid .xlsx workbook.' };
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (total > MAX_UNCOMPRESSED_BYTES || (e.size > 1024 * 1024 && e.compressed > 0 && e.size / e.compressed > MAX_RATIO)) {
      return { ok: false, reason: 'size_or_rows_exceeded', detail: 'The workbook expands to an unreasonable size.' };
    }
    // The declared sizes can lie: inflate the entry for real, never past what is left of the budget, and refuse a mismatch.
    const real = realSize(buf, e, MAX_UNCOMPRESSED_BYTES - (total - e.size));
    if (real === 'too_big') return { ok: false, reason: 'size_or_rows_exceeded', detail: 'The workbook expands to an unreasonable size.' };
    if (real !== e.size) return { ok: false, reason: 'not_xlsx', detail: 'The file is not a valid .xlsx workbook.' };
    if (FORBIDDEN_PARTS.some((re) => re.test(e.name))) {
      return { ok: false, reason: 'macros_not_allowed', detail: 'The workbook contains macros, embedded objects or external links, which are not accepted.' };
    }
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) return { ok: false, reason: 'not_xlsx', detail: 'The file is not an Excel workbook.' };
  const ct = entries.find((e) => e.name === '[Content_Types].xml');
  const text = ct ? readSmall(buf, ct) : null;
  if (text !== null && /macroEnabled|vbaProject|ms-office\.vbaProject/i.test(text)) {
    return { ok: false, reason: 'macros_not_allowed', detail: 'This is a macro-enabled workbook. Save it as a plain .xlsx.' };
  }
  return { ok: true };
}
