import { strFromU8, unzipSync } from 'fflate';

/**
 * A small read-only reader of an .xlsx package for the legacy Master import (Q1). The real Site Master holds Excel tables that the template
 * library (exceljs 4.4) cannot load, and it never needs to be parsed as a whole: only the sheet names, the header rows and values of the Master
 * sheet and the Project Staff block of the Setting sheet are read. Only those package parts are inflated. Formulas are never evaluated: a
 * formula cell is reported as such, with the value Excel cached for it (used only to compare, never written).
 * Call guardXlsx() first: it refuses macros, embedded objects, external links and zip bombs before this reader runs.
 */

export interface SheetCell {
  /** The value: a string, a number, a boolean, or an ISO date (yyyy-mm-dd) for a number in a date format. */
  v: string | number | boolean | null;
  /** The cell held a formula (v is its cached result). */
  f: boolean;
  /** The cell holds an error value (#N/A ...). */
  e?: boolean;
}

export interface SheetData {
  name: string;
  /** rows[rowNumber][columnLetter] */
  rows: Map<number, Map<string, SheetCell>>;
}

export class OoxmlError extends Error {}

const decodeXml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, g: string) => {
    switch (g) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return g.startsWith('#x') ? String.fromCodePoint(parseInt(g.slice(2), 16)) : String.fromCodePoint(parseInt(g.slice(1), 10));
    }
  });

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1] as string) : undefined;
};

/** Text of an <si> or <is> element: plain <t> or the runs of rich text (phonetic runs are skipped). */
function richText(xml: string): string {
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noPh))) out += decodeXml(m[1] ?? '');
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code: string): boolean {
  const s = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmy]/i.test(s) && !/^[#0.,% ]*$/.test(s);
}

const excelDate = (serial: number): string => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).toISOString().slice(0, 10);

