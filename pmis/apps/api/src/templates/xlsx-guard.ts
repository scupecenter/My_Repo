import { inflateRawSync } from 'node:zlib';
import { strFromU8, strToU8, zipSync } from 'fflate';

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
  // one disk only, and no zip64 locator in front of the end record: Excel never writes either, and another parser could read them differently
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== buf.readUInt16LE(eocd + 10)) return null;
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) return null;
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

/**
 * Why a workbook that passed the guard could not be parsed, in words the user can act on (owner report 2026-11-09).
 * `logged` is a short technical cause for the System Log (first line of the parser error, no cell values).
 */
export function explainUnreadable(buf: Buffer, err: unknown): { detail: string; logged: string } {
  const msg = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
  const logged = msg.slice(0, 200);
  const entries = readDirectory(buf);
  const wb = entries?.find((e) => e.name === 'xl/workbook.xml');
  const wbXml = wb ? readSmall(buf, wb) : null;
  if (wbXml !== null && /purl\.oclc\.org\/ooxml\/spreadsheetml/i.test(wbXml)) {
    return { logged: logged || 'strict_ooxml', detail: 'The file was saved as "Strict Open XML Spreadsheet". In Excel choose File › Save As › "Excel Workbook (*.xlsx)" and upload it again.' };
  }
  if (/shared formula/i.test(msg)) {
    return { logged, detail: 'The file has formulas copied across cells. Paste the data as values only (Paste Special › Values), save as "Excel Workbook (*.xlsx)" and upload it again.' };
  }
  return { logged, detail: 'The file could not be read as an Excel workbook. Open it in Excel, paste the data as values only (no formulas), save it as "Excel Workbook (*.xlsx)" and upload it again.' };
}

const SSML_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/**
 * Some programs other than desktop Excel (for example exports written with the OpenXML SDK) bind the SpreadsheetML namespace to a prefix
 * (`<x:workbook xmlns:x="…">`). The XML is valid, but the readers here match the plain element names, so such a file reads as having no
 * sheets ("Cannot read properties of undefined (reading 'sheets')", owner report 2026-11-09). This rewrites only the XML parts of `xl/`
 * whose SpreadsheetML elements carry a prefix, to the plain form Excel itself writes, and returns the repacked package; null when nothing
 * needed it. Call it only on a buffer that passed guardXlsx, and run guardXlsx again on the result before any parser sees it.
 */
export function normalizeSpreadsheetPrefixes(buf: Buffer): Buffer | null {
  const entries = readDirectory(buf);
  const wb = entries?.find((e) => e.name === 'xl/workbook.xml');
  const wbXml = wb ? readSmall(buf, wb) : null;
  if (wbXml === null || !prefixFor(wbXml)) return null;
  // Rebuild the package from the entries guardXlsx already checked (this module's own directory reader), never from a second ZIP parser:
  // each entry is inflated to exactly its verified size, and a duplicate name or an unreadable entry stops the rewrite.
  if (!entries) return null;
  const files: Record<string, Uint8Array> = {};
  let changed = false;
  for (const e of entries) {
    if (Object.prototype.hasOwnProperty.call(files, e.name)) return null;
    const data = entryBytes(buf, e);
    if (data === null) return null;
    files[e.name] = data;
    if (!e.name.startsWith('xl/') || !e.name.endsWith('.xml')) continue;
    const text = strFromU8(data);
    const p = prefixFor(text);
    if (!p) continue;
    files[e.name] = strToU8(unprefix(text, p));
    changed = true;
  }
  return changed ? Buffer.from(zipSync(files, { level: 6 })) : null;
}

/** The bytes of one checked entry, inflated to exactly its declared size (the size guardXlsx verified); null otherwise. */
function entryBytes(buf: Buffer, e: Entry): Uint8Array | null {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.compressed > buf.length) return null;
  const raw = buf.subarray(start, start + e.compressed);
  try {
    const out = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }) : null;
    return out !== null && out.length === e.size ? new Uint8Array(out) : null;
  } catch {
    return null;
  }
}

/** The prefix bound to the SpreadsheetML main namespace on the root element, when that root has no default namespace of its own. */
function prefixFor(xml: string): string | null {
  const root = /<([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\b[^>]*>/.exec(xml.replace(/^\uFEFF?(<\?xml[^>]*\?>\s*)?/, ''));
  if (!root) return null;
  const p = root[1]!;
  const tag = root[0];
  if (!tag.includes(`xmlns:${p}="${SSML_MAIN}"`) || /\sxmlns="/.test(tag)) return null;
  return p;
}

function unprefix(xml: string, p: string): string {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xml
    .replace(new RegExp(`<(/?)${esc}:`, 'g'), '<$1')
    .replace(`xmlns:${p}="${SSML_MAIN}"`, `xmlns="${SSML_MAIN}"`);
}
