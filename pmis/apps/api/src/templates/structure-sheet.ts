import type ExcelJS from 'exceljs';

/**
 * Data entry proposals S1 and S2 (migration 0560): the "Structure" sheet of a register template. One row per column of the register, written from the same
 * source as the Settings > Registers > Columns screen (reg_fields_admin_json), so there are not two descriptions of a structure. Re-uploading the file never
 * changes the register: the rows become a structure proposal that a System Admin reviews and approves.
 */
export const STRUCTURE_SHEET = 'Structure';

export interface StructureField {
  code: string; label_en: string; label_ar: string | null; type: string; list_catalogue: string | null; required: boolean; sort_order: number; section: string | null;
  in_list: boolean; in_filter: boolean; in_template: boolean; in_export: boolean; is_active: boolean; is_system: boolean;
}

export const STRUCTURE_HEADERS = ['Code', 'Label EN', 'Label AR', 'Type', 'List', 'Required', 'Order', 'Section', 'In list', 'In filter', 'In template', 'In export', 'Active', 'System'] as const;
type Key = 'code' | 'label_en' | 'label_ar' | 'type' | 'list_catalogue' | 'required' | 'sort_order' | 'section' | 'in_list' | 'in_filter' | 'in_template' | 'in_export' | 'is_active' | 'system';
const KEYS: Key[] = ['code', 'label_en', 'label_ar', 'type', 'list_catalogue', 'required', 'sort_order', 'section', 'in_list', 'in_filter', 'in_template', 'in_export', 'is_active', 'system'];
const BOOLS: Key[] = ['required', 'in_list', 'in_filter', 'in_template', 'in_export', 'is_active'];

/** What the sheet cannot do (S8), written in the sheet itself so the person editing it sees the limits. */
export const STRUCTURE_NOTES = [
  'How to use this sheet',
  'Change the cells you need, save the file and upload it in Settings > Data > Edit through templates. Nothing changes at once: the upload makes a proposal that a System Admin reviews and approves.',
  'A blank cell means "leave as it is".',
  'The Code of a column never changes. A new column is a new row with a new code (lower case letters, digits and _), a label and a type.',
  'A column that holds values cannot be deleted: clear Active to hide it (it can be shown again).',
  'A type change is accepted only when every value converts. Columns the system needs (grey rows) can change label, order and visibility only.',
  'This sheet cannot create or delete a register, the computed Master columns, workflow stages, rights or roles.',
  'Yes / No for the flag columns.',
];

const yn = (b: boolean): string => (b ? 'Yes' : 'No');

