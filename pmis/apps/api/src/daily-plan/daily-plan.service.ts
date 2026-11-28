import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { DATA_SHEET, TPL_SHEET } from '../templates/templates.service';
import { importMaxRows, type UploadedFile } from '../templates/upload.interceptor';
import { guardXlsx } from '../templates/xlsx-guard';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { isCalendarDate, oneParam } from '../common/query';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

type Query = Record<string, unknown>;
type J = Record<string, unknown>;

/** The columns of the owner's sheet, in its exact order (the export and the copy for email keep it whatever the settings say). */
export const PROGRESS_EXPORT_COLUMNS: [string, string][] = [
  ['no', 'No'], ['site_code', 'Site ID'], ['tower_owner', 'Tower Owner'], ['owner_id', 'Owner ID'], ['latitude', 'Latitude'], ['longitude', 'Longitude'],
  ['region', 'Region'], ['site_type', 'Site Type'], ['sow', 'SOW'], ['contractor', 'Vendor / Contractor Name'], ['aat_se', 'AAT SE'],
  ['planned_work', 'Planned Work'], ['actual_work', 'Actual Work'], ['reason', 'Reason (if not reach target)'],
];
export const TOMORROW_EXPORT_COLUMNS: [string, string][] = [
  ['no', 'No'], ['site_code', 'Site ID'], ['tower_owner', 'Tower Owner'], ['owner_id', 'Owner ID'], ['latitude', 'Latitude'], ['longitude', 'Longitude'],
  ['region', 'Region'], ['site_type', 'Site Type'], ['sow', 'SOW'], ['contractor', 'Vendor / Contractor Name'], ['aat_se', 'AAT SE'],
  ['access_valid', 'Access Valid'], ['planned_work', 'Planned Work'], ['remark', 'Remark'],
];

