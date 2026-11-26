import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { decodeTypedCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { isCalendarDate, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskViewService, UserRefDto } from '../workflow/task-view.service';

const KINDS = ['annual', 'sick', 'emergency', 'other'] as const;
const dateSchema = z.string().refine(isCalendarDate, 'not a calendar date');
const inputSchema = z
  .object({
    user_id: z.guid().optional(),
    kind: z.enum(KINDS),
    from_date: dateSchema,
    to_date: dateSchema,
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.to_date >= v.from_date, { path: ['to_date'], message: 'to_date is before from_date' });
const patchSchema = z
  .object({ kind: z.enum(KINDS).optional(), from_date: dateSchema.optional(), to_date: dateSchema.optional(), note: z.string().max(500).nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field');

export interface AbsenceRow {
  id: string;
  user_id: string;
  kind: string;
  from_date: string;
  to_date: string;
  note: string | null;
  recorded_by: string;
  version: number;
}

export interface AbsenceDto {
  id: string;
  user: UserRefDto;
  kind: string;
  from_date: string;
  to_date: string;
  note: string | null;
  recorded_by: UserRefDto;
  self_recorded: boolean;
  open_task_count: number;
  version: number;
}

const UNKNOWN: UserRefDto = { id: '00000000-0000-0000-0000-000000000000', display_name: 'Unknown', employee_id: null };

/**
 * Absence records (B12b, migration 0140). Informational: nothing moves when one is recorded. Reads go through rsn_visible_absences (own, the people the
 * caller leads, all for a System Admin); writes through ops_save_absence / ops_delete_absence, which check who may record what and audit before and after.
 */
@Injectable()
export class AbsencesService {
  constructor(private readonly db: DbService, private readonly view: TaskViewService) {}

  private async call<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  private select(where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Promise<AbsenceRow[]> {
    return this.db.tx.$queryRaw<AbsenceRow[]>(Prisma.sql`
      SELECT ab.id::text AS id, ab.user_id::text AS user_id, ab.kind, ab.from_date::text AS from_date, ab.to_date::text AS to_date, ab.note,
        ab.recorded_by::text AS recorded_by, ab.version
      FROM rsn_visible_absences() ab WHERE ${where} ${tail}`);
  }

  async dtos(rows: AbsenceRow[]): Promise<AbsenceDto[]> {
    if (rows.length === 0) return [];
    const people = [...new Set(rows.flatMap((r) => [r.user_id, r.recorded_by]))];
    const refs = await this.view.userRefs(people);
    const owners = [...new Set(rows.map((r) => r.user_id))];
    const counts = new Map(
      (await this.db.tx.$queryRaw<{ user_id: string; n: number }[]>(Prisma.sql`SELECT user_id::text AS user_id, n FROM rsn_open_task_counts(${owners}::uuid[])`))
        .map((c) => [c.user_id, Number(c.n)]),
    );
    return rows.map((r) => ({
      id: r.id,
      user: refs.get(r.user_id) ?? UNKNOWN,
      kind: r.kind,
      from_date: r.from_date,
      to_date: r.to_date,
      note: r.note,
      recorded_by: refs.get(r.recorded_by) ?? UNKNOWN,
      self_recorded: r.recorded_by === r.user_id,
      open_task_count: counts.get(r.user_id) ?? 0,
      version: r.version,
    }));
  }

  async list(_auth: AuthContext, q: Record<string, unknown>): Promise<{ items: AbsenceDto[]; page: { limit: number; next_cursor: string | null } }> {
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeTypedCursor(oneParam(q, 'cursor'), ['date', 'uuid']);
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    const user = oneParam(q, 'user_id');
    if (user !== undefined) {
      if (!uuidSchema.safeParse(user).success) throw problems.validation([{ path: '/user_id', code: 'invalid', message: 'user_id is a uuid.' }]);
      conds.push(Prisma.sql`ab.user_id = ${user}::uuid`);
    }
    for (const key of ['active_on', 'from', 'to'] as const) {
      const v = oneParam(q, key);
      if (v === undefined) continue;
      if (!isCalendarDate(v)) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is a date.` }]);
      if (key === 'active_on') conds.push(Prisma.sql`${v}::date BETWEEN ab.from_date AND ab.to_date`);
      if (key === 'from') conds.push(Prisma.sql`ab.to_date >= ${v}::date`);
      if (key === 'to') conds.push(Prisma.sql`ab.from_date <= ${v}::date`);
    }
    const kind = oneParam(q, 'kind');
    if (kind !== undefined) {
      if (!(KINDS as readonly string[]).includes(kind)) throw problems.validation([{ path: '/kind', code: 'invalid', message: 'kind is annual, sick, emergency or other.' }]);
      conds.push(Prisma.sql`ab.kind = ${kind}`);
    }
    if (cursor) conds.push(Prisma.sql`(ab.from_date, ab.id) < (${cursor[0] as string}::date, ${cursor[1] as string}::uuid)`);
    const rows = await this.select(Prisma.join(conds, ' AND '), Prisma.sql`ORDER BY ab.from_date DESC, ab.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.dtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.from_date, last.id]) : null } };
  }

  async get(_auth: AuthContext, id: string): Promise<AbsenceDto> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const [dto] = await this.dtos(await this.select(Prisma.sql`ab.id = ${id}::uuid`));
    if (!dto) throw problems.notFound();
    return dto;
  }

  async create(auth: AuthContext, raw: unknown): Promise<AbsenceDto> {
    const b = parse(inputSchema, raw);
    const id = await this.call<string>(Prisma.sql`SELECT ops_save_absence(NULL::uuid, NULL::int, ${JSON.stringify(b)}::jsonb)::text AS r`);
    return this.get(auth, id);
  }

  async patch(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<AbsenceDto> {
    const version = parseIfMatch(ifMatch);
    const b = parse(patchSchema, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.call<string>(Prisma.sql`SELECT ops_save_absence(${id}::uuid, ${version}::int, ${JSON.stringify(b)}::jsonb)::text AS r`);
    return this.get(auth, id);
  }

  async remove(_auth: AuthContext, id: string, ifMatch: string | undefined): Promise<void> {
    const version = parseIfMatch(ifMatch);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.call<unknown>(Prisma.sql`SELECT true AS r FROM (SELECT ops_delete_absence(${id}::uuid, ${version}::int)) x`);
  }
}
