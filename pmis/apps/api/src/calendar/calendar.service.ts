import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { parseIfMatch } from '../common/etag';
import { problems, ProblemException } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DATA_SHEET, TPL_SHEET } from '../templates/templates.service';
import { importMaxRows, type UploadedFile } from '../templates/upload.interceptor';
import { guardXlsx } from '../templates/xlsx-guard';

/** 0145: the columns of TPL-HOLIDAYS, in order (tpl_holidays_columns). */
const HOLIDAY_KEYS = ['date', 'name_en', 'name_ar', 'kind', 'tentative', 'note'] as const;

const reason = z.string().trim().min(3).max(1000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a date.')
  .refine((s) => s >= '2020-01-01' && s <= '2035-12-31', 'The date must be between 2020-01-01 and 2035-12-31.');
const kind = z.enum(['national', 'religious']);

const createSchema = z.object({
  reason,
  calendar_code: z.string().min(1).max(60).optional(),
  date: isoDate,
  name_en: z.string().trim().min(2).max(200),
  name_ar: z.string().trim().min(1).max(200).optional(),
  kind,
  tentative: z.boolean().default(false),
}).strict();

const patchSchema = z.object({
  reason,
  date: isoDate.optional(),
  name_en: z.string().trim().min(2).max(200).optional(),
  name_ar: z.string().trim().min(1).max(200).optional(),
  kind: kind.optional(),
}).strict().refine((b) => Object.keys(b).length >= 2, { message: 'Change at least one field.', path: [] });

const confirmSchema = z.object({ reason, date: isoDate.optional() }).strict();

const confirmationSchema = z.object({ reason, confirmed: z.boolean() }).strict();

interface ConfirmationJson {
  confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  version: number;
  can_edit: boolean;
  blockers: { code: 'no_holidays' | 'tentative_remaining'; year: number; count: number }[];
}

const weekendSchema = z.object({
  reason,
  calendar_code: z.string().min(1).max(60).optional(),
  weekend_days: z.array(z.number().int().min(0).max(6)).min(1).max(6),
}).strict().refine((b) => new Set(b.weekend_days).size === b.weekend_days.length, { message: 'A day appears twice.', path: ['weekend_days'] });

export interface HolidayDto {
  id: string;
  calendar_code: string;
  date: string;
  name_en: string;
  name_ar: string | null;
  kind: 'national' | 'religious';
  tentative: boolean;
  confirmed_at: Date | null;
  confirmed_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
}

interface HolidayRow {
  id: string;
  calendar_code: string;
  date: string;
  name: string;
  name_ar: string | null;
  kind: 'national' | 'religious';
  tentative: boolean;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  cb_name: string | null;
  cb_emp: string | null;
  version: number;
}

const HOLIDAY_SELECT = Prisma.sql`
  SELECT h.id::text AS id, c.code AS calendar_code, h.date::text AS date, h.name, h.name_ar, h.kind, h.tentative, h.confirmed_at,
         h.confirmed_by::text AS confirmed_by, u.display_name AS cb_name, u.employee_id AS cb_emp, h.version
  FROM holidays h JOIN work_calendars c ON c.id = h.calendar_id LEFT JOIN users u ON u.id = h.confirmed_by`;

const toDto = (r: HolidayRow): HolidayDto => ({
  id: r.id,
  calendar_code: r.calendar_code,
  date: r.date,
  name_en: r.name,
  name_ar: r.name_ar,
  kind: r.kind,
  tentative: r.tentative,
  confirmed_at: r.confirmed_at,
  confirmed_by: r.confirmed_by ? { id: r.confirmed_by, display_name: r.cb_name ?? '', employee_id: r.cb_emp?.trim() ?? null } : null,
  version: r.version,
});

/** Work calendar (decision B12): weekend days and holidays. Reads are open to every signed-in user; writes go through audited admin_* functions. */
@Injectable()
export class CalendarService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly syslog: SyslogService,
  ) {}

  private year(q: Query): number | undefined {
    const y = oneParam(q, 'year');
    if (y === undefined) return undefined;
    const n = /^\d{4}$/.test(y) ? Number(y) : NaN;
    if (!(n >= 2020 && n <= 2035)) throw problems.validation([{ path: '/year', code: 'invalid', message: 'year is between 2020 and 2035.' }]);
    return n;
  }

  /** GET /settings/calendars */
  async calendars(q: Query): Promise<{ items: unknown[] }> {
    const year = this.year(q);
    const cals = await this.db.tx.$queryRaw<{ id: string; code: string; name: string; weekend_days: number[] | null; is_default: boolean; version: number }[]>(Prisma.sql`
      SELECT id::text AS id, code, name, weekend_days, is_default, version FROM work_calendars WHERE is_active ORDER BY is_default DESC, code`);
    const hol = await this.db.tx.$queryRaw<{ calendar_id: string; date: string; name: string }[]>(Prisma.sql`
      SELECT calendar_id::text AS calendar_id, date::text AS date, name FROM holidays
      ${year ? Prisma.sql`WHERE extract(year FROM date) = ${year}` : Prisma.empty} ORDER BY date`);
    const next = await this.db.tx.$queryRaw<{ calendar_id: string; n: bigint }[]>(Prisma.sql`
      SELECT calendar_id::text AS calendar_id, count(*) AS n FROM holidays WHERE extract(year FROM date) = extract(year FROM cal_today()) + 1 GROUP BY calendar_id`);
    return {
      items: cals.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        weekend_days: c.weekend_days ?? [5, 6],
        is_default: c.is_default,
        holidays: hol.filter((h) => h.calendar_id === c.id).map((h) => ({ date: h.date, name: h.name })),
        holiday_table_empty: Number(next.find((n) => n.calendar_id === c.id)?.n ?? 0) === 0,
      })),
    };
  }

  /** GET /settings/holidays */
  async list(q: Query): Promise<{ items: HolidayDto[]; summary: unknown }> {
    const year = this.year(q);
    const code = oneParam(q, 'calendar_code');
    const tentative = oneParam(q, 'tentative');
    if (tentative !== undefined && tentative !== 'true' && tentative !== 'false') throw problems.validation([{ path: '/tentative', code: 'invalid', message: 'tentative is true or false.' }]);
    const rows = await this.db.tx.$queryRaw<HolidayRow[]>(Prisma.sql`${HOLIDAY_SELECT}
      WHERE true ${year ? Prisma.sql`AND extract(year FROM h.date) = ${year}` : Prisma.empty}
      ${code ? Prisma.sql`AND c.code = ${code}` : Prisma.empty} ${tentative ? Prisma.sql`AND h.tentative = ${tentative === 'true'}` : Prisma.empty}
      ORDER BY h.date, h.id`);
    const s = await this.db.tx.$queryRaw<{ tentative_count: bigint; next_tentative_date: string | null; reminder: boolean; next_year: number; next_n: bigint; confirmed: boolean }[]>(Prisma.sql`
      SELECT (SELECT count(*) FROM holidays WHERE tentative) AS tentative_count,
             coalesce((calc_setting('calendar.official_confirmed', 'false'::jsonb) #>> '{}')::boolean, false) AS confirmed,
             (SELECT min(date)::text FROM holidays WHERE tentative AND date >= cal_today()) AS next_tentative_date,
             EXISTS (SELECT 1 FROM holidays WHERE tentative AND date BETWEEN cal_today() AND cal_today() + 14) AS reminder,
             (extract(year FROM cal_today()) + 1)::int AS next_year,
             (SELECT count(*) FROM holidays WHERE extract(year FROM date) = extract(year FROM cal_today()) + 1) AS next_n`);
    const r = s[0];
    // 0.14.2 (Q440): who confirmed the official calendar and when
    const conf = await this.confirmation();
    return {
      items: rows.map(toDto),
      summary: {
        tentative_count: Number(r?.tentative_count ?? 0),
        next_tentative_date: r?.next_tentative_date ?? null,
        tentative_reminder_due: r?.reminder === true,
        next_year: r?.next_year ?? new Date().getUTCFullYear() + 1,
        next_year_table_empty: Number(r?.next_n ?? 0) === 0,
        // 0052 (Q4, D4b): the official calendar is pending owner data until the setting calendar.official_confirmed is true; tentative dates count now
        official_calendar_pending: r?.confirmed !== true,
        tentative_counted: true,
        official_confirmed_at: conf.confirmed_at,
        official_confirmed_by: conf.confirmed_by,
      },
    };
  }

  private async userRef(id: string | null): Promise<{ id: string; display_name: string; employee_id: string | null } | null> {
    if (!id) return null;
    const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${id}::uuid`);
    return { id, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
  }

  private async confirmation() {
    const r = await this.db.tx.$queryRaw<{ j: ConfirmationJson }[]>(Prisma.sql`SELECT cal_confirmation_json() AS j`);
    const j = r[0]!.j;
    return { confirmed: j.confirmed, confirmed_at: j.confirmed_at, confirmed_by: await this.userRef(j.confirmed_by), version: j.version, can_edit: j.can_edit, blockers: j.blockers };
  }

  /** GET /settings/calendar-confirmation (every signed-in user: the banner is shown to all) */
  getConfirmation() {
    return this.confirmation();
  }

  /** PUT /settings/calendar-confirmation (Q440): a System Admin, or a delegate of settings edit for all regions; reason and If-Match; audited by the database */
  async setConfirmation(auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    void auth;
    await this.access.requireAdmin('calendars', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(confirmationSchema, raw);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT admin_set_calendar_confirmation(${b.confirmed}::boolean, ${b.reason}::text, ${version}::int)`);
    return this.confirmation();
  }

  private async one(id: string): Promise<HolidayRow | undefined> {
    const rows = await this.db.tx.$queryRaw<HolidayRow[]>(Prisma.sql`${HOLIDAY_SELECT} WHERE h.id = ${id}::uuid`);
    return rows[0];
  }

  private async mustExist(raw: string): Promise<HolidayRow> {
    const id = parse(uuidSchema, raw);
    const row = await this.one(id);
    if (!row) throw problems.notFound('The holiday does not exist.');
    return row;
  }

  private async duplicate(calendarCode: string | undefined, date: string, exceptId?: string): Promise<void> {
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT h.id::text AS id FROM holidays h JOIN work_calendars c ON c.id = h.calendar_id
      WHERE h.date = ${date}::date AND c.code = coalesce(${calendarCode ?? null}, (SELECT code FROM work_calendars WHERE is_default)) ${exceptId ? Prisma.sql`AND h.id <> ${exceptId}::uuid` : Prisma.empty}`);
    if (rows.length > 0) throw new ProblemException(409, 'duplicate', { detail: 'This calendar already has a holiday on that date.', errors: [{ path: '/date', code: 'duplicate', message: 'A holiday exists on this date.' }] });
  }

  private result(row: HolidayRow, affected: number): { holiday: HolidayDto; affected_open_tasks: number; recalculation_job_id: null } {
    return { holiday: toDto(row), affected_open_tasks: affected, recalculation_job_id: null };
  }

  private async save(id: string | null, patch: Record<string, unknown>, why: string, version: number | null): Promise<{ id: string; affected_open_tasks: number }> {
    const r = await this.db.tx.$queryRaw<{ r: { id: string; affected_open_tasks: number } }[]>(Prisma.sql`
      SELECT admin_save_holiday(${id}::uuid, ${JSON.stringify(patch)}::jsonb, ${why}::text, ${version}::int) AS r`);
    return r[0]!.r;
  }

  /** POST /settings/holidays */
  async create(auth: AuthContext, raw: unknown) {
    void auth;
    await this.access.requireAdmin('calendars', 'edit');
    const b = parse(createSchema, raw);
    if (b.calendar_code) {
      const c = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM work_calendars WHERE code = ${b.calendar_code}`);
      if (c.length === 0) throw problems.validation([{ path: '/calendar_code', code: 'unknown_calendar', message: 'Unknown calendar.' }]);
    }
    await this.duplicate(b.calendar_code, b.date);
    const out = await this.save(null, { calendar_code: b.calendar_code, date: b.date, name: b.name_en, name_ar: b.name_ar, kind: b.kind, tentative: b.tentative }, b.reason, null);
    return this.result((await this.one(out.id))!, out.affected_open_tasks);
  }

  /** PATCH /settings/holidays/{id} */
  async update(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown) {
    void auth;
    await this.access.requireAdmin('calendars', 'edit');
    const version = parseIfMatch(ifMatch);
    const cur = await this.mustExist(rawId);
    const b = parse(patchSchema, raw);
    if (b.date && b.date !== cur.date) await this.duplicate(cur.calendar_code, b.date, cur.id);
    const out = await this.save(cur.id, { date: b.date, name: b.name_en, name_ar: b.name_ar, kind: b.kind }, b.reason, version);
    return this.result((await this.one(out.id))!, out.affected_open_tasks);
  }

  /** POST /settings/holidays/{id}/confirm */
  async confirm(auth: AuthContext, rawId: string, ifMatch: string | undefined, raw: unknown) {
    void auth;
    await this.access.requireAdmin('calendars', 'edit');
    const version = parseIfMatch(ifMatch);
    const cur = await this.mustExist(rawId);
    const b = parse(confirmSchema, raw);
    if (b.date && b.date !== cur.date) await this.duplicate(cur.calendar_code, b.date, cur.id);
    const out = await this.save(cur.id, { date: b.date, confirm: true }, b.reason, version);
    return this.result((await this.one(out.id))!, out.affected_open_tasks);
  }

  /** DELETE /settings/holidays/{id}?reason= (step-up) */
  async remove(auth: AuthContext, rawId: string, ifMatch: string | undefined, q: Query) {
    await this.access.requireAdmin('calendars', 'edit');
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    const why = parse(reason, oneParam(q, 'reason') ?? '');
    const cur = await this.mustExist(rawId);
    const r = await this.db.tx.$queryRaw<{ r: { affected_open_tasks: number } }[]>(Prisma.sql`
      SELECT admin_delete_holiday(${cur.id}::uuid, ${why}::text, ${version}::int) AS r`);
    return { holiday: toDto(cur), affected_open_tasks: r[0]!.r.affected_open_tasks, recalculation_job_id: null };
  }

  /** PUT /settings/weekend-days (step-up) */
  async setWeekend(auth: AuthContext, raw: unknown) {
    await this.access.requireAdmin('calendars', 'edit');
    await this.stepUp.require(auth);
    const b = parse(weekendSchema, raw);
    if (b.calendar_code) {
      const c = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM work_calendars WHERE code = ${b.calendar_code}`);
      if (c.length === 0) throw problems.notFound('The calendar does not exist.');
    }
    const r = await this.db.tx.$queryRaw<{ r: { calendar_code: string; weekend_days: number[]; affected_open_tasks: number; version: number } }[]>(Prisma.sql`
      SELECT admin_save_weekend_days(${b.calendar_code ?? null}::text, ${b.weekend_days}::int[], ${b.reason}::text) AS r`);
    return r[0]!.r;
  }

  /**
   * POST /settings/holidays/import (0145, B12, ADR 0011: the approved xlsx template TPL-HOLIDAYS only). The upload guards of the other imports apply: the size limit
   * of the upload interceptor (413), the xlsx guard (no macros, no zip bomb) before any parser, the hidden _tpl sheet naming TPL-HOLIDAYS and its current version,
   * and the header row as issued; each rejection goes to the System Log. The file itself is never stored (like the other template imports), so it is not sent to the
   * virus scanner. The rows go to admin_import_holidays in one call: every row is checked, one bad row refuses the file, and the open tasks are recalculated once.
   */
  async importHolidays(auth: AuthContext, file: UploadedFile | undefined, rawReason: unknown, requestId: string | undefined) {
    await this.access.requireAdmin('calendars', 'edit');
    const why = parse(reason, rawReason ?? '');
    if (!file || file.size === 0) throw problems.validation([{ path: '/file', code: 'required', message: 'Send the filled TPL-HOLIDAYS template as the form field "file".' }]);
    const fileName = (file.originalname ?? '').slice(0, 200);
    const reject = async (code: string, detail: string, ctx: Record<string, unknown> = {}): Promise<never> => {
      await this.syslog.write('warn', `holidays import rejected: ${code}`, { reason: code, detail, file_name: fileName, ...ctx }, auth.user.id, requestId, 'holidays-import');
      throw new ProblemException(422, 'template_rejected', { detail, extra: { reason: code }, commit: true });
    };
    const guard = guardXlsx(file.originalname ?? '', file.buffer);
    if (!guard.ok) return reject(guard.reason ?? 'not_xlsx', guard.detail ?? 'The file is not accepted: upload the TPL-HOLIDAYS template (.xlsx).');
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
    if (!tpl) return reject('tpl_missing', 'This file is not an approved GSDN Workspace template: the hidden _tpl sheet is missing. Download TPL-HOLIDAYS from the Templates page.');
    const kv = new Map<string, string>();
    tpl.eachRow((row) => {
      const k = text(row.getCell(1));
      if (k) kv.set(k, text(row.getCell(2)));
    });
    const templateId = (kv.get('template_id') ?? '').slice(0, 60);
    const versionText = (kv.get('version') ?? '').slice(0, 12);
    if (templateId !== 'TPL-HOLIDAYS' || !/^[0-9]{1,6}$/.test(versionText)) {
      return reject('wrong_template', `This file is not the holidays template (TPL-HOLIDAYS); it names ${templateId || 'no template'}.`, { template_id: templateId });
    }
    const cur = await this.db.tx.$queryRaw<{ current_version: number; columns: { header: string }[] }[]>(Prisma.sql`
      SELECT d.current_version, v.columns FROM template_definitions d
      JOIN template_versions v ON v.template_def_id = d.id AND v.is_current
      WHERE d.template_id = 'TPL-HOLIDAYS' AND d.is_active`);
    if (!cur[0]) return reject('template_unknown_or_inactive', 'The holidays template is not in use.');
    const version = Number(versionText);
    if (version !== cur[0].current_version) {
      return reject('outdated_version', `This file was made from version ${version} of TPL-HOLIDAYS; the current version is ${cur[0].current_version}. Download the template again.`,
        { version, current_version: cur[0].current_version });
    }
    const data = wb.getWorksheet(DATA_SHEET);
    if (!data) return reject('checksum_mismatch', 'The Data sheet is missing.');
    const headers = cur[0].columns.map((c) => c.header);
    const head = data.getRow(1);
    if (headers.some((h, i) => text(head.getCell(i + 1)) !== h)) {
      return reject('checksum_mismatch', 'The header row of the file was changed. Use the template as it was issued, without adding, moving or renaming columns.');
    }
    const rows: Record<string, unknown>[] = [];
    for (let r = 2; r <= data.rowCount; r++) {
      const cells = HOLIDAY_KEYS.map((_, i) => text(data.getRow(r).getCell(i + 1)));
      if (cells.every((v) => v === '')) continue;
      if (rows.length >= importMaxRows()) return reject('size_or_rows_exceeded', `At most ${importMaxRows()} holidays per file.`);
      const row: Record<string, unknown> = { line: r };
      HOLIDAY_KEYS.forEach((k, i) => { row[k] = cells[i]; });
      rows.push(row);
    }
    if (rows.length === 0) throw problems.validation([{ path: '/file', code: 'empty', message: 'The Data sheet has no holiday row.' }]);
    const meta = { file_name: fileName, template_version: version };
    const out = await this.db.tx.$queryRaw<{ r: { id: string; created: number; unchanged: number; affected_open_tasks: number } }[]>(Prisma.sql`
      SELECT admin_import_holidays(${JSON.stringify(rows)}::jsonb, ${why}::text, ${JSON.stringify(meta)}::jsonb) AS r`);
    const r = out[0]!.r;
    await this.syslog.write('info', 'holidays imported', { import_id: r.id, created: r.created, unchanged: r.unchanged, version }, auth.user.id, requestId, 'holidays-import');
    return {
      id: r.id,
      template_id: 'TPL-HOLIDAYS',
      template_version: version,
      source: 'template',
      file_name: fileName,
      status: 'applied',
      current_level: 2,
      levels_required: 2,
      register_key: null,
      entity: null,
      stream: null,
      counts: { create: r.created, update: 0, unchanged: r.unchanged, error: 0 },
      affected_open_tasks: r.affected_open_tasks,
      version: 1,
    };
  }
}
