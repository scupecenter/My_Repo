import ExcelJS from 'exceljs';
import { isPersonal, normHeader, type RegisterMap } from '../master-import/register-sheets';

/**
 * The Site Master layout of the Master-format export (contract 0.2.2, 0.2.3, 0.15.34; CLAUDE.md "Full project export to a Master file").
 * Pure helpers: which parts exist, which Master columns each part fills, the register sheet layouts (the register maps of the Master import,
 * read in reverse) and the streaming workbook writer. No database access here.
 */

export const PART_KEYS = [
  'sites', 'milestones', 'tasks', 'project_status',
  'procurement', 'gecol', 'hlc', 'permits_hse', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness_handover', 'as_built', 'meetings', 'contractors',
  'rf_design', 'acquisition', 'dismantle', 'car_dispatcher', 'financial_advances',
  'incidents', 'lessons_learned', 'invoices',
] as const;
export type PartKey = (typeof PART_KEYS)[number];

/** Parts written on the Master sheet (one row per site). Dismantle also writes its register sheet. */
export const MASTER_SHEET_PARTS: readonly PartKey[] = ['sites', 'milestones', 'tasks', 'dismantle'];
export const NON_REGISTER: readonly PartKey[] = ['sites', 'milestones', 'tasks', 'project_status'];

export const MASTER_SHEET = 'Master';
/** The Master sheet: row 1 the top group, row 2 the middle group, row 3 the column name, row 4 the subtotal row of the Master, data from row 5. */
export const MASTER_FIRST_DATA_ROW = 5;

/** Labels of the non-register parts (register parts take the register's own name). */
export const PART_LABELS: Partial<Record<PartKey, [string, string]>> = {
  sites: ['Sites', 'المواقع'],
  milestones: ['Milestones', 'المعالم'],
  tasks: ['Tasks by stage', 'المهام حسب المرحلة'],
  project_status: ['Project Status', 'حالة المشروع'],
};

/** Sheet of a register part that has no register map (the maps name the sheet of the others). */
const DEFAULT_SHEETS: Partial<Record<PartKey, string>> = {
  quality: 'Quality Inspections', change_control: 'Change Control', readiness_handover: 'Readiness & Handover', warehouse: 'Warehouse', issues: 'Issue Log',
  meetings: 'Meetings', contractors: 'Contractors', dismantle: 'Dismantle', procurement: 'PR-PO', gecol: 'GECOL', hlc: 'HLC', permits_hse: 'Permits & HSE',
  risks: 'Risk Register', as_built: 'As-Built', rf_design: 'RF & Design', acquisition: 'Acquisition',
  car_dispatcher: 'Car Dispatcher', financial_advances: 'Financial Advances', incidents: 'Incidents', lessons_learned: 'Lessons Learned', invoices: 'Invoices',
};

export function partSheet(key: PartKey, map: RegisterMap | undefined): string {
  if (key === 'sites' || key === 'milestones' || key === 'tasks') return MASTER_SHEET;
  if (key === 'project_status') return 'Project Status';
  return map?.master_sheet ?? DEFAULT_SHEETS[key] ?? key;
}

export interface MasterColumn { ord: number; letter: string; group_top: string | null; group_mid: string | null; name: string | null; header: string; owner: string }

/**
 * The part a Master column belongs to: the identity, scope, baseline, issue and calculated status columns are the sites part; the milestone and phase
 * gate columns (stage_definitions / phase_gate_rules master_export_column) the milestones part; the workflow task columns the tasks part; FN:FW the
 * dismantle part. The row number (A) and the Site ID (B) belong to every part.
 */
export function columnPart(c: MasterColumn, milestoneLetters: Set<string>): PartKey | 'all' {
  if (c.owner === 'row' || c.owner === 'key') return 'all';
  if (milestoneLetters.has(c.letter)) return 'milestones';
  if (c.owner === 'task') return 'tasks';
  if (c.owner === 'dismantle') return 'dismantle';
  return 'sites';
}

/** A position of the Master sheet that holds no column (a deleted or deactivated one): the letters of the columns after it stay true. */
export const BLANK_MASTER_OWNER = 'blank';

/**
 * 0133 (contract 0.15.43): the active columns in Master order, with an empty placeholder for every order that has no active column up to the last one, so a
 * column always sits at the position of its letter (A = 1) even after a column was deleted or deactivated.
 */
export function padMasterColumns(cols: readonly MasterColumn[]): MasterColumn[] {
  const byOrd = new Map(cols.map((c) => [c.ord, c]));
  const last = cols.reduce((m, c) => Math.max(m, c.ord), 0);
  const out: MasterColumn[] = [];
  for (let o = 1; o <= last; o++) {
    out.push(byOrd.get(o) ?? { ord: o, letter: '', group_top: null, group_mid: null, name: null, header: '', owner: BLANK_MASTER_OWNER });
  }
  return out;
}

