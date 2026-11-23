import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { IdempotencyService } from '../common/idempotency.service';
import { ProblemException, problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskSummaryDto, TaskViewService, UserRefDto, accountStatus, taskSelect } from '../workflow/task-view.service';
import { AbsenceDto, AbsenceRow, AbsencesService } from './absences.service';

const CAUSES = ['holder_deactivated', 'absent', 'idle'] as const;
type Cause = (typeof CAUSES)[number];

const reassignSchema = z
  .object({
    scope: z.enum(['task', 'site', 'person']),
    task_id: z.string().uuid().optional(),
    site_id: z.string().uuid().optional(),
    from_user_id: z.string().uuid().optional(),
    decision: z.enum(['reassign', 'act_on_behalf', 'keep']),
    to_user_id: z.string().uuid().optional(),
    reason: z.string().trim().min(3).max(1000),
    dry_run: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === 'task' && !v.task_id) ctx.addIssue({ code: 'custom', path: ['task_id'], message: 'scope task needs task_id' });
    if (v.scope !== 'task' && !v.from_user_id) ctx.addIssue({ code: 'custom', path: ['from_user_id'], message: 'scope site or person needs from_user_id' });
    if (v.scope === 'site' && !v.site_id) ctx.addIssue({ code: 'custom', path: ['site_id'], message: 'scope site needs site_id' });
    if (v.decision === 'reassign' && !v.to_user_id) ctx.addIssue({ code: 'custom', path: ['to_user_id'], message: 'reassign needs to_user_id' });
  });

interface BulkIssue {
  ref: string;
  code: string;
  message?: string;
}
export interface ReassignResultDto {
  bulk_action_id: string;
  dry_run: boolean;
  done: { id: string }[];
  skipped: BulkIssue[];
  failed: BulkIssue[];
}

export interface ReassignmentAlertDto {
  task: TaskSummaryDto;
  cause: Cause;
  holder_account_status?: 'active' | 'deactivated' | 'deleted';
  holder?: UserRefDto;
  absence: AbsenceDto | null;
  idle_working_days: number | null;
}

const RANK: Record<Cause, number> = { holder_deactivated: 0, absent: 1, idle: 2 };

/**
 * B12b (migration 0140): the tasks that need a lead decision, the people who may receive them, and the decision itself (keep, reassign, act on behalf).
 * The database decides every rule (who leads which region, whom a task is on, who is eligible); the API validates the shape and pages.
 */
@Injectable()
export class ReassignmentService {
  constructor(
    private readonly db: DbService,
    private readonly view: TaskViewService,
    private readonly absences: AbsencesService,
    private readonly idem: IdempotencyService,
  ) {}

