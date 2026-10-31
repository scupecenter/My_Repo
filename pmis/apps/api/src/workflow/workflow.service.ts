import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { TS_TEXT, oneParam } from '../common/query';
import { DbService } from '../db/db.service';
import { TaskDetailDto, TaskDetailService } from './task-detail.service';
import { TaskViewService, UserRefDto } from './task-view.service';

export type TransitionAction = 'submit' | 'review' | 'approve';

export interface WfResult {
  step_ids: string[];
  skipped_levels: number[];
  unlocked_task_ids: string[];
  votes_missing?: number;
  returned_to_level?: number;
}

export interface TransitionResultDto extends WfResult {
  task: TaskDetailDto;
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'not a calendar date');
const noteSchema = z.object({ note: z.string().max(2000).optional() }).strict();
const startSchema = z.object({ actual_start: dateSchema.optional() }).strict();
const rejectSchema = z
  .object({
    note: z.string().max(2000).optional(),
    rejected_slots: z.array(z.object({ slot_id: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict()).max(100).optional(),
  })
  .strict();
const patchSchema = z
  .object({
    actual_start: dateSchema.nullable().optional(),
    actual_date: dateSchema.nullable().optional(),
    planned_date: dateSchema.nullable().optional(),
    values: z.record(z.unknown()).optional(),
    custom: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field');
const commentSchema = z
  .object({ body: z.string().trim().min(1).max(4000), mention_user_ids: z.array(z.string().uuid()).max(20).optional() })
  .strict();

export interface CommentDto {
  id: string;
  author: UserRefDto;
  body: string;
  is_rejection_note: boolean;
  mentions: UserRefDto[];
  created_at: Date;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly detail: TaskDetailService,
    private readonly view: TaskViewService,
  ) {}

  /**
   * The database decides every transition. The call runs under a savepoint so that, after a refusal, the transaction is still usable
   * (the claimant of an `already_claimed` answer is looked up). A step-up the engine needs but the session lacks becomes 401 with the
   * right method.
   */
  private async call(auth: AuthContext, sql: Prisma.Sql): Promise<WfResult> {
    await this.db.tx.$executeRaw`SAVEPOINT wf_call`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: WfResult }[]>(sql);
      const r = rows[0]?.r;
      if (!r) throw new ProblemException(500, 'internal_error', {});
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT wf_call`;
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT wf_call`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', {
          detail: 'Confirm your password to continue.',
          step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365',
        });
      }
      if (p.code === 'already_claimed') {
        const id = (p.opts.extra?.claimed_by as { id?: string } | undefined)?.id;
        const ref = id ? (await this.view.userRefs([id])).get(id) : undefined;
        if (ref) throw new ProblemException(409, 'already_claimed', { ...p.opts, extra: { claimed_by: ref } });
      }
      throw p;
    }
  }

  private async result(auth: AuthContext, taskId: string, r: WfResult): Promise<TransitionResultDto> {
    const task = await this.detail.get(auth, taskId);
    const out: TransitionResultDto = { task, step_ids: r.step_ids ?? [], skipped_levels: r.skipped_levels ?? [], unlocked_task_ids: r.unlocked_task_ids ?? [] };
    if (r.votes_missing !== undefined) out.votes_missing = r.votes_missing;
    if (r.returned_to_level !== undefined) out.returned_to_level = r.returned_to_level;
    return out;
  }

  /** The task must be visible (404 / 403 module_forbidden) before anything else is asked of the caller. */
  private async visible(auth: AuthContext, taskId: string): Promise<void> {
    await this.detail.rowFor(auth, taskId);
  }

  /** submit / review / approve. `approve` always needs step-up; the other two only when the chain reaches final approval. */
  async transition(auth: AuthContext, taskId: string, action: TransitionAction, ifMatch: string | undefined, rawBody: unknown): Promise<TransitionResultDto> {
    const version = parseIfMatch(ifMatch);
    const body = parse(noteSchema, rawBody ?? {});
    await this.visible(auth, taskId);
    if (action === 'approve') await this.stepUp.require(auth);
    const r = await this.transitionRaw(auth, taskId, action, version, body.note ?? null);
    return this.result(auth, taskId, r);
  }

  /** The database call alone (also used one by one by the bulk endpoint). */
  async transitionRaw(auth: AuthContext, taskId: string, action: TransitionAction, version: number | null, note: string | null): Promise<WfResult> {
    const stepOk = Boolean(await this.stepUp.validUntil(auth));
    const fn = action === 'submit' ? Prisma.sql`wf_submit` : action === 'review' ? Prisma.sql`wf_review` : Prisma.sql`wf_approve`;
    return this.call(auth, Prisma.sql`SELECT ${fn}(${taskId}::uuid, ${version}::int, ${note}::text, ${stepOk}::boolean) AS r`);
  }

  async start(auth: AuthContext, taskId: string, ifMatch: string | undefined, rawBody: unknown): Promise<TransitionResultDto> {
    const version = parseIfMatch(ifMatch);
    const body = parse(startSchema, rawBody ?? {});
    await this.visible(auth, taskId);
    const r = await this.call(auth, Prisma.sql`SELECT wf_start(${taskId}::uuid, ${version}::int, ${body.actual_start ?? null}::date) AS r`);
    return this.result(auth, taskId, r);
  }

  async reject(auth: AuthContext, taskId: string, ifMatch: string | undefined, rawBody: unknown): Promise<TransitionResultDto> {
    const version = parseIfMatch(ifMatch);
    const body = parse(rejectSchema, rawBody ?? {});
    if (!body.note || body.note.trim() === '') {
      throw new ProblemException(422, 'note_required', { detail: 'A rejection needs a note.', errors: [{ path: '/note', code: 'required', message: 'A note is required.' }] });
    }
    await this.visible(auth, taskId);
    const slots = JSON.stringify(body.rejected_slots ?? []);
    const r = await this.call(auth, Prisma.sql`SELECT wf_reject(${taskId}::uuid, ${version}::int, ${body.note}::text, ${slots}::jsonb) AS r`);
    return this.result(auth, taskId, r);
  }

  async claim(auth: AuthContext, taskId: string, ifMatch: string | undefined): Promise<TransitionResultDto> {
    const version = parseIfMatch(ifMatch);
    await this.visible(auth, taskId);
    const r = await this.call(auth, Prisma.sql`SELECT wf_claim(${taskId}::uuid, ${version}::int) AS r`);
    return this.result(auth, taskId, r);
  }

  async release(auth: AuthContext, taskId: string, ifMatch: string | undefined): Promise<TransitionResultDto> {
    const version = parseIfMatch(ifMatch);
    await this.visible(auth, taskId);
    const r = await this.call(auth, Prisma.sql`SELECT wf_release(${taskId}::uuid, ${version}::int) AS r`);
    return this.result(auth, taskId, r);
  }

  async saveEntry(auth: AuthContext, taskId: string, ifMatch: string | undefined, rawBody: unknown): Promise<TaskDetailDto> {
    const version = parseIfMatch(ifMatch);
    const body = parse(patchSchema, rawBody);
    if (body.custom && Object.keys(body.custom).length > 0) {
      throw problems.validation([{ path: '/custom', code: 'not_supported', message: 'Custom fields on tasks cannot be saved here yet.' }]);
    }
    await this.visible(auth, taskId);
    const { custom: _custom, ...patch } = body;
    void _custom;
    try {
      await this.db.tx.$executeRaw(Prisma.sql`SELECT wf_save_entry(${taskId}::uuid, ${version}::int, ${JSON.stringify(patch)}::jsonb)`);
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
    return this.detail.get(auth, taskId);
  }

  // ------------------------------------------------------------------ history and comments
  async history(auth: AuthContext, taskId: string, q: Record<string, unknown>): Promise<{ items: unknown[]; page: { limit: number; next_cursor: string | null } }> {
    await this.visible(auth, taskId);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const after = cursor ? Prisma.sql`AND (w.created_at, w.id) > (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<
      {
        id: string; level: number; action: string; acted_by: string | null; on_behalf_of: string | null; note: string | null; before_state: string | null; after_state: string | null;
        self_approval: boolean; admin_override: boolean; stepup_verified: boolean; batch_row_id: string | null; created_at: Date; ts: string;
      }[]
    >(Prisma.sql`
      SELECT w.id::text AS id, w.level, w.action::text AS action, w.acted_by::text AS acted_by, w.on_behalf_of::text AS on_behalf_of, w.note,
        w.before_state::text AS before_state, w.after_state::text AS after_state, w.self_approval, w.admin_override, w.stepup_verified,
        w.batch_row_id::text AS batch_row_id, w.created_at, ${Prisma.raw(TS_TEXT('w.created_at'))} AS ts
      FROM workflow_steps w WHERE w.task_id = ${taskId}::uuid ${after} ORDER BY w.created_at, w.id LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const refs = await this.view.userRefs([...new Set(page.flatMap((r) => [r.acted_by, r.on_behalf_of]).filter((x): x is string => !!x))]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const item: Record<string, unknown> = {
          id: r.id,
          level: r.level,
          action: r.action,
          note: r.note,
          self_approval: r.self_approval,
          admin_override: r.admin_override,
          stepup_verified: r.stepup_verified,
          batch_row_id: r.batch_row_id,
          created_at: r.created_at,
        };
        if (r.acted_by && refs.get(r.acted_by)) item.acted_by = refs.get(r.acted_by);
        if (r.on_behalf_of && refs.get(r.on_behalf_of)) item.on_behalf_of = refs.get(r.on_behalf_of);
        if (r.before_state) item.before_state = r.before_state;
        if (r.after_state) item.after_state = r.after_state;
        return item;
      }),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null },
    };
  }

  private async commentDtos(rows: { id: string; author_id: string; body: string; is_rejection_note: boolean; created_at: Date }[]): Promise<CommentDto[]> {
    if (rows.length === 0) return [];
    const mentions = await this.db.tx.$queryRaw<{ comment_id: string; user_id: string }[]>(
      Prisma.sql`SELECT comment_id::text AS comment_id, user_id::text AS user_id FROM comment_mentions WHERE comment_id = ANY(${rows.map((r) => r.id)}::uuid[])`);
    const refs = await this.view.userRefs([...new Set([...rows.map((r) => r.author_id), ...mentions.map((m) => m.user_id)])]);
    const unknown: UserRefDto = { id: '00000000-0000-0000-0000-000000000000', display_name: 'Unknown', employee_id: null };
    return rows.map((r) => ({
      id: r.id,
      author: refs.get(r.author_id) ?? unknown,
      body: r.body,
      is_rejection_note: r.is_rejection_note,
      mentions: mentions.filter((m) => m.comment_id === r.id).map((m) => refs.get(m.user_id)).filter((x): x is UserRefDto => !!x),
      created_at: r.created_at,
    }));
  }

  async comments(auth: AuthContext, taskId: string, q: Record<string, unknown>): Promise<{ items: CommentDto[]; page: { limit: number; next_cursor: string | null } }> {
    await this.visible(auth, taskId);
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const after = cursor ? Prisma.sql`AND (c.created_at, c.id) > (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<{ id: string; author_id: string; body: string; is_rejection_note: boolean; created_at: Date; ts: string }[]>(Prisma.sql`
      SELECT c.id::text AS id, c.author_id::text AS author_id, c.body, c.is_rejection_note, c.created_at, ${Prisma.raw(TS_TEXT('c.created_at'))} AS ts
      FROM comments c WHERE c.task_id = ${taskId}::uuid ${after} ORDER BY c.created_at, c.id LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.commentDtos(page), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null } };
  }

  async addComment(auth: AuthContext, taskId: string, rawBody: unknown): Promise<CommentDto> {
    const body = parse(commentSchema, rawBody);
    await this.visible(auth, taskId);
    let id: string;
    try {
      const rows = await this.db.tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT wf_add_comment(${taskId}::uuid, ${body.body}::text, ${body.mention_user_ids ?? []}::uuid[])::text AS id`);
      id = rows[0]?.id ?? '';
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
    const rows = await this.db.tx.$queryRaw<{ id: string; author_id: string; body: string; is_rejection_note: boolean; created_at: Date }[]>(
      Prisma.sql`SELECT id::text AS id, author_id::text AS author_id, body, is_rejection_note, created_at FROM comments WHERE id = ${id}::uuid`);
    const [dto] = await this.commentDtos(rows);
    if (!dto) throw new ProblemException(500, 'internal_error', {});
    return dto;
  }

  isUuid(v: string): boolean {
    return uuidSchema.safeParse(v).success;
  }
}
