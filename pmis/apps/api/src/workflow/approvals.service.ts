import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { IdempotencyService } from '../common/idempotency.service';
import { ProblemException, problems } from '../common/problem';
import { TS_TEXT, boolParam, oneParam } from '../common/query';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskViewService, UserRefDto, taskSelect } from './task-view.service';
import { WorkflowService } from './workflow.service';

const bulkSchema = z
  .object({
    action: z.enum(['pass', 'approve']),
    items: z.array(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }).strict()).min(1).max(200),
    note: z.string().max(2000).optional(),
  })
  .strict();

interface BulkIssue {
  ref: string;
  code: string;
  message?: string;
}
export interface BulkResultDto {
  bulk_action_id: string;
  done: { id: string; skipped_levels?: number[] }[];
  skipped: BulkIssue[];
  failed: BulkIssue[];
}

interface InboxExtra {
  id: string;
  kind: string;
  waiting_since: Date;
  ts: string;
  via_group_id: string | null;
  via_group_name: string | null;
  via_group_admins: boolean | null;
  will_self_skip: boolean;
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly view: TaskViewService,
    private readonly workflow: WorkflowService,
    private readonly idem: IdempotencyService,
  ) {}

  /**
   * The inbox: tasks at a review or approve level where the caller can act. A group level shows for every member until one claims it;
   * a claimed level only for the claimant; a level nobody can hold (B10) shows for the System Admins; under all_members it shows for
   * the members who have not voted yet.
   */
  async list(auth: AuthContext, q: Record<string, unknown>): Promise<unknown> {
    const regions = await this.access.requireRegions('approvals', 'view');
    const sitesRegions = await this.access.requireRegions('sites', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const tab = oneParam(q, 'tab') ?? 'all';
    if (!['all', 'review', 'approve'].includes(tab)) throw problems.validation([{ path: '/tab', code: 'invalid', message: 'tab is all, review or approve.' }]);
    const stage = oneParam(q, 'stage_code');
    const text = oneParam(q, 'q')?.trim();
    const groupOnly = boolParam(q, 'group_only');
    const regionFilter = this.intList(q, 'region_id');
    const me = auth.user.id;

    // both modules limit the regions: the task must be visible in Sites and the caller must use Approvals there
    const conds: Prisma.Sql[] = [Prisma.sql`t.state IN ('in_review', 'in_approval')`];
    if (regions !== null) conds.push(Prisma.sql`t.region_id = ANY(${regions}::int[])`);
    if (sitesRegions !== null) conds.push(Prisma.sql`t.region_id = ANY(${sitesRegions}::int[])`);
    if (regionFilter.length > 0) conds.push(Prisma.sql`t.region_id = ANY(${regionFilter}::int[])`);
    if (stage) conds.push(Prisma.sql`st.code = ${stage}`);
    if (text) conds.push(Prisma.sql`(s.site_code ILIKE ${likePattern(text)} OR s.name ILIKE ${likePattern(text)} OR td.name_en ILIKE ${likePattern(text)} OR td.code ILIKE ${likePattern(text)})`);
    if (tab !== 'all') conds.push(Prisma.sql`k.kind = ${tab}`);
    conds.push(Prisma.sql`(
      (k.rule::text = 'all_members' AND EXISTS (SELECT 1 FROM task_level_voters v WHERE v.task_id = t.id AND v.level = t.current_level AND v.round = t.level_round
                                               AND v.user_id = ${me}::uuid AND v.voted_at IS NULL))
      OR (k.rule::text <> 'all_members' AND wf_is_eligible(t.id, k.kind, ${me}::uuid)
          AND (t.ball_in_court_user_id IS NULL OR t.ball_in_court_user_id = ${me}::uuid OR NOT wf_is_eligible(t.id, k.kind, t.ball_in_court_user_id)))
      OR (${auth.state.isAdmin}::boolean AND k.has_holder = false)
    )`);
    if (cursor) {
      conds.push(Prisma.sql`(coalesce(t.level_opened_at, t.updated_at), t.id) > (${cursor[0] as string}::timestamptz, ${cursor[1] as string}::uuid)`);
    }
    const where = Prisma.join(conds, ' AND ');

    // taskSelect() puts the filter on alias t and joins s, td, st, lv and k itself
    const rows = await this.view.rows(taskSelect(where, Prisma.sql`ORDER BY coalesce(t.level_opened_at, t.updated_at), t.id LIMIT ${limit + 1}`));
    const page = rows.slice(0, limit);
    const summaries = await this.view.withLockReasons(page);
    const ids = page.map((r) => r.id);
    const extras = ids.length
      ? await this.db.tx.$queryRaw<InboxExtra[]>(Prisma.sql`
          SELECT t.id::text AS id, wf_kind(CASE WHEN t.path_frozen_at IS NULL THEN wf_levels_live(t.id) ELSE t.levels_required END, t.current_level) AS kind,
            coalesce(t.level_opened_at, t.updated_at) AS waiting_since, ${Prisma.raw(TS_TEXT('coalesce(t.level_opened_at, t.updated_at)'))} AS ts,
            e.via_group::text AS via_group_id, g.name AS via_group_name, g.is_system_admins AS via_group_admins,
            coalesce((SELECT array_length(c.skipped, 1) > 0 FROM wf_chain(t.id, t.current_level, ${me}::uuid) c), false) AS will_self_skip
          FROM task_instances t
          LEFT JOIN LATERAL (SELECT x.via_group FROM wf_eligible(t.id, wf_kind(CASE WHEN t.path_frozen_at IS NULL THEN wf_levels_live(t.id) ELSE t.levels_required END, t.current_level)) x
                             WHERE x.user_id = ${me}::uuid) e ON true
          LEFT JOIN groups g ON g.id = e.via_group
          WHERE t.id = ANY(${ids}::uuid[])`)
      : [];
    const submitters = ids.length
      ? await this.db.tx.$queryRaw<{ task_id: string; acted_by: string }[]>(Prisma.sql`
          SELECT DISTINCT ON (w.task_id) w.task_id::text AS task_id, w.acted_by::text AS acted_by
          FROM workflow_steps w WHERE w.task_id = ANY(${ids}::uuid[]) AND w.action::text = 'submit' AND w.acted_by IS NOT NULL
          ORDER BY w.task_id, w.created_at DESC`)
      : [];
    const refs = await this.view.userRefs([...new Set(submitters.map((s) => s.acted_by))]);
    const slotRows = ids.length
      ? await this.db.tx.$queryRaw<{ task_id: string; slot_id: string; name: string; status: string; file_count: bigint }[]>(Prisma.sql`
          SELECT ds.task_id::text AS task_id, ds.id::text AS slot_id, dt.name_en AS name, ds.status::text AS status,
            (SELECT count(*) FROM document_files f WHERE f.slot_id = ds.id AND f.is_current) AS file_count
          FROM document_slots ds JOIN document_types dt ON dt.id = ds.doc_type_id WHERE ds.task_id = ANY(${ids}::uuid[]) ORDER BY dt.code, ds.id`)
      : [];

    let items = summaries.map((task) => {
      const x = extras.find((e) => e.id === task.id);
      const sub = submitters.find((s) => s.task_id === task.id);
      const item: Record<string, unknown> = {
        task,
        level_kind: x?.kind === 'approve' ? 'approve' : 'review',
        waiting_since: x?.waiting_since ?? new Date(),
        will_self_skip: x?.will_self_skip ?? false,
        documents_summary: slotRows
          .filter((s) => s.task_id === task.id)
          .map((s) => ({ slot_id: s.slot_id, name: s.name, status: s.status, file_count: Number(s.file_count) })),
      };
      if (x?.via_group_id) item.via_group = { id: x.via_group_id, name: x.via_group_name ?? '', is_system_admins: x.via_group_admins === true };
      const ref: UserRefDto | undefined = sub ? refs.get(sub.acted_by) : undefined;
      if (ref) item.submitted_by = ref;
      return item;
    });
    if (groupOnly === true) items = items.filter((i) => i.via_group !== undefined);
    const last = page[page.length - 1];
    const lastExtra = last ? extras.find((e) => e.id === last.id) : undefined;
    return { items, page: { limit, next_cursor: rows.length > limit && lastExtra ? encodeCursor([lastExtra.ts, lastExtra.id]) : null } };
  }

  private intList(q: Record<string, unknown>, key: string): number[] {
    const v = q[key];
    if (v === undefined) return [];
    const arr = Array.isArray(v) ? v : [v];
    const out: number[] = [];
    for (const x of arr) {
      const n = typeof x === 'string' && /^[0-9]+$/.test(x) ? Number(x) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 7) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is a region id from 1 to 7.` }]);
      out.push(n);
    }
    return out;
  }

  /**
   * Pass or approve many tasks with one step-up. Each item runs under its own savepoint: a refusal for one does not undo the others.
   * A task that cannot take the action now (wrong level, claimed by another holder) is skipped; everything else that fails is failed.
   */
  async bulk(auth: AuthContext, raw: unknown, idempotencyKey: string | undefined): Promise<BulkResultDto> {
    const body = parse(bulkSchema, raw);
    await this.access.requireRegions('approvals', 'view');
    await this.stepUp.require(auth);
    return this.idem.run(auth.user.id, 'bulkApprovals', idempotencyKey, body, async () => {
      const result: BulkResultDto = { bulk_action_id: randomUUID(), done: [], skipped: [], failed: [] };
      const seen = new Set<string>();
      for (const item of body.items) {
        if (seen.has(item.id)) {
          result.skipped.push({ ref: item.id, code: 'duplicate', message: 'The task is listed twice.' });
          continue;
        }
        seen.add(item.id);
        await this.db.tx.$executeRaw`SAVEPOINT bulk_item`;
        try {
          const r = await this.workflow.transitionRaw(auth, item.id, body.action === 'pass' ? 'review' : 'approve', item.version, body.note ?? null);
          await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_item`;
          result.done.push({ id: item.id, skipped_levels: r.skipped_levels ?? [] });
        } catch (e) {
          await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_item`;
          if (!(e instanceof ProblemException)) throw e;
          const issue: BulkIssue = { ref: item.id, code: e.code, message: e.opts.detail };
          if (e.code === 'invalid_transition' || e.code === 'already_claimed') result.skipped.push(issue);
          else if (e.code === 'step_up_required') throw e;
          else result.failed.push(issue);
        }
      }
      return result;
    });
  }
}
