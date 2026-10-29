import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems, ProblemException } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

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
    const s = await this.db.tx.$queryRaw<{ tentative_count: bigint; next_tentative_date: string | null; reminder: boolean; next_year: number; next_n: bigint }[]>(Prisma.sql`
      SELECT (SELECT count(*) FROM holidays WHERE tentative) AS tentative_count,
             (SELECT min(date)::text FROM holidays WHERE tentative AND date >= cal_today()) AS next_tentative_date,
             EXISTS (SELECT 1 FROM holidays WHERE tentative AND date BETWEEN cal_today() AND cal_today() + 14) AS reminder,
             (extract(year FROM cal_today()) + 1)::int AS next_year,
             (SELECT count(*) FROM holidays WHERE extract(year FROM date) = extract(year FROM cal_today()) + 1) AS next_n`);
    const r = s[0];
    return {
      items: rows.map(toDto),
      summary: {
        tentative_count: Number(r?.tentative_count ?? 0),
        next_tentative_date: r?.next_tentative_date ?? null,
        tentative_reminder_due: r?.reminder === true,
        next_year: r?.next_year ?? new Date().getUTCFullYear() + 1,
        next_year_table_empty: Number(r?.next_n ?? 0) === 0,
      },
    };
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
}
