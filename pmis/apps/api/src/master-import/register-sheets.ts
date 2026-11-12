import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OoxmlWorkbook, SheetCell } from './ooxml-reader';

/**
 * Migration 0088 (owner decision 2026-11-12, "Everything from the one file"; CHANGELOG 130): the register sheets of the owner's Site Master (RF & Design,
 * Acquisition, Permission Log, PR-PO, GECOL, HLC, As-Built, Risk Register), read from the file stored with the import run and mapped onto the columns of the
 * register templates GSDN Workspace issues (TPL-RF ... TPL-RSK).
 *
 * The mapping is data, one source of truth: `register-maps/` beside this file (index.csv and one CSV per register), the same files the offline helper
 * `tools/master-import/fill-templates.py` reads. The normalisation is the helper's, mechanical only: spaces, Site IDs trimmed and upper-cased, dates typed
 * as text (an ambiguous dd/mm is read day first and noted), numbers typed as text, list values to the list's own case (y / n to Yes / No on a Yes/No list),
 * N/A, Pending and Cancelled in a date or number cell to blank, "Open-ended" to No. Everything else is passed as found, and the database refuses it on its row.
 * Personal columns (landlord, contact person, phone, e-mail; decision Q469) are never read: their cells are not even looked at.
 * Nothing here trusts the file: the cells are values only (a formula is read as the value Excel cached for it, as the helper reads the file data_only, and
 * is never evaluated); an error value (#N/A ...) is a blank cell.
 */

export interface RegisterMapColumn { template_header: string; master_header: string; master_column: string; transform: string; personal: string }
export interface RegisterMap {
  register: string; template_id: string; master_sheet: string; header_row: number; first_data_row: number; site_header: string; key_headers: string;
  site_scoped: boolean; columns: RegisterMapColumn[];
}
/** One column of a register template as template_versions.columns holds it. */
export interface TemplateColumn { code: string; kind: string; type: string; header: string; derived?: boolean; options?: string[] }
export interface RegisterTemplate { template_id: string; register_key: string; version: number; columns: TemplateColumn[] }

export interface RegisterRow {
  row_no: number; sheet: string; site_code?: string; record_type?: string; data: Record<string, unknown>; custom: Record<string, unknown>;
  pre_errors: { column: string; field: string; code: string; message: string }[];
}
export interface RegisterPart { register: string; template_id: string; sheet: string; rows: RegisterRow[] }
export interface RegisterSkip { sheet: string; kind: 'register'; ref: string; reason: string; detail: string }
/** A note about the mapping of a sheet (never blocking): counts and cell addresses only, never a value. */
export interface RegisterNote { sheet: string; ref: string; code: string; count: number; cells?: string[]; headers?: string[] }
export interface RegisterSheets { parts: RegisterPart[]; skipped: RegisterSkip[]; notes: RegisterNote[] }

export const REGISTER_MAX_ROWS = 5000;
const BLANK_TOKENS = new Set(['n/a', 'na', 'pending', 'cancelled', 'canceled']);
const PERSONAL_HEADER = /landlord|contact|phone|e-?mail/i;
const OPEN_ENDED = new Set(['open-ended', 'open ended', 'openended']);
const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NOTE_CELLS = 25;

/** The folder of the maps: beside the compiled file (the build copies it) or in the sources. */
export function registerMapsDir(): string {
  const here = join(__dirname, 'register-maps');
  if (existsSync(join(here, 'index.csv'))) return here;
  return resolve(__dirname, '..', '..', 'src', 'master-import', 'register-maps');
}

/** One CSV line, with double-quoted fields. */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** A mapping CSV: comment lines (#) skipped; extra fields after the header's are ignored (as csv.DictReader of the helper drops them). */
function readCsv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  const head = csvLine(lines[0] ?? '');
  return lines.slice(1).map((l) => {
    const f = csvLine(l);
    const o: Record<string, string> = {};
    head.forEach((h, i) => { if (h) o[h] = f[i] ?? ''; });
    return o;
  });
}