/** The three header rows of the Master sheet: a group label is written where its span starts (the Master merges the rest of the span). */
export function masterHeaderRows(cols: { group_top: string | null; group_mid: string | null; name: string | null }[]): (string | null)[][] {
  const top: (string | null)[] = [];
  const mid: (string | null)[] = [];
  const name: (string | null)[] = [];
  cols.forEach((c, i) => {
    const prev = i > 0 ? cols[i - 1] : undefined;
    top.push(c.group_top && (!prev || prev.group_top !== c.group_top) ? c.group_top : null);
    mid.push(c.group_mid && (!prev || prev.group_mid !== c.group_mid || prev.group_top !== c.group_top) ? c.group_mid : null);
    name.push(c.name ? c.name : null);
  });
  return [top, mid, name];
}

/** One template column of a register (tpl_columns). */
export interface TplCol { code: string; kind: string; header: string; type?: string }

/** One column of a register sheet: its header and where its value comes from. */
export interface RegisterSheetColumn { header: string; source: 'row_no' | 'site' | 'record_type' | 'record_id' | 'field' | 'custom' | 'region' | 'state' | 'none'; code: string | null; personal: boolean; type?: string }

export interface RegisterSheetLayout { sheet: string; header_row: number; first_data_row: number; columns: RegisterSheetColumn[] }

const sourceOf = (c: TplCol): RegisterSheetColumn['source'] =>
  c.kind === 'site' ? 'site' : c.kind === 'record_type' ? 'record_type' : c.kind === 'record_id' ? 'record_id' : c.kind === 'custom' ? 'custom' : 'field';

const PERSONAL = /landlord|contact|phone|e-?mail/i;

/**
 * The register sheet in its Master layout. With a register map (the Master import's `register-maps`, read in reverse): the mapped columns in the map's
 * order under their Master header (the first alias), then the template columns the map does not name; header and data rows as the map says, so the
 * sheet can be pasted back into the Master and read again by the import. Without a map: the template columns in order, header in row 1.
 * Personal columns (landlord, contact person, phone, e-mail; decision Q469) keep their header and stay empty.
 */
export function registerLayout(key: PartKey, tpl: TplCol[], map: RegisterMap | undefined, siteScoped: boolean): RegisterSheetLayout {
  const columns: RegisterSheetColumn[] = [];
  if (siteScoped) columns.push({ header: '#', source: 'row_no', code: null, personal: false });
  const used = new Set<string>();
  if (map) {
    const byHeader = new Map(tpl.map((c) => [normHeader(c.header), c]));
    for (const m of map.columns) {
      const col = byHeader.get(normHeader(m.template_header));
      const header = (m.master_header.split('|')[0] ?? '').trim() || m.template_header;
      if (!col) continue;
      used.add(col.code);
      columns.push({ header, source: sourceOf(col), code: col.code, personal: isPersonal(m), type: col.type });
    }
  }
  for (const c of tpl) {
    if (used.has(c.code)) continue;
    columns.push({ header: c.header, source: sourceOf(c), code: c.code, personal: PERSONAL.test(c.header), type: c.type });
  }
  const header_row = map ? map.header_row : 1;
  const first_data_row = map ? Math.max(map.first_data_row, map.header_row + 1) : 2;
  return { sheet: partSheet(key, map), header_row, first_data_row, columns };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A value as an Excel cell: an ISO day is a date, text stays text (never a formula: exceljs writes a string cell), a list is joined. */
export function cellValue(v: unknown): ExcelJS.CellValue {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') {
    if (ISO_DAY.test(v)) {
      const d = new Date(`${v}T00:00:00Z`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return v;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) return v;
  if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) return v.filter((x) => x !== null).join('; ');
  return JSON.stringify(v);
}

/** A sheet of the streaming workbook: rows are written in increasing order and committed at once (bounded memory for 1000+ sites). */
export class SheetWriter {
  private next = 1;
  rows = 0;
  constructor(private readonly ws: ExcelJS.Worksheet) {}

  /** Writes the values at row `n` (1-based; skipped rows stay empty). */
  write(n: number, values: unknown[], data = true): void {
    if (n < this.next) throw new Error('rows must be written in order');
    const row = this.ws.getRow(n);
    values.forEach((v, i) => {
      const cv = cellValue(v);
      if (cv === null) return;
      const cell = row.getCell(i + 1);
      cell.value = cv;
      if (cv instanceof Date) cell.numFmt = 'yyyy-mm-dd';
    });
    if (!data) row.font = { bold: true };
    row.commit();
    this.next = n + 1;
    if (data) this.rows++;
  }

  get nextRow(): number {
    return this.next;
  }

  commit(): Promise<void> {
    return (this.ws as unknown as { commit(): Promise<void> }).commit();
  }
}

/** The streaming writer of exceljs (already a dependency of apps/api): each committed row goes to the temporary file, nothing is kept in memory. */
export function workbookWriter(filename: string): ExcelJS.stream.xlsx.WorkbookWriter {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useStyles: true, useSharedStrings: false });
  wb.creator = 'GSDN Workspace';
  wb.created = new Date();
  return wb;
}