export function writeStructureSheet(wb: ExcelJS.Workbook, fields: StructureField[]): void {
  const ws = wb.addWorksheet(STRUCTURE_SHEET, { properties: { tabColor: { argb: 'FF6A5ACD' } }, views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  const thin = { style: 'thin' as const, color: { argb: 'FFBDC8CC' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  STRUCTURE_HEADERS.forEach((h, i) => {
    const c = ws.getCell(1, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i === 0 || i === 13 ? 'FF6B7280' : 'FF3E8FA3' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = border;
    ws.getColumn(i + 1).width = [22, 28, 28, 14, 20, 10, 8, 20, 9, 9, 11, 10, 8, 9][i] ?? 12;
  });
  fields.forEach((f, ri) => {
    const vals: (string | number)[] = [f.code, f.label_en, f.label_ar ?? '', f.type, f.list_catalogue ?? '', yn(f.required), f.sort_order, f.section ?? '', yn(f.in_list), yn(f.in_filter), yn(f.in_template), yn(f.in_export), yn(f.is_active), f.is_system ? 'System' : ''];
    vals.forEach((v, ci) => {
      const cell = ws.getCell(ri + 2, ci + 1);
      cell.value = v;
      cell.border = border;
      // grey = never edited here (the code and the system mark); the system rows are grey and marked "System" in words too, not by colour alone
      if (ci === 0 || ci === 13 || (f.is_system && [3, 4, 5].includes(ci))) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF0' } };
    });
  });
  const total = fields.length + 1;
  // a Yes / No list on the flag columns; a free cell stays free (blank = unchanged)
  const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations;
  for (const col of ['F', 'I', 'J', 'K', 'L', 'M']) {
    validations.add(`${col}2:${col}${total + 200}`, { type: 'list', allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Yes or No', error: 'Choose Yes or No.' });
  }
  STRUCTURE_NOTES.forEach((t, i) => {
    const c = ws.getCell(i + 1, 16);
    c.value = t;
    c.alignment = { wrapText: true, vertical: 'top' };
    if (i === 0) c.font = { bold: true };
  });
  ws.getColumn(16).width = 70;
}

export interface SheetRow { [k: string]: unknown }

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('').trim();
    if (o.result !== undefined) return String(o.result).trim();
    if (typeof o.text === 'string') return o.text.trim();
    return '';
  }
  return String(v).trim();
}

export class StructureSheetError extends Error {
  constructor(readonly code: 'headers_missing' | 'bad_value' | 'too_many_rows', message: string) { super(message); }
}

/** The rows of a Structure sheet: only the cells that have a value are sent (a blank cell means unchanged). The Code is the key. */
export function readStructureSheet(ws: ExcelJS.Worksheet): SheetRow[] {
  const head = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => { head.set(cellText(cell.value).toLowerCase(), col); });
  const at = {} as Record<Key, number | undefined>;
  STRUCTURE_HEADERS.forEach((h, i) => { at[KEYS[i] as Key] = head.get(h.toLowerCase()); });
  if (at.code === undefined) throw new StructureSheetError('headers_missing', 'The Structure sheet has no "Code" column in its first row. Download the template again.');
  const out: SheetRow[] = [];
  const last = ws.actualRowCount > 0 ? ws.rowCount : 0;
  if (last > 2001) throw new StructureSheetError('too_many_rows', 'The Structure sheet has more than 2000 rows.');
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    const code = cellText(row.getCell(at.code).value);
    if (code === '') continue;
    const o: SheetRow = { code };
    for (const k of KEYS) {
      if (k === 'code' || k === 'system') continue;
      const col = at[k];
      if (col === undefined) continue;
      const t = cellText(row.getCell(col).value);
      if (t === '') continue;
      if (BOOLS.includes(k)) {
        const b = /^(yes|true|1|y|نعم)$/i.test(t) ? true : /^(no|false|0|n|لا)$/i.test(t) ? false : null;
        if (b === null) throw new StructureSheetError('bad_value', `Row ${r}, ${STRUCTURE_HEADERS[KEYS.indexOf(k)]}: "${t.slice(0, 20)}" is not Yes or No.`);
        o[k] = b;
      } else if (k === 'sort_order') {
        const n = Number(t);
        if (!Number.isInteger(n) || n < 0 || n > 100000) throw new StructureSheetError('bad_value', `Row ${r}, Order: "${t.slice(0, 20)}" is not a whole number from 0 to 100000.`);
        o[k] = n;
      } else o[k] = t;
    }
    out.push(o);
  }
  return out;
}

/** The differences of a proposal as rows for the "download the differences" file. */
export function writeDifferences(wb: ExcelJS.Workbook, items: { code: string; create: boolean; changes: string[]; blocked: string | null; patch: Record<string, unknown>; from: Record<string, unknown> | null }[]): void {
  const ws = wb.addWorksheet('Differences', { views: [{ state: 'frozen', ySplit: 1 }] });
  const head = ['Code', 'Change', 'Field', 'From', 'To', 'Blocked'];
  head.forEach((h, i) => { const c = ws.getCell(1, i + 1); c.value = h; c.font = { bold: true }; ws.getColumn(i + 1).width = [24, 18, 18, 30, 30, 22][i] ?? 16; });
  let r = 2;
  for (const it of items) {
    const keys = Object.keys(it.patch);
    const list = keys.length > 0 ? keys : [''];
    for (const k of list) {
      const from = it.from && k ? it.from[k === 'field_type' ? 'type' : k] : null;
      [it.code, it.create ? 'add' : it.changes.join(', '), k, from === null || from === undefined ? '' : String(from), k ? String(it.patch[k] ?? '') : '', it.blocked ?? ''].forEach((v, i) => { ws.getCell(r, i + 1).value = v; });
      r++;
    }
  }
}