  private async q<T>(sql: Prisma.Sql): Promise<T[]> {
    try {
      return await this.db.tx.$queryRaw<T[]>(sql);
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  private uuidParam(q: Record<string, unknown>, key: string): string | undefined {
    const v = oneParam(q, key);
    if (v !== undefined && !uuidSchema.safeParse(v).success) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is a uuid.` }]);
    return v;
  }

  async alerts(_auth: AuthContext, q: Record<string, unknown>): Promise<{ items: ReassignmentAlertDto[]; page: { limit: number; next_cursor: string | null } }> {
    const limit = parseLimit(oneParam(q, 'limit'));
    const cause = oneParam(q, 'cause');
    if (cause !== undefined && !(CAUSES as readonly string[]).includes(cause)) {
      throw problems.validation([{ path: '/cause', code: 'invalid', message: 'cause is absent, idle or holder_deactivated.' }]);
    }
    const user = this.uuidParam(q, 'user_id');
    const regionRaw = oneParam(q, 'region_id');
    if (regionRaw !== undefined && !/^[1-7]$/.test(regionRaw)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    if (cursor && (!/^[0-2]$/.test(cursor[0] as string) || !uuidSchema.safeParse(cursor[1]).success)) throw problems.badRequest('The cursor is not valid.');

    const rows = await this.q<{ task_id: string; cause: Cause; holder_id: string | null; absence_id: string | null; idle_wd: number | null }>(Prisma.sql`
      SELECT task_id::text AS task_id, cause, holder_id::text AS holder_id, absence_id::text AS absence_id, idle_wd
      FROM rsn_alerts(${cause ?? null}::text, ${user ?? null}::uuid, ${regionRaw ? Number(regionRaw) : null}::int)`);
    const sorted = rows
      .map((r) => ({ ...r, rank: RANK[r.cause] }))
      .sort((a, b) => a.rank - b.rank || a.task_id.localeCompare(b.task_id))
      .filter((r) => !cursor || r.rank > Number(cursor[0]) || (r.rank === Number(cursor[0]) && r.task_id > (cursor[1] as string)));
    const page = sorted.slice(0, limit);
    const last = page[page.length - 1];

    const ids = [...new Set(page.map((r) => r.task_id))];
    const tasks = ids.length ? await this.view.withLockReasons(await this.view.rows(taskSelect(Prisma.sql`t.id = ANY(${ids}::uuid[])`))) : [];
    const byTask = new Map(tasks.map((t) => [t.id, t]));
    const holders = await this.view.usersByIds([...new Set(page.map((r) => r.holder_id).filter((x): x is string => !!x))]);
    const absenceIds = [...new Set(page.map((r) => r.absence_id).filter((x): x is string => !!x))];
    const absences = new Map((absenceIds.length ? await this.absences.dtos(await this.q<AbsenceRow>(Prisma.sql`
      SELECT ab.id::text AS id, ab.user_id::text AS user_id, ab.kind, ab.from_date::text AS from_date, ab.to_date::text AS to_date, ab.note,
        ab.recorded_by::text AS recorded_by, ab.version
      FROM rsn_visible_absences() ab WHERE ab.id = ANY(${absenceIds}::uuid[])`)) : []).map((a) => [a.id, a]));

    const items: ReassignmentAlertDto[] = [];
    for (const r of page) {
      const task = byTask.get(r.task_id);
      if (!task) continue;
      const h = r.holder_id ? holders.get(r.holder_id) : undefined;
      const item: ReassignmentAlertDto = { task, cause: r.cause, absence: r.absence_id ? absences.get(r.absence_id) ?? null : null, idle_working_days: r.idle_wd ?? null };
      if (h) {
        item.holder = { id: h.id, display_name: h.display_name, employee_id: h.employee_id?.trim() ?? null };
        item.holder_account_status = accountStatus(h.status, h.deleted_at !== null);
      }
      items.push(item);
    }
    return { items, page: { limit, next_cursor: sorted.length > limit && last ? encodeCursor([String(last.rank), last.task_id]) : null } };
  }

  async eligible(_auth: AuthContext, q: Record<string, unknown>): Promise<{ items: UserRefDto[]; page: { limit: number; next_cursor: string | null } }> {
    const limit = parseLimit(oneParam(q, 'limit'));
    const task = this.uuidParam(q, 'task_id');
    const site = this.uuidParam(q, 'site_id');
    const from = this.uuidParam(q, 'from_user_id');
    if (!task && !from) throw problems.validation([{ path: '/task_id', code: 'required', message: 'Pass task_id, or from_user_id (with site_id for one site).' }]);
    if (site && !from && !task) throw problems.validation([{ path: '/from_user_id', code: 'required', message: 'site_id needs from_user_id.' }]);
    const text = oneParam(q, 'q')?.trim();
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    if (cursor && !uuidSchema.safeParse(cursor[1]).success) throw problems.badRequest('The cursor is not valid.');
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (text) conds.push(Prisma.sql`(u.display_name ILIKE ${likePattern(text)} OR coalesce(u.employee_id, '') ILIKE ${likePattern(text)})`);
    if (cursor) conds.push(Prisma.sql`(u.display_name, u.id) > (${cursor[0] as string}::text, ${cursor[1] as string}::uuid)`);
    const rows = await this.q<{ id: string; display_name: string; employee_id: string | null }>(Prisma.sql`
      SELECT u.id::text AS id, u.display_name, u.employee_id
      FROM rsn_eligible_users(${task ?? null}::uuid, ${site ?? null}::uuid, ${from ?? null}::uuid) e JOIN users u ON u.id = e.user_id
      WHERE ${Prisma.join(conds, ' AND ')} ORDER BY u.display_name, u.id LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, display_name: r.display_name, employee_id: r.employee_id?.trim() ?? null })),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.display_name, last.id]) : null },
    };
  }

  async reassign(auth: AuthContext, raw: unknown, key: string | undefined): Promise<ReassignResultDto> {
    const b = parse(reassignSchema, raw);
    return this.idem.run(auth.user.id, 'tasks.reassign', key, b, async () => {
      let r: ReassignResultDto | undefined;
      try {
        [r] = (await this.db.tx.$queryRaw<{ r: ReassignResultDto }[]>(Prisma.sql`SELECT ops_reassign_tasks(${JSON.stringify(b)}::jsonb) AS r`)).map((x) => x.r);
      } catch (e) {
        const p = mapDbError(e);
        if (!p) throw e;
        // the person named to receive the tasks cannot hold any (inactive, absent today, the same person): the request itself is refused
        if (p.code === 'not_eligible_holder') throw new ProblemException(422, 'not_eligible_holder', { detail: p.opts.detail, errors: [{ path: '/to_user_id', code: 'not_eligible_holder' }] });
        throw p;
      }
      if (!r) throw new ProblemException(500, 'internal_error', {});
      // one task: its refusal is the answer (the screen shows it), as for the single transitions
      const only = r.failed[0];
      if (b.scope === 'task' && only && r.done.length === 0) {
        throw new ProblemException(only.code === 'not_eligible_holder' ? 422 : 409, only.code === 'not_eligible_holder' ? 'not_eligible_holder' : 'invalid_transition', {
          detail: only.message,
          errors: only.code === 'not_eligible_holder' ? [{ path: '/to_user_id', code: 'not_eligible_holder' }] : undefined,
        });
      }
      return r;
    });
  }
}
