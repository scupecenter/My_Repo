import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { OverrideDto, OverrideJson, overrideDtos } from './override-dto';
import { TaskDetailService } from './task-detail.service';
import { TaskViewService } from './task-view.service';

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'not a calendar date');
/** The contract's OverrideRequest. Only `edit_date` is built (0088); the database answers 422 not_supported for the other kinds. */
const createSchema = z.object({
  kind: z.enum(['unlock', 'skip', 'mark_na', 'accept_without_document', 'accept_without_workflow', 'reopen', 'edit_date', 'reassign']),
  reason: z.string().trim().min(3).max(2000),
  date_field: z.enum(['actual_start', 'actual_date', 'planned_date', 'baseline_date']).optional(),
  new_date: dateSchema.nullable().optional(),
  reassign_to_user_id: z.string().uuid().optional(),
}).strict();
const revertSchema = z.object({ reason: z.string().trim().min(3).max(2000) }).strict();

/** Owner decision 2026-11-12 (2), migration 0088: the admin override of a task (edit_date) and the revert of an override (a task date or a site edit). */
@Injectable()
export class OverridesService {
  constructor(private readonly db: DbService, private readonly view: TaskViewService, private readonly detail: TaskDetailService) {}

  private async call(auth: AuthContext, sql: Prisma.Sql): Promise<OverrideJson> {
    await this.db.tx.$executeRaw`SAVEPOINT ov_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: OverrideJson }[]>(sql);
      const r = rows[0]?.r;
      if (!r) throw new ProblemException(500, 'internal_error', {});
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT ov_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT ov_call`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365' });
      }
      throw p;
    }
  }

  /** POST /tasks/{task_id}/overrides */
  async create(auth: AuthContext, taskId: string, ifMatch: string | undefined, raw: unknown): Promise<OverrideDto> {
    const version = parseIfMatch(ifMatch);
    const body = parse(createSchema, raw);
    await this.detail.rowFor(auth, taskId);
    const hasDate = Object.prototype.hasOwnProperty.call(body, 'new_date');
    const r = await this.call(auth, Prisma.sql`
      SELECT task_override_create(${taskId}::uuid, ${version}::int, ${body.kind}::text, ${body.reason}::text, ${body.date_field ?? null}::text, ${body.new_date ?? null}::date, ${hasDate}::boolean) AS r`);
    return (await overrideDtos(this.view, [r]))[0]!;
  }

  /** POST /overrides/{override_id}/revert */
  async revert(auth: AuthContext, id: string, raw: unknown): Promise<OverrideDto> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The override does not exist or is not visible to you.');
    const body = parse(revertSchema, raw);
    const r = await this.call(auth, Prisma.sql`SELECT admin_override_revert(${id}::uuid, ${body.reason}::text) AS r`);
    return (await overrideDtos(this.view, [r]))[0]!;
  }

  /** The overrides of a task for TaskDetail (the caller can see the task). */
  async listFor(taskId: string): Promise<OverrideDto[]> {
    const rows = await this.db.tx.$queryRaw<{ r: OverrideJson[] }[]>(Prisma.sql`SELECT task_overrides_json(${taskId}::uuid) AS r`);
    return overrideDtos(this.view, rows[0]?.r ?? []);
  }
}
