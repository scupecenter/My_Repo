import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeTypedCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { isCalendarDate, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskViewService, UserRefDto } from '../workflow/task-view.service';

const health = z.enum(['on_track', 'at_risk', 'off_track']);
const postSchema = z
  .object({
    scope: z.enum(['region', 'team']),
    region_id: z.number().int().min(1).max(7).optional(),
    team: z.enum(['cw', 'te']).optional(),
    health,
    summary: z.string().trim().min(1).max(4000),
  })
  .strict();
const patchSchema = z
  .object({ health: health.optional(), summary: z.string().trim().min(1).max(4000).optional() })
  .strict()
  .refine((v) => v.health !== undefined || v.summary !== undefined, 'send health or summary');

interface Row {
  id: string;
  scope: string;
  region_id: number | null;
  team: string | null;
  week_start: string;
  week_end: string;
  health: string;
  summary: string;
  author_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  editable: boolean;
  ts: string;
}

export interface StatusUpdateDto extends Omit<Row, 'author_id' | 'ts'> {
  author: UserRefDto;
}

/** X7: weekly status updates. Reads follow the Sites regions of the caller; writes go through x_status_post / x_status_edit (lead only, audited). */
@Injectable()
export class StatusUpdatesService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly view: TaskViewService) {}

  private select(auth: AuthContext, where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Promise<Row[]> {
    return this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT u.id::text AS id, u.scope, u.region_id, u.team, u.week_start::text AS week_start, (u.week_start + 6)::text AS week_end, u.health, u.summary,
        u.author_id::text AS author_id, u.version, u.created_at, u.updated_at,
        (u.author_id = ${auth.user.id}::uuid AND cal_today() <= u.week_start + 6) AS editable,
        to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
      FROM status_updates u WHERE ${where} ${tail}`);
  }

  private async dtos(rows: Row[]): Promise<StatusUpdateDto[]> {
    const refs = await this.view.userRefs([...new Set(rows.map((r) => r.author_id))]);
    const unknown: UserRefDto = { id: '00000000-0000-0000-0000-000000000000', display_name: 'Unknown', employee_id: null };
    return rows.map(({ author_id, ts, ...r }) => {
      void ts;
      return { ...r, author: refs.get(author_id) ?? unknown };
    });
  }

  async list(auth: AuthContext, q: Record<string, unknown>) {
    const regions = await this.access.requireRegions('sites', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeTypedCursor(oneParam(q, 'cursor'), ['date', 'ts', 'uuid']);
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (regions !== null) conds.push(Prisma.sql`(u.region_id IS NULL OR u.region_id = ANY(${regions}::int[]))`);
    const scope = oneParam(q, 'scope');
    if (scope) {
      if (!['region', 'team'].includes(scope)) throw problems.validation([{ path: '/scope', code: 'invalid', message: 'scope is region or team.' }]);
      conds.push(Prisma.sql`u.scope = ${scope}`);
    }
    const region = oneParam(q, 'region_id');
    if (region) {
      if (!/^[1-7]$/.test(region)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
      conds.push(Prisma.sql`u.region_id = ${Number(region)}`);
    }
    const team = oneParam(q, 'team');
    if (team) {
      if (!['cw', 'te'].includes(team)) throw problems.validation([{ path: '/team', code: 'invalid', message: 'team is cw or te.' }]);
      conds.push(Prisma.sql`u.team = ${team}`);
    }
    const week = oneParam(q, 'week_start');
    if (week) {
      if (!isCalendarDate(week)) throw problems.validation([{ path: '/week_start', code: 'invalid', message: 'week_start is a date.' }]);
      conds.push(Prisma.sql`u.week_start = ${week}::date`);
    }
    if (cursor) conds.push(Prisma.sql`(u.week_start, u.created_at, u.id) < (${cursor[0] as string}::date, ${cursor[1] as string}::timestamptz, ${cursor[2] as string}::uuid)`);
    const rows = await this.select(auth, Prisma.join(conds, ' AND '), Prisma.sql`ORDER BY u.week_start DESC, u.created_at DESC, u.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.dtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.week_start, last.ts, last.id]) : null } };
  }

  private async one(auth: AuthContext, id: string): Promise<StatusUpdateDto> {
    const rows = await this.select(auth, Prisma.sql`u.id = ${id}::uuid`);
    const [dto] = await this.dtos(rows);
    if (!dto) throw problems.notFound();
    return dto;
  }

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

  async post(auth: AuthContext, raw: unknown): Promise<StatusUpdateDto> {
    const b = parse(postSchema, raw);
    await this.access.requireRegions('sites', 'view');
    const id = await this.call<string>(
      Prisma.sql`SELECT x_status_post(${b.scope}::text, ${b.region_id ?? null}::int, ${b.team ?? null}::text, ${b.health}::text, ${b.summary}::text)::text AS r`);
    return this.one(auth, id);
  }

  async patch(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<StatusUpdateDto> {
    const version = parseIfMatch(ifMatch);
    const b = parse(patchSchema, raw);
    await this.access.requireRegions('sites', 'view');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.call<unknown>(
      Prisma.sql`SELECT true AS r FROM (SELECT x_status_edit(${id}::uuid, ${version}::int, ${b.health ?? null}::text, ${b.summary ?? null}::text)) v`);
    return this.one(auth, id);
  }
}
