import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException, problems } from '../common/problem';
import { boolParam, oneParam } from '../common/query';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

/** One column of a template (the JSON that tpl_columns() stores with every version). */
export interface TplColumn {
  code: string;
  header: string;
  type: string;
  kind: 'site' | 'record_type' | 'field' | 'custom' | 'record_id';
  required?: boolean;
  derived?: boolean;
  options?: string[];
}

export interface TemplateRow {
  id: string;
  template_id: string;
  name: string;
  name_ar: string | null;
  kind: string;
  register_key: string | null;
  stream_code: string | null;
  module_key: string | null;
  current_version: number;
  is_active: boolean;
  updated_at: Date;
  field_set_version: number | null;
  columns: TplColumn[];
  header_checksum: string;
  field_set_hash: string | null;
  custom_entity: string | null;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DATA_SHEET = 'Data';
export const TPL_SHEET = '_tpl';
export const LISTS_SHEET = '_lists';
/** Rows below the pre-filled ones that are formatted and validated for typing. */
const BLANK_ROWS = 300;
const MAX_PREFILL_ROWS = 5000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const isoToDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** The current version of a template (active ones only). */
  async current(templateId: string): Promise<TemplateRow | null> {
    const rows = await this.db.tx.$queryRaw<TemplateRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.template_id, d.name, d.name_ar, d.kind, d.register_key, d.stream_code, d.module_key, d.current_version, d.is_active, d.updated_at,
        v.field_set_version, v.columns, v.header_checksum, v.field_set_hash, d.custom_entity
      FROM template_definitions d JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.template_id = ${templateId}`);
    return rows[0] ?? null;
  }

  /** The versions of one template: the lookup an upload makes. */
  async version(templateId: string, version: number): Promise<{ id: string; is_current: boolean; columns: TplColumn[]; header_checksum: string } | null> {
    const rows = await this.db.tx.$queryRaw<{ id: string; is_current: boolean; columns: TplColumn[]; header_checksum: string }[]>(Prisma.sql`
      SELECT v.id::text AS id, v.is_current, v.columns, v.header_checksum FROM template_versions v
      JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = ${templateId} AND v.version = ${version}`);
    return rows[0] ?? null;
  }

  /** Does the caller have the right to use the template of this register (view on its module)? */
  private async usable(t: TemplateRow): Promise<boolean> {
    if (t.kind === 'register' && t.module_key) {
      const regs = await this.access.regions(t.module_key, 'view');
      return regs === null || regs.length > 0;
    }
    if (t.kind === 'stream' || t.kind === 'master') {
      const regs = await this.access.regions('sites', 'view');
      return regs === null || regs.length > 0;
    }
    return false;
  }

  // ------------------------------------------------------------------ GET /templates
  async list(auth: AuthContext): Promise<{ items: unknown[] }> {
    void auth;
    const rows = await this.db.tx.$queryRaw<TemplateRow[]>(Prisma.sql`
      SELECT d.id::text AS id, d.template_id, d.name, d.name_ar, d.kind, d.register_key, d.stream_code, d.module_key, d.current_version, d.is_active, d.updated_at,
        v.field_set_version, '[]'::jsonb AS columns, v.header_checksum, v.field_set_hash, d.custom_entity
      FROM template_definitions d JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.is_active ORDER BY d.sort_order, d.template_id COLLATE "C"`);
    const versions = await this.db.tx.$queryRaw<{ def: string; version: number; published_at: Date; reason: string | null }[]>(Prisma.sql`
      SELECT v.template_def_id::text AS def, v.version, v.published_at, v.reason FROM template_versions v ORDER BY v.version DESC`);
    const items: unknown[] = [];
    for (const t of rows) {
      if (!(await this.usable(t))) continue;
      items.push({
        template_id: t.template_id,
        name_en: t.name,
        name_ar: t.name_ar,
        kind: 'data_import',
        module_key: t.module_key ?? 'sites',
        register_key: t.register_key,
        stream: t.stream_code,
        current_version: t.current_version,
        field_set_version: t.field_set_version,
        issued_at: versions.find((v) => v.def === t.id && v.version === t.current_version)?.published_at ?? t.updated_at,
        is_active: t.is_active,
        versions: versions.filter((v) => v.def === t.id).map((v) => ({ version: v.version, issued_at: v.published_at, reason: v.reason })),
      });
    }
    return { items };
  }

  // ------------------------------------------------------------------ GET /templates/{id}/download
  async download(auth: AuthContext, templateId: string, ip: string | null, q: Record<string, unknown>): Promise<{ buffer: Buffer; fileName: string }> {
    const t = await this.current(templateId);
    if (!t || !t.is_active) throw problems.notFound('This template does not exist.');
    if (t.kind !== 'register' || !t.register_key || !t.module_key) throw problems.notFound('This template cannot be downloaded yet.');
    const regs = await this.access.requireRegions(t.module_key, 'view');
    if (!(await this.access.hasGrant(auth, 'templates', 'download_documents'))) throw problems.forbidden('action_forbidden', 'You need to download documents on templates.');

    const taskId = oneParam(q, 'task_id');
    const siteIds = this.siteIds(q);
    const regionParam = oneParam(q, 'region_id');
    let prefill = boolParam(q, 'prefill') === true || taskId !== undefined || siteIds.length > 0;
    let site: string[] = siteIds;
    if (taskId !== undefined) {
      if (!uuidSchema.safeParse(taskId).success) throw problems.validation([{ path: '/task_id', code: 'invalid', message: 'task_id is a uuid.' }]);
      const task = await this.db.tx.$queryRaw<{ site_id: string; used: boolean }[]>(Prisma.sql`
        SELECT ti.site_id::text AS site_id,
          EXISTS (SELECT 1 FROM register_task_sources s WHERE s.task_code = td.code AND s.register_key = ${t.register_key} AND s.is_active) AS used
        FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id WHERE ti.id = ${taskId}::uuid`);
      if (!task[0]) throw problems.notFound('The task does not exist or is not visible to you.');
      if (!task[0].used) throw new ProblemException(422, 'template_rejected', { detail: 'This task does not use this template.', extra: { reason: 'wrong_template' } });
      site = [task[0].site_id];
      prefill = true;
    }
    for (const s of site) if (!uuidSchema.safeParse(s).success) throw problems.validation([{ path: '/site_ids', code: 'invalid', message: 'site_ids are uuids.' }]);
    let region: number | null = null;
    if (regionParam !== undefined) {
      if (!/^[0-9]{1,2}$/.test(regionParam)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is a number.' }]);
      region = Number(regionParam);
    }

    // the columns as issued (stored with the version); the lists are read again so a new permit type or list value shows at once
    const fresh = await this.db.tx.$queryRaw<{ cols: TplColumn[]; sum: string }[]>(Prisma.sql`SELECT tpl_columns(${t.register_key}) AS cols, tpl_header_checksum(tpl_columns(${t.register_key})) AS sum`);
    const cols = fresh[0] && fresh[0].sum === t.header_checksum ? fresh[0].cols : t.columns;

    const rows = prefill ? await this.prefillRows(t.register_key, regs, site, region, cols) : [];

    const me = await this.db.tx.$queryRaw<{ employee_id: string | null; display_name: string }[]>(Prisma.sql`SELECT employee_id, display_name FROM users WHERE id = ${auth.user.id}::uuid`);
    const issuedAt = new Date();
    const buffer = await this.build(t, cols, rows, { prefill, employeeId: me[0]?.employee_id?.trim() ?? null, issuedAt });

    await this.db.tx.$executeRaw(Prisma.sql`INSERT INTO audit_log (action, entity_type, entity_id, after, actor_id, ip)
      VALUES ('template_download', 'template', ${t.template_id},
        ${JSON.stringify({ version: t.current_version, prefill, rows: rows.length, task_id: taskId ?? null, site_ids: site, region_id: region, register_key: t.register_key })}::jsonb,
        ${auth.user.id}::uuid, ${ip})`);
    const name = `${t.template_id}_v${t.current_version}${prefill ? '_prefilled' : ''}_${issuedAt.toISOString().slice(0, 10)}.xlsx`;
    return { buffer, fileName: name };
  }

  private siteIds(q: Record<string, unknown>): string[] {
    const v = q.site_ids ?? q['site_ids[]'];
    if (v === undefined) return [];
    const list = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? x.split(',') : [])).map((s) => s.trim()).filter(Boolean);
    if (list.length > 500) throw problems.validation([{ path: '/site_ids', code: 'too_many', message: 'At most 500 sites.' }]);
    return list;
  }

  /** The records in force (approved, else the open draft), inside the caller's regions. Row level security applies as well. */
  private async prefillRows(key: string, regs: number[] | null, sites: string[], region: number | null, cols: TplColumn[]): Promise<Record<string, unknown>[]> {
    const rows = await this.db.tx.$queryRaw<{ entity_id: string; site_code: string | null; record_type: string | null; data: Record<string, unknown>; custom: Record<string, unknown> }[]>(Prisma.sql`
      SELECT DISTINCT ON (r.entity_id) r.entity_id::text AS entity_id, s.site_code, r.record_type, r.data, r.custom
      FROM register_records r LEFT JOIN sites s ON s.id = r.site_id
      WHERE r.register_key = ${key} AND r.state IN ('approved', 'entry', 'in_review', 'in_approval')
        AND (r.is_current OR NOT EXISTS (SELECT 1 FROM register_records c WHERE c.entity_id = r.entity_id AND c.is_current))
        ${regs === null ? Prisma.empty : Prisma.sql`AND (r.is_global OR r.region_id = ANY(${regs}::int[]))`}
        ${sites.length ? Prisma.sql`AND r.site_id = ANY(${sites}::uuid[])` : Prisma.empty}
        ${region !== null ? Prisma.sql`AND r.region_id = ${region}` : Prisma.empty}
      ORDER BY r.entity_id, r.is_current DESC, r.version_no DESC`);
    rows.sort((a, b) => (a.site_code ?? '').localeCompare(b.site_code ?? '', 'en') || a.entity_id.localeCompare(b.entity_id));
    const page = rows.slice(0, MAX_PREFILL_ROWS);

    // ids that the file shows as names / employee IDs
    const teamIds = new Set<string>(), userIds = new Set<string>();
    for (const c of cols) {
      if (c.kind !== 'field') continue;
      for (const r of page) {
        const v = r.data[c.code];
        if (typeof v !== 'string') continue;
        if (c.type === 'external_team') teamIds.add(v);
        if (c.type === 'user') userIds.add(v);
      }
    }
    const teams = teamIds.size ? await this.db.tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`SELECT id::text AS id, name FROM external_teams WHERE id = ANY(${[...teamIds]}::uuid[])`) : [];
    const users = userIds.size ? await this.db.tx.$queryRaw<{ id: string; employee_id: string | null; email: string }[]>(Prisma.sql`SELECT id::text AS id, employee_id, email FROM users WHERE id = ANY(${[...userIds]}::uuid[])`) : [];
    return page.map((r) => {
      const out: Record<string, unknown> = { record_id: r.entity_id, site_code: r.site_code, record_type: r.record_type };
      for (const c of cols) {
        if (c.kind === 'field') {
          let v = r.data[c.code];
          if (c.type === 'external_team' && typeof v === 'string') v = teams.find((t) => t.id === v)?.name ?? v;
          if (c.type === 'user' && typeof v === 'string') { const u = users.find((x) => x.id === v); v = u?.employee_id?.trim() || u?.email || v; }
          out[c.code] = v;
        } else if (c.kind === 'custom') out[c.code] = r.custom[c.code];
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ the workbook
  private cellValue(c: TplColumn, v: unknown): ExcelJS.CellValue {
    if (v === undefined || v === null || v === '') return null;
    if (c.type === 'date' && typeof v === 'string' && ISO_DAY.test(v)) return isoToDate(v);
    if (c.type === 'number') return typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : String(v);
    if (c.type === 'yes_no') return v === true ? 'Yes' : v === false ? 'No' : String(v);
    // text that starts like a formula is written as text, never as a formula
    const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    return s;
  }

  async build(t: TemplateRow, cols: TplColumn[], rows: Record<string, unknown>[], meta: { prefill: boolean; employeeId: string | null; issuedAt: Date }): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GSDN PMIS';
    wb.created = meta.issuedAt;
    wb.title = `${t.template_id} v${t.current_version}`;

    const ws = wb.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
    const ins = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FF2E7D90' } } });
    const lists = wb.addWorksheet(LISTS_SHEET);
    const tpl = wb.addWorksheet(TPL_SHEET);

    const lastRow = 1 + Math.max(rows.length, 0) + BLANK_ROWS;
    // exceljs writes a validation per range (sqref) but does not type the collection
    const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations;
    const thin = { style: 'thin' as const, color: { argb: 'FFBDC8CC' } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };
    let listCol = 0;
    cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(Math.max(c.header.length + 4, c.type === 'date' ? 14 : 12), 38);
      col.style = { protection: { locked: c.derived === true || c.kind === 'record_id' }, ...(c.type === 'date' ? { numFmt: 'yyyy-mm-dd' } : {}) };
      const head = ws.getCell(1, i + 1);
      head.value = c.header;
      head.font = { bold: true, color: { argb: c.derived || c.kind === 'record_id' ? 'FF333333' : 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.derived || c.kind === 'record_id' ? 'FFD0D5D8' : c.required ? 'FF1F6F83' : 'FF3E8FA3' } };
      head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      head.border = border;
      head.protection = { locked: true };
      // list values go to the hidden sheet, so there is no 255-character limit
      let formula: string | null = null;
      if (c.options && c.options.length > 0 && c.kind !== 'record_id') {
        listCol += 1;
        lists.getCell(1, listCol).value = c.code;
        c.options.forEach((o, r) => { lists.getCell(r + 2, listCol).value = o; });
        const letter = lists.getColumn(listCol).letter;
        formula = `${LISTS_SHEET}!$${letter}$2:$${letter}$${c.options.length + 1}`;
      }
      if (!c.derived && c.kind !== 'record_id') {
        const range = `${ws.getColumn(i + 1).letter}2:${ws.getColumn(i + 1).letter}${lastRow}`;
        if (formula) {
          validations.add(range, { type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: true, errorStyle: 'stop', errorTitle: head.text, error: 'Choose a value from the list.' });
        } else if (c.type === 'date') {
          validations.add(range, { type: 'date', operator: 'between', allowBlank: true, formulae: [new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2035, 11, 31))], showErrorMessage: true, errorStyle: 'stop', errorTitle: head.text, error: 'A date between 2020-01-01 and 2035-12-31.' });
        } else if (c.type === 'number') {
          validations.add(range, { type: 'decimal', operator: 'between', allowBlank: true, formulae: [-1e12, 1e12], showErrorMessage: true, errorStyle: 'stop', errorTitle: head.text, error: 'A number.' });
        }
      }
    });
    ws.getRow(1).height = 32;
    rows.forEach((r, ri) => {
      cols.forEach((c, i) => {
        const cell = ws.getCell(ri + 2, i + 1);
        const v = this.cellValue(c, r[c.code]);
        if (v !== null) cell.value = v;
        if (c.derived || c.kind === 'record_id') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF0' } };
          cell.protection = { locked: true };
        } else {
          cell.protection = { locked: false };
        }
        if (c.type === 'date') cell.numFmt = 'yyyy-mm-dd';
      });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: false, insertRows: true, deleteRows: false, sort: true, autoFilter: true });

    // the hidden sheet that makes the file an approved template
    const kv: [string, string | number][] = [
      ['template_id', t.template_id],
      ['version', t.current_version],
      ['kind', t.kind],
      ['register_key', t.register_key ?? ''],
      ['stream', t.stream_code ?? ''],
      ['header_checksum', t.header_checksum],
      ['field_set_hash', t.field_set_hash ?? ''],
      ['columns', cols.length],
      ['data_sheet', DATA_SHEET],
      ['issued_by', meta.employeeId ?? ''],
      ['issued_at', meta.issuedAt.toISOString()],
      ['prefilled', meta.prefill ? 'yes' : 'no'],
    ];
    kv.forEach(([k, v], i) => { tpl.getCell(i + 1, 1).value = k; tpl.getCell(i + 1, 2).value = v; });
    tpl.state = 'veryHidden';
    lists.state = 'veryHidden';

    ins.getColumn(1).width = 110;
    const lines = [
      `GSDN PMIS approved template ${t.template_id}, version ${t.current_version}.`,
      'Fill the sheet "Data" and upload the same file in the PMIS. Do not rename, move, add or delete columns, and do not change the header row: the PMIS refuses a changed file.',
      'Files from an older version of the template are refused: download the template again when the PMIS issues a new version.',
      'Grey columns are calculated or fixed by the PMIS. They are shown for information and are never read.',
      'Leave a cell empty to keep the current value. An empty cell never clears a value.',
      'The Record ID column is filled in a pre-filled copy. A row with a Record ID updates that record; a row without one is matched by its key (see the register), or creates a new record.',
      'Dates are typed as dates (yyyy-mm-dd). Cells must hold values, not formulas.',
      'The upload becomes a batch. Nothing reaches the register until each row has gone through the normal Entry then Review / Approve levels of its register.',
      '',
      'قالب معتمد من نظام GSDN PMIS. املأ الورقة Data وأعد رفع الملف نفسه. لا تغيّر صف العناوين ولا الأعمدة، فالنظام يرفض الملف المعدَّل أو القديم.',
      'تبقى الخلية الفارغة بلا تغيير ولا تمسح قيمة موجودة. تمرّ كل صفوف الرفع على مستويات الإدخال والمراجعة والاعتماد المعتادة.',
    ];
    lines.forEach((l, i) => { const cell = ins.getCell(i + 1, 1); cell.value = l; cell.alignment = { wrapText: true, vertical: 'top' }; });
    ins.getCell(1, 1).font = { bold: true, size: 13 };
    wb.views = [{ x: 0, y: 0, width: 12000, height: 8000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out as ArrayBuffer);
  }
}