const date = (v: string, path = '/date'): string => {
  if (!isCalendarDate(v)) throw problems.validation([{ path, code: 'invalid', message: 'A date YYYY-MM-DD.' }]);
  return v;
};
const region = (v: string): number => {
  if (!/^[1-9][0-9]{0,2}$/.test(v)) throw problems.notFound('The plan does not exist or is not visible to you.');
  return Number(v);
};
/** A repeatable query parameter: one value or a list. */
function many(q: Query, key: string): string[] | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (list.length > 200 || list.some((x) => typeof x !== 'string')) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is a list of values.` }]);
  return (list as string[]).flatMap((x) => x.split(',')).filter((x) => x !== '');
}
function regions(q: Query): number[] | null {
  const r = many(q, 'region_id');
  if (!r || r.length === 0) return null;
  if (r.some((x) => !/^[1-9][0-9]{0,2}$/.test(x))) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is a region number.' }]);
  return r.map(Number);
}
/** The body of a call that carries a reason apart from the closed rest. */
function split(raw: unknown): { reason: string | null; rest: J } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw problems.validation([{ path: '/', code: 'invalid', message: 'The body is a JSON object.' }]);
  const { reason, ...rest } = raw as J;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') throw problems.validation([{ path: '/reason', code: 'invalid', message: 'The reason is text.' }]);
  return { reason: typeof reason === 'string' ? reason : null, rest };
}

/**
 * My Work > Daily Plan (plan W7, migration 0149, contract 0.15.67). The database owns every rule: the auto-filled columns, the region scope, the Matrix row
 * daily_plan (L1 edits, L2 locks, the unlock override), the required reason, the version under a row lock and the audit rows (daily_plan_json, dp_save_row,
 * dp_add_site, dp_remove_site, dp_lock, dp_unlock, dp_export_json, dp_settings_json, admin_set_daily_plan_settings). The service shapes the calls, asks for the
 * step-up of the unlock and writes the Excel file of the export.
 */
@Injectable()
export class DailyPlanService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService, private readonly syslog: SyslogService) {}

  private async one<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const r = await this.db.tx.$queryRaw<{ j: T }[]>(sql);
      return r[0]!.j;
    } catch (e) {
      const p = e instanceof ProblemException ? e : mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  /** GET /daily-plans */
  day(q: Query): Promise<J> {
    const d = oneParam(q, 'date');
    if (d === undefined) throw problems.validation([{ path: '/date', code: 'required', message: 'A date YYYY-MM-DD is required.' }]);
    return this.one(Prisma.sql`SELECT daily_plan_json(${date(d)}::date, ${regions(q)}::integer[]) AS j`);
  }

  /** PATCH /daily-plans/{date}/regions/{region_id}/sites/{site_id} */
  saveRow(d: string, r: string, site: string, ifMatch: string | undefined, body: unknown): Promise<J> {
    const version = parseIfMatch(ifMatch);
    if (!uuidSchema.safeParse(site).success) throw problems.notFound('The site is not in this plan.');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw problems.validation([{ path: '/', code: 'invalid', message: 'The body is a JSON object.' }]);
    return this.one(Prisma.sql`SELECT dp_save_row(${region(r)}::integer, ${date(d)}::date, ${site}::uuid, ${JSON.stringify(body)}::jsonb, ${version}::integer) AS j`);
  }

  /** POST /daily-plans/{date}/regions/{region_id}/sites */
  addSite(d: string, r: string, ifMatch: string | undefined, body: unknown): Promise<J> {
    const version = parseIfMatch(ifMatch);
    const b = (body ?? {}) as J;
    if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'site_code')) {
      throw problems.validation([{ path: '/', code: 'unknown_key', message: 'The body is {site_code}.' }]);
    }
    if (typeof b.site_code !== 'string' || b.site_code.trim() === '' || b.site_code.length > 60) {
      throw problems.validation([{ path: '/site_code', code: 'required', message: 'The Site ID of the site to add.' }]);
    }
    return this.one(Prisma.sql`SELECT dp_add_site(${region(r)}::integer, ${date(d)}::date, ${b.site_code}::text, ${version}::integer) AS j`);
  }

  /** DELETE /daily-plans/{date}/regions/{region_id}/sites/{site_id} */
  removeSite(d: string, r: string, site: string, ifMatch: string | undefined): Promise<J> {
    const version = parseIfMatch(ifMatch);
    if (!uuidSchema.safeParse(site).success) throw problems.notFound('The site is not in this plan.');
    return this.one(Prisma.sql`SELECT dp_remove_site(${region(r)}::integer, ${date(d)}::date, ${site}::uuid, ${version}::integer) AS j`);
  }

  /** POST /daily-plans/{date}/regions/{region_id}/lock */
  lock(d: string, r: string, ifMatch: string | undefined): Promise<J> {
    const version = parseIfMatch(ifMatch);
    return this.one(Prisma.sql`SELECT dp_lock(${region(r)}::integer, ${date(d)}::date, ${version}::integer) AS j`);
  }

  /** POST /daily-plans/{date}/regions/{region_id}/unlock (admin override: reason and step-up) */
  async unlock(auth: AuthContext, d: string, r: string, ifMatch: string | undefined, body: unknown): Promise<J> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(body);
    if (Object.keys(rest).length) throw problems.validation(Object.keys(rest).map((k) => ({ path: `/${k}`, code: 'unknown_key', message: 'Unknown key.' })));
    if (!reason || reason.trim().length < 3) throw problems.validation([{ path: '/reason', code: 'required', message: 'A reason of at least 3 characters is required.' }]);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT dp_unlock(${region(r)}::integer, ${date(d)}::date, ${reason}::text, ${version}::integer) AS j`);
  }

  /** Migration 0567: the audit trail of one plan day (rows changed, added, removed, locks) with the field changes. GET /daily-plans/{date}/regions/{region_id}/history */
  history(d: string, r: string): Promise<J[]> {
    return this.one(Prisma.sql`SELECT dp_plan_history(${region(r)}::integer, ${date(d)}::date) AS j`);
  }

  /** Migration 0567: claim and triage state of a plan day (target: region + date). */
  triage(d: string, r: string): Promise<J> {
    return this.one(Prisma.sql`SELECT dp_plan_triage_get(${region(r)}::integer, ${date(d)}::date) AS j`);
  }

  claim(d: string, r: string, claim: boolean): Promise<J> {
    return this.one(Prisma.sql`SELECT dp_plan_claim(${region(r)}::integer, ${date(d)}::date, ${claim}::boolean) AS j`);
  }

  decide(d: string, r: string, body: unknown): Promise<J> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => k !== 'state' && k !== 'note');
    if (extra.length) throw problems.validation(extra.map((k) => ({ path: `/${k}`, code: 'unknown_key', message: 'Unknown key.' })));
    const state = typeof b.state === 'string' ? b.state : '';
    const note = typeof b.note === 'string' ? b.note : '';
    return this.one(Prisma.sql`SELECT dp_plan_triage(${region(r)}::integer, ${date(d)}::date, ${state}::text, ${note}::text) AS j`);
  }

  /**
   * POST /daily-plans/import (0564, 3b): the approved xlsx template TPL-DAILY-PLAN only. The guards of the other template imports apply (size limit of the upload
   * interceptor, xlsx guard, the _tpl sheet naming the template and its current version, the header row as issued); each rejection goes to the System Log. The
   * rows go to dp_import_rows in one call: each row is applied through dp_add_site, dp_save_row and dp_remove_site (rights, lock, audit inside), and one refused
   * row refuses the whole file (errors at /rows/<line>/<field>).
   */
  async importTemplate(auth: AuthContext, file: UploadedFile | undefined, requestId: string | undefined): Promise<J> {
    if (!file || file.size === 0) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the filled TPL-DAILY-PLAN template as the form field "file".' }]);
    const fileName = (file.originalname ?? '').slice(0, 200);
    const reject = async (code: string, detail: string, ctx: Record<string, unknown> = {}): Promise<never> => {
      await this.syslog.write('warn', `daily plan import rejected: ${code}`, { reason: code, detail, file_name: fileName, ...ctx }, auth.user.id, requestId, 'daily-plan-import');
      throw new ProblemException(422, 'template_rejected', { detail, extra: { reason: code }, commit: true });
    };
    const guard = guardXlsx(file.originalname ?? '', file.buffer);
    if (!guard.ok) return reject(guard.reason ?? 'not_xlsx', guard.detail ?? 'The file is not accepted: upload the TPL-DAILY-PLAN template (.xlsx).');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      return reject('not_xlsx', 'The file is not a valid .xlsx workbook.');
    }
    const text = (cell: ExcelJS.Cell): string => {
      const v = cell.value;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return (cell.text ?? '').toString().trim();
    };
    const tpl = wb.getWorksheet(TPL_SHEET);
    if (!tpl) return reject('tpl_missing', 'This file is not an approved GSDN Workspace template: the hidden _tpl sheet is missing. Download TPL-DAILY-PLAN from the Templates page.');
    const kv = new Map<string, string>();
    tpl.eachRow((row) => {
      const k = text(row.getCell(1));
      if (k) kv.set(k, text(row.getCell(2)));
    });
    const templateId = (kv.get('template_id') ?? '').slice(0, 60);
    const versionText = (kv.get('version') ?? '').slice(0, 12);
    if (templateId !== 'TPL-DAILY-PLAN' || !/^[0-9]{1,6}$/.test(versionText)) {
      return reject('wrong_template', `This file is not the Daily Plan template (TPL-DAILY-PLAN); it names ${templateId || 'no template'}.`, { template_id: templateId });
    }
    const cur = await this.db.tx.$queryRaw<{ current_version: number; columns: { code: string; header: string }[] }[]>(Prisma.sql`
      SELECT d.current_version, v.columns FROM template_definitions d
      JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.template_id = 'TPL-DAILY-PLAN' AND d.is_active`);
    if (!cur[0]) return reject('template_unknown_or_inactive', 'The Daily Plan template is not in use.');
    const version = Number(versionText);
    if (version !== cur[0].current_version) {
      return reject('outdated_version', `This file was made from version ${version} of TPL-DAILY-PLAN; the current version is ${cur[0].current_version}. Download the template again.`,
        { version, current_version: cur[0].current_version });
    }
    const data = wb.getWorksheet(DATA_SHEET);
    if (!data) return reject('checksum_mismatch', 'The Data sheet is missing.');
    const cols = cur[0].columns;
    const head = data.getRow(1);
    if (cols.some((c, i) => text(head.getCell(i + 1)) !== c.header)) {
      return reject('checksum_mismatch', 'The header row of the file was changed. Use the template as it was issued, without adding, moving or renaming columns.');
    }
    const rows: J[] = [];
    for (let r = 2; r <= data.rowCount; r++) {
      const cells = cols.map((_, i) => text(data.getRow(r).getCell(i + 1)));
      if (cells.every((v) => v === '')) continue;
      if (rows.length >= importMaxRows()) return reject('size_or_rows_exceeded', `At most ${importMaxRows()} rows per file.`);
      const row: J = { line: r };
      cols.forEach((c, i) => { row[c.code] = cells[i]; });
      rows.push(row);
    }
    if (rows.length === 0) throw problems.validation([{ path: '/file', code: 'empty', message: 'The Data sheet has no row.' }]);
    const meta = { file_name: fileName, template_version: version };
    const out = await this.one<{ id: string; rows: number; updated: number; added: number; removed: number; unchanged: number }>(
      Prisma.sql`SELECT dp_import_rows(${JSON.stringify(rows)}::jsonb, ${JSON.stringify(meta)}::jsonb) AS j`);
    await this.syslog.write('info', 'daily plan imported', { import_id: out.id, ...out, version }, auth.user.id, requestId, 'daily-plan-import');
    return { ...out, template_id: 'TPL-DAILY-PLAN', template_version: version, source: 'template', file_name: fileName, status: 'applied' };
  }

  /** GET /settings/daily-plan */
  settings(): Promise<{ version: number }> {
    return this.one(Prisma.sql`SELECT dp_settings_json() AS j`);
  }

  /** PUT /settings/daily-plan (If-Match) */
  setSettings(ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(raw);
    return this.one(Prisma.sql`SELECT admin_set_daily_plan_settings(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::integer) AS j`);
  }

  /** GET /daily-plans/export: both tables of the owner's sheet in one Excel sheet, in its column order. */
  async export(q: Query): Promise<{ buffer: Buffer; fileName: string }> {
    const d = oneParam(q, 'date');
    if (d === undefined) throw problems.validation([{ path: '/date', code: 'required', message: 'A date YYYY-MM-DD is required.' }]);
    const sites = many(q, 'site_id');
    if (sites && sites.some((s) => !uuidSchema.safeParse(s).success)) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a list of uuids.' }]);
    const data = await this.one<{ progress: J; tomorrow: J }>(Prisma.sql`
      SELECT dp_export_json(${date(d)}::date, ${regions(q)}::integer[], ${sites && sites.length ? sites : null}::uuid[]) AS j`);
    const buffer = await buildWorkbook(data.progress, data.tomorrow);
    return { buffer, fileName: `Daily_Plan_${d}.xlsx` };
  }
}