export function loadRegisterMaps(dir = registerMapsDir()): RegisterMap[] {
  return readCsv(join(dir, 'index.csv')).map((r) => ({
    register: r.register ?? '', template_id: r.template_id ?? '', master_sheet: r.master_sheet ?? '', header_row: Number(r.header_row), first_data_row: Number(r.first_data_row),
    site_header: r.site_header ?? '', key_headers: r.key_headers ?? '', site_scoped: (r.site_scoped ?? 'yes').toLowerCase() !== 'no',
    columns: readCsv(join(dir, `${r.register}.csv`)).map((c) => ({
      template_header: c.template_header ?? '', master_header: c.master_header ?? '', master_column: c.master_column ?? '', transform: c.transform ?? '', personal: c.personal ?? '',
    })),
  }));
}

export const normHeader = (v: unknown): string => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const cleanText = (s: string): string => s.replace(/[ \t\u00a0]+/g, ' ').trim();
export const isPersonal = (m: RegisterMapColumn): boolean => m.personal.toLowerCase() === 'yes' || PERSONAL_HEADER.test(m.template_header);

const iso = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};
const excelDate = (serial: number): string => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).toISOString().slice(0, 10);

/** A date typed as text (the helper's parse_date_text): the date, and whether day and month were both 12 or less (read day first). */
export function parseDateText(s: string): { date: string | null; assumed: boolean } {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(t);
  if (m) return { date: iso(Number(m[1]), Number(m[2]), Number(m[3])), assumed: false };
  m = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf((m[2] as string).slice(0, 3).toLowerCase());
    return { date: mi >= 0 ? iso(Number(m[3]), mi + 1, Number(m[1])) : null, assumed: false };
  }
  m = /^([A-Za-z]{3,9}) (\d{1,2}), (\d{4})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase());
    return { date: mi >= 0 ? iso(Number(m[3]), mi + 1, Number(m[2])) : null, assumed: false };
  }
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(t);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]); const y = Number(m[3]);
    if (a > 12 && b <= 12) return { date: iso(y, b, a), assumed: false };
    if (b > 12 && a <= 12) return { date: iso(y, a, b), assumed: false };
    if (a === b) return { date: iso(y, a, b), assumed: false };
    if (a <= 12 && b <= 12) return { date: iso(y, b, a), assumed: true };
  }
  return { date: null, assumed: false };
}

type Norm = { value?: unknown; note?: 'date_day_first_assumed' | 'not_normalised' | 'outside_list' };

/** One value under the type of its template column (the helper's normalise, then the typing of a template upload). undefined = blank. */
export function normaliseValue(raw: string | number | boolean, col: TemplateColumn): Norm {
  let v: string | number | boolean = raw;
  if (typeof v === 'string') {
    v = cleanText(v);
    if (v === '') return {};
  }
  switch (col.type) {
    case 'date': {
      if (typeof v === 'number') return v > 0 && v < 100000 ? { value: excelDate(v) } : { value: String(v), note: 'not_normalised' };
      if (typeof v === 'boolean') return { value: String(v), note: 'not_normalised' };
      if (BLANK_TOKENS.has(v.toLowerCase())) return {};
      const d = parseDateText(v);
      if (d.date) return d.assumed ? { value: d.date, note: 'date_day_first_assumed' } : { value: d.date };
      return { value: v, note: 'not_normalised' };
    }
    case 'number': {
      if (typeof v === 'number') return { value: v };
      if (typeof v === 'boolean') return { value: String(v), note: 'not_normalised' };
      if (BLANK_TOKENS.has(v.toLowerCase())) return {};
      if (NUMBER.test(v)) return { value: Number(v) };
      return { value: v, note: 'not_normalised' };
    }
    case 'yes_no': {
      if (typeof v === 'boolean') return { value: v };
      const w = String(v).trim().toLowerCase();
      if (TRUE_WORDS.has(w)) return { value: true };
      if (FALSE_WORDS.has(w)) return { value: false };
      return { value: String(v), note: 'not_normalised' };
    }
    default: {
      const s = typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v;
      if (col.type === 'list' && Array.isArray(col.options) && col.options.length > 0) {
        if (col.options.includes(s)) return { value: s };
        const hit = col.options.find((o) => o.toLowerCase() === s.toLowerCase());
        if (hit) return { value: hit };
        const low = col.options.map((o) => o.toLowerCase());
        if (low.includes('yes') && low.includes('no') && col.options.length <= 3) {
          if (['y', 'true', '1'].includes(s.toLowerCase())) return { value: col.options[low.indexOf('yes')] };
          if (['n', 'false', '0'].includes(s.toLowerCase())) return { value: col.options[low.indexOf('no')] };
        }
        return { value: s, note: 'outside_list' };
      }
      return { value: s };
    }
  }
}