export const colIndex = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
export const colLetter = (index: number): string => {
  let s = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export class OoxmlWorkbook {
  readonly sheetNames: string[];
  private readonly sheetPaths = new Map<string, string>();
  private readonly files: Record<string, Uint8Array>;
  private shared: string[] | null = null;
  private dateStyles: boolean[] | null = null;

  constructor(buf: Buffer, wantedSheets: string[]) {
    // the package directory first (workbook and relationships), then only the parts of the wanted sheets
    let meta: Record<string, Uint8Array>;
    try {
      meta = unzipSync(buf, { filter: (f) => ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml'].includes(f.name) });
    } catch {
      throw new OoxmlError('not a zip package');
    }
    const wb = meta['xl/workbook.xml'];
    const rels = meta['xl/_rels/workbook.xml.rels'];
    if (!wb || !rels) throw new OoxmlError('no workbook part');
    const relXml = strFromU8(rels);
    const target = new Map<string, string>();
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attr(m[0], 'Id');
      const t = attr(m[0], 'Target');
      if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`);
    }
    this.sheetNames = [];
    for (const m of strFromU8(wb).matchAll(/<sheet\b[^>]*>/g)) {
      const name = attr(m[0], 'name');
      const rid = attr(m[0], 'r:id');
      if (!name) continue;
      this.sheetNames.push(name);
      const p = rid ? target.get(rid) : undefined;
      if (p) this.sheetPaths.set(name, p);
    }
    const parts = new Set(wantedSheets.map((n) => this.sheetPaths.get(n)).filter((x): x is string => !!x));
    this.files = { ...meta, ...unzipSync(buf, { filter: (f) => parts.has(f.name) }) };
  }

  private sharedStrings(): string[] {
    if (this.shared) return this.shared;
    const part = this.files['xl/sharedStrings.xml'];
    this.shared = part ? [...strFromU8(part).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1] as string)) : [];
    return this.shared;
  }

  private dates(): boolean[] {
    if (this.dateStyles) return this.dateStyles;
    const part = this.files['xl/styles.xml'];
    const out: boolean[] = [];
    if (part) {
      const xml = strFromU8(part);
      const custom = new Map<number, string>();
      for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
        const id = Number(attr(m[0], 'numFmtId'));
        const code = attr(m[0], 'formatCode');
        if (Number.isFinite(id) && code) custom.set(id, code);
      }
      const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
      for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
        const id = Number(attr(m[0], 'numFmtId') ?? '0');
        out.push(BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id) as string)));
      }
    }
    this.dateStyles = out;
    return out;
  }

  /** Reads the cells of one sheet, rows 1 to maxRow, columns 1 to maxCol. Missing sheet: null. */
  sheet(name: string, maxRow = 6000, maxCol = 400): SheetData | null {
    const path = this.sheetPaths.get(name);
    const part = path ? this.files[path] : undefined;
    if (!part) return null;
    const xml = strFromU8(part);
    const ss = this.sharedStrings();
    const ds = this.dates();
    const rows = new Map<number, Map<string, SheetCell>>();
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rn = Number(attr(rm[1] as string, 'r'));
      if (!Number.isFinite(rn) || rn > maxRow) continue;
      const cells = new Map<string, SheetCell>();
      let m: RegExpExecArray | null;
      cellRe.lastIndex = 0;
      const body = rm[2] as string;
      while ((m = cellRe.exec(body))) {
        const a = m[1] as string;
        const ref = attr(a, 'r');
        if (!ref) continue;
        const letters = /^([A-Z]+)/.exec(ref)?.[1];
        if (!letters || colIndex(letters) > maxCol) continue;
        const inner = m[2] ?? '';
        const t = attr(a, 't');
        const s = Number(attr(a, 's') ?? '0');
        const f = /<f\b/.test(inner);
        const vRaw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let v: SheetCell['v'] = null;
        let e = false;
        if (t === 's' && vRaw !== undefined) v = ss[Number(vRaw)] ?? null;
        else if (t === 'inlineStr') v = richText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
        else if (t === 'str') v = vRaw !== undefined ? decodeXml(vRaw) : null;
        else if (t === 'b') v = vRaw === '1';
        else if (t === 'e') { e = true; v = vRaw !== undefined ? decodeXml(vRaw) : null; }
        else if (vRaw !== undefined && vRaw !== '') {
          const n = Number(vRaw);
          v = Number.isFinite(n) ? (ds[s] && n > 0 && n < 100000 ? excelDate(n) : n) : decodeXml(vRaw);
        }
        if (typeof v === 'string') {
          // eslint-disable-next-line no-control-regex
          v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
          if (!f && v.trim() === '') v = null;
        }
        if (v === null && !f) continue;
        cells.set(letters, e ? { v, f, e } : { v, f });
      }
      if (cells.size) rows.set(rn, cells);
    }
    return { name, rows };
  }
}

const text = (c: SheetCell | undefined): string | null => (c && c.v !== null && c.v !== undefined && !c.e ? String(c.v).trim() || null : null);

/**
 * The header of each column of the Master sheet: the three header rows (group, sub-group, name) become "sub-group / name", or the sub-group (or the
 * group) alone when the column has no name, as master_columns stores them. A merged sub-group cell only fills its first column: it is carried to the right
 * until the next one.
 */
export function masterHeaders(sheet: SheetData, width = 260): { col: string; header: string }[] {
  const r1 = sheet.rows.get(1) ?? new Map<string, SheetCell>();
  const r2 = sheet.rows.get(2) ?? new Map<string, SheetCell>();
  const r3 = sheet.rows.get(3) ?? new Map<string, SheetCell>();
  const out: { col: string; header: string }[] = [];
  let mid: string | null = null;
  for (let i = 1; i <= width; i++) {
    const L = colLetter(i);
    const top = text(r1.get(L));
    const m2 = text(r2.get(L));
    const name = text(r3.get(L));
    if (m2) mid = m2;
    else if (top) mid = null;
    const header = name ? (m2 ?? mid ? `${m2 ?? mid} / ${name}` : name) : m2 ?? top;
    if (header) out.push({ col: L, header });
  }
  return out;
}