const cellText = (row: J, key: string, n: number): string | number => {
  if (key === 'no') return n;
  if (key === 'reason' || key === 'remark') return (row[key] as string | null) ?? '';
  return ((row.values as J | undefined)?.[key] as string | null | undefined) ?? '';
};

/** The workbook: the title row and the table of each day, one below the other, as in the owner's sheet. */
export async function buildWorkbook(progress: J, tomorrow: J): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GSDN Workspace';
  const ws = wb.addWorksheet('Daily Plan', { views: [{ state: 'frozen', ySplit: 0 }] });
  const block = (title: string, cols: [string, string][], rows: J[]) => {
    const t = ws.addRow([title]);
    t.font = { bold: true, size: 13 };
    ws.mergeCells(t.number, 1, t.number, cols.length);
    const h = ws.addRow(cols.map(([, label]) => label));
    h.font = { bold: true };
    h.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
      c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      c.alignment = { vertical: 'middle', wrapText: true };
    });
    rows.forEach((r, i) => {
      const row = ws.addRow(cols.map(([k]) => cellText(r, k, i + 1)));
      row.eachCell({ includeEmpty: true }, (c) => {
        c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        c.alignment = { vertical: 'top', wrapText: true };
      });
    });
    ws.addRow([]);
  };
  block(`Daily Progress ${String(progress.date)}`, PROGRESS_EXPORT_COLUMNS, (progress.rows as J[]) ?? []);
  block(`Tomorrow Plan ${String(tomorrow.date)}`, TOMORROW_EXPORT_COLUMNS, (tomorrow.rows as J[]) ?? []);
  const widths = [6, 14, 16, 14, 11, 11, 12, 12, 24, 24, 20, 36, 36, 30];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