const cellValue = (c: SheetCell | undefined): string | number | boolean | null => {
  if (!c || c.e || c.v === null || c.v === undefined) return null;
  if (typeof c.v === 'string' && c.v.trim() === '') return null;
  return c.v;
};

/** The sheet names the maps read (the reader inflates only those parts). */
export const registerSheetNames = (maps: RegisterMap[]): string[] => [...new Set(maps.map((m) => m.master_sheet))];

/**
 * Reads the register sheets of a workbook. `templates` holds the current version of each register template (by template_id). A sheet that is missing, a
 * template that is not in use, or a sheet whose Site ID column is not found is skipped with a reason; nothing else stops the read. A row is kept when it has
 * a Site ID (Risk ID for the Risk Register) or a typed value in a mapped column: the database refuses on its row what it cannot read (no Site ID, an unknown
 * site, a value outside a list ...).
 */
export function readRegisterSheets(wb: OoxmlWorkbook, maps: RegisterMap[], templates: Map<string, RegisterTemplate>, maxRows = REGISTER_MAX_ROWS): RegisterSheets {
  const out: RegisterSheets = { parts: [], skipped: [], notes: [] };
  for (const map of maps) {
    const skip = (reason: string, detail: string) => out.skipped.push({ sheet: map.master_sheet, kind: 'register', ref: map.register, reason, detail });
    const tpl = templates.get(map.template_id);
    if (!tpl) { skip('template_unknown_or_inactive', `The register template ${map.template_id} is not in use: the sheet was not read.`); continue; }
    if (!wb.sheetNames.includes(map.master_sheet)) { skip('sheet_missing', `The file has no sheet "${map.master_sheet}".`); continue; }
    const sheet = wb.sheet(map.master_sheet, map.first_data_row + maxRows + 1, 400);
    if (!sheet) { skip('sheet_unreadable', `The sheet "${map.master_sheet}" could not be read.`); continue; }
    const head = sheet.rows.get(map.header_row) ?? new Map<string, SheetCell>();
    const byHeader = new Map<string, string>();
    for (const [L, c] of [...head.entries()].sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]))) {
      const h = normHeader(cellValue(c));
      if (h && !byHeader.has(h)) byHeader.set(h, L);
    }
    const tcols = new Map(tpl.columns.map((c) => [normHeader(c.header), c]));
    const plan: { col: TemplateColumn; src: string | null; map: RegisterMapColumn }[] = [];
    const notFound: string[] = [];
    const unknown: string[] = [];
    for (const m of map.columns) {
      const col = tcols.get(normHeader(m.template_header));
      if (!col) { unknown.push(m.template_header); continue; }
      if (isPersonal(m)) continue;                                  // Q469: never read
      if (col.derived || col.kind === 'record_id') continue;        // grey columns and Record ID are never filled
      let src: string | null = null;
      if (m.master_header) {
        src = m.master_header.split('|').map((a) => byHeader.get(normHeader(a))).find((x) => x !== undefined) ?? null;
        if (src === null) notFound.push(m.template_header);
      }
      if (src === null && !m.transform.startsWith('const:')) continue;
      plan.push({ col, src, map: m });
    }
    if (notFound.length) out.notes.push({ sheet: map.master_sheet, ref: map.register, code: 'master_header_not_found', count: notFound.length, headers: notFound });
    if (unknown.length) out.notes.push({ sheet: map.master_sheet, ref: map.register, code: 'map_unknown_template_header', count: unknown.length, headers: unknown });
    const site = plan.find((p) => normHeader(p.col.header) === normHeader(map.site_header));
    if (!site || site.src === null) { skip('site_column_missing', `The sheet "${map.master_sheet}" has no "${map.site_header}" column: it was not read.`); continue; }

    const dataRows = [...sheet.rows.keys()].filter((n) => n >= map.first_data_row).sort((a, b) => a - b);
    const rows: RegisterRow[] = [];
    const noted = new Map<string, string[]>();
    const note = (code: string, cell: string) => { const l = noted.get(code) ?? []; l.push(cell); noted.set(code, l); };
    let tooMany = false;
    for (const n of dataRows) {
      const cells = sheet.rows.get(n) as Map<string, SheetCell>;
      // a row counts when it has its key, or a value typed in a mapped column (a row of formulas only is the sheet's own layout)
      const siteRaw = cellValue(cells.get(site.src));
      const typed = plan.some((p) => p.src !== null && p !== site && cellValue(cells.get(p.src)) !== null && !cells.get(p.src)?.f);
      if (siteRaw === null && !typed) continue;
      if (rows.length >= maxRows) { tooMany = true; break; }
      const row: RegisterRow = { row_no: n, sheet: map.master_sheet, data: {}, custom: {}, pre_errors: [] };
      for (const p of plan) {
        const addr = p.src ? `${p.src}${n}` : `${map.master_sheet}!${n}`;
        const target = p.col.kind === 'custom' ? row.custom : row.data;
        const raw = p.src ? cellValue(cells.get(p.src)) : null;
        if (p.src && cells.get(p.src)?.e) note('cell_error_blank', addr);
        if (p.map.transform === 'record_type_po_pr') {
          // Q494: PO / WO No. filled = the po record type, otherwise pr
          row.record_type = raw !== null && cleanText(String(raw)) !== '' ? 'po' : 'pr';
          continue;
        }
        if (p.map.transform.startsWith('const:')) {
          const v = p.map.transform.slice('const:'.length).trim();
          if (p.col.kind === 'record_type') row.record_type = v; else target[p.col.code] = v;
          continue;
        }
        if (raw === null) continue;
        if (p === site || p.map.transform === 'site_id') {
          const id = cleanText(String(raw)).toUpperCase();
          if (p.col.kind === 'site') row.site_code = id; else target[p.col.code] = id;
          continue;
        }
        if (typeof raw === 'string' && raw.trim().startsWith('=')) {
          row.pre_errors.push({ column: p.col.header, field: p.col.code, code: 'formula_not_allowed', message: 'Text that starts with "=" is not accepted.' });
          continue;
        }
        let r: Norm;
        if (p.map.transform === 'open_ended_no' && typeof raw === 'string' && OPEN_ENDED.has(cleanText(raw).toLowerCase())) r = normaliseValue('No', p.col);
        else r = normaliseValue(raw, p.col);
        if (r.note) note(r.note, addr);
        if (r.value === undefined) continue;
        if (p.col.kind === 'record_type') row.record_type = String(r.value); else target[p.col.code] = r.value;
      }
      rows.push(row);
    }
    if (tooMany) { skip('size_or_rows_exceeded', `The sheet "${map.master_sheet}" has more than ${maxRows} rows.`); continue; }
    for (const [code, cells] of noted) out.notes.push({ sheet: map.master_sheet, ref: map.register, code, count: cells.length, cells: cells.slice(0, NOTE_CELLS) });
    if (rows.length === 0) { skip('no_rows', `The sheet "${map.master_sheet}" has no data rows.`); continue; }
    out.parts.push({ register: map.register, template_id: map.template_id, sheet: map.master_sheet, rows });
  }
  return out;
}

