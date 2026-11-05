import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DocumentFileDto, DocumentSlotDto, DocumentsService } from '../documents/documents.service';
import { LevelCode, TaskRow, TaskSummaryDto, TaskViewService, UserRefDto, levelCode, taskSelect } from './task-view.service';

export interface AllowedActionDto {
  action: string;
  step_up?: boolean;
  will_skip_to?: number | null;
  final?: boolean;
  disabled_reason?: string | null;
}

export interface ApprovalPathLevelDto {
  level: number;
  kind: 'entry' | 'review' | 'approve';
  level_code: LevelCode;
  status: 'pending' | 'current' | 'done' | 'skipped' | 'returned';
  acted_by?: UserRefDto;
  acted_at?: Date | null;
  will_skip?: boolean;
}

export type { DocumentFileDto, DocumentSlotDto };

export type TaskDetailDto = TaskSummaryDto & {
  baseline_date: string | null;
  planned_start: string | null;
  actual_start: string | null;
  submitted_date: string | null;
  approved_date: string | null;
  prefill_date: string | null;
  values: Record<string, unknown>;
  field_access: Record<string, 'read' | 'edit'>;
  approval_path: ApprovalPathLevelDto[];
  slots: DocumentSlotDto[];
  missing_for_submit: string[];
  allowed_actions: AllowedActionDto[];
  is_na: boolean;
  na_reason: string | null;
  workflow_version: number;
  /** Q462 (0073): why the task carries `historical_no_documents`; null when it does not. */
  historical_load: { batch_id: string; cutoff_date: string | null; flagged_at: Date | null; missing_documents: string[]; reason: string | null } | null;
};

@Injectable()
export class TaskDetailService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly view: TaskViewService,
    private readonly documents: DocumentsService,
  ) {}

  /** Visible task row by id: region and module scope of the caller (404 outside it). */
  async rowFor(auth: AuthContext, id: string): Promise<TaskRow> {
    const regions = await this.access.requireRegions('sites', 'view');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const where = regions === null ? Prisma.sql`t.id = ${id}::uuid` : Prisma.sql`t.id = ${id}::uuid AND t.region_id = ANY(${regions}::int[])`;
    const rows = await this.view.rows(taskSelect(where));
    const row = rows[0];
    if (!row) throw problems.notFound('The task does not exist or is not visible to you.');
    void auth;
    return row;
  }

  async get(auth: AuthContext, id: string): Promise<TaskDetailDto> {
    const row = await this.rowFor(auth, id);
    return this.build(auth, row);
  }

  async build(auth: AuthContext, row: TaskRow): Promise<TaskDetailDto> {
    const [summary] = await this.view.withLockReasons([row]);
    if (!summary) throw problems.notFound();
    const [path, slots, missing, allowed] = await Promise.all([this.approvalPath(auth, row), this.slots(auth, row.id), this.missingForSubmit(row), this.allowedActions(auth, row)]);
    return {
      ...summary,
      baseline_date: row.baseline_date,
      planned_start: row.planned_start,
      actual_start: row.actual_start,
      submitted_date: row.submitted_date,
      approved_date: row.approved_date,
      prefill_date: typeof (row.values as Record<string, unknown> | null)?.prefilled_date === 'string' ? ((row.values as Record<string, unknown>).prefilled_date as string) : null,
      values: row.values && typeof row.values === 'object' ? (row.values as Record<string, unknown>) : {},
      field_access: {},
      approval_path: path,
      slots,
      missing_for_submit: missing.all,
      allowed_actions: allowed.map((a) => (a.action === 'submit' && missing.all.length > 0 ? { ...a, disabled_reason: `Missing: ${missing.all.join(', ')}` } : a)),
      is_na: row.is_na,
      na_reason: row.na_reason,
      workflow_version: row.workflow_version,
      historical_load: await this.historicalLoad(row),
    };
  }

  private async historicalLoad(row: TaskRow): Promise<TaskDetailDto['historical_load']> {
    if (!row.historical_no_documents || !row.historical_batch_id) return null;
    const b = await this.db.tx.$queryRaw<{ cutoff: string | null; reason: string | null }[]>(Prisma.sql`
      SELECT historical_cutoff::text AS cutoff, historical_reason AS reason FROM import_batches WHERE id = ${row.historical_batch_id}::uuid`);
    return { batch_id: row.historical_batch_id, cutoff_date: b[0]?.cutoff ?? null, flagged_at: row.historical_flagged_at, missing_documents: row.historical_missing ?? [], reason: b[0]?.reason ?? null };
  }

  /** Mandatory fields and document slots the task still lacks for submission. */
  private async missingForSubmit(row: TaskRow): Promise<{ fields: string[]; slots: string[]; all: string[] }> {
    if (row.state !== 'entry' && row.state !== 'open') return { fields: [], slots: [], all: [] };
    const fields = row.actual_date === null ? ['actual_date'] : [];
    const s = await this.db.tx.$queryRaw<{ m: string[] }[]>(Prisma.sql`SELECT wf_missing_slots(${row.id}::uuid) AS m`);
    const slots = s[0]?.m ?? [];
    return { fields, slots, all: [...fields, ...slots] };
  }

  private async approvalPath(auth: AuthContext, row: TaskRow): Promise<ApprovalPathLevelDto[]> {
    const actors = await this.db.tx.$queryRaw<{ level: number; user_id: string; how: string; acted_at: Date }[]>(
      Prisma.sql`SELECT level, user_id::text AS user_id, how, acted_at FROM task_level_actors WHERE task_id = ${row.id}::uuid`);
    const lastStep = await this.db.tx.$queryRaw<{ action: string }[]>(
      Prisma.sql`SELECT action::text AS action FROM workflow_steps WHERE task_id = ${row.id}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`);
    const refs = await this.view.userRefs([...new Set(actors.map((a) => a.user_id))]);
    let skipping = new Set<number>();
    if (this.view.isActiveState(row.state)) {
      const ch = await this.db.tx.$queryRaw<{ skipped: number[] }[]>(
        Prisma.sql`SELECT skipped FROM wf_chain(${row.id}::uuid, ${Math.max(row.current_level, 1)}::int, ${auth.user.id}::uuid)`);
      skipping = new Set(ch[0]?.skipped ?? []);
    }
    const out: ApprovalPathLevelDto[] = [];
    for (let level = 1; level <= row.n_levels; level++) {
      const kind = level === 1 ? 'entry' : level >= row.n_levels ? 'approve' : 'review';
      const a = actors.find((x) => x.level === level);
      const current = this.view.isActiveState(row.state) && level === Math.max(row.current_level, 1);
      let status: ApprovalPathLevelDto['status'] = 'pending';
      if (row.state === 'approved') status = a?.how === 'skipped' ? 'skipped' : 'done';
      else if (current) status = lastStep[0]?.action === 'reject' ? 'returned' : 'current';
      else if (a) status = a.how === 'skipped' ? 'skipped' : 'done';
      const item: ApprovalPathLevelDto = { level, kind, level_code: levelCode(kind), status };
      if (a && !current) {
        const ref = refs.get(a.user_id);
        if (ref) item.acted_by = ref;
        item.acted_at = a.acted_at;
      }
      if (!a && skipping.has(level)) item.will_skip = true;
      out.push(item);
    }
    return out;
  }

  async slots(auth: AuthContext, taskId: string): Promise<DocumentSlotDto[]> {
    return this.documents.slotsForVisibleTask(auth, taskId);
  }

  /**
   * What the caller may do now, from the same functions the transitions use (holder resolution, claim, chain). The transitions repeat
   * every check, so this list only drives the buttons.
   */
  private async allowedActions(auth: AuthContext, row: TaskRow): Promise<AllowedActionDto[]> {
    if (!this.view.isActiveState(row.state) || !row.kind) return [{ action: 'comment' }];
    const me = auth.user.id;
    const [editR, approveR] = await Promise.all([this.access.regions('sites', 'edit'), this.access.regions('sites', 'approve')]);
    const allows = (regions: number[] | null): boolean => regions === null || regions.includes(row.region_id);
    const lvl = Math.max(row.current_level, 1);
    const q = await this.db.tx.$queryRaw<{ elig: boolean; pinned_elig: boolean | null; n_elig: bigint; voter: boolean; voted: boolean }[]>(Prisma.sql`
      SELECT wf_is_eligible(${row.id}::uuid, ${row.kind}, ${me}::uuid) AS elig,
        CASE WHEN ${row.pinned_user}::text IS NULL THEN NULL ELSE wf_is_eligible(${row.id}::uuid, ${row.kind}, ${row.pinned_user}::uuid) END AS pinned_elig,
        (SELECT count(*) FROM wf_eligible(${row.id}::uuid, ${row.kind})) AS n_elig,
        EXISTS (SELECT 1 FROM task_level_voters v WHERE v.task_id = ${row.id}::uuid AND v.level = ${lvl}::int AND v.round = (SELECT level_round FROM task_instances WHERE id = ${row.id}::uuid) AND v.user_id = ${me}::uuid) AS voter,
        EXISTS (SELECT 1 FROM task_level_voters v WHERE v.task_id = ${row.id}::uuid AND v.level = ${lvl}::int AND v.round = (SELECT level_round FROM task_instances WHERE id = ${row.id}::uuid) AND v.user_id = ${me}::uuid AND v.voted_at IS NOT NULL) AS voted`);
    const info = q[0];
    if (!info) return [{ action: 'comment' }];
    const isAdminFallback = auth.state.isAdmin && row.has_holder === false;
    const allMembers = row.rule === 'all_members' && row.kind !== 'entry';
    const mayAct = allMembers ? (info.voter && !info.voted) || (isAdminFallback && Number(row.votes_needed ?? 0) === 0) : info.elig || isAdminFallback;
    const blockedByClaim = !allMembers && row.pinned_user !== null && row.pinned_user !== me && info.pinned_elig === true;
    const can = mayAct && !blockedByClaim;
    const out: AllowedActionDto[] = [{ action: 'comment' }];
    if (!can) return out;

    const chainRows = await this.db.tx.$queryRaw<{ next_level: number | null; skipped: number[]; is_final: boolean }[]>(
      Prisma.sql`SELECT next_level, skipped, is_final FROM wf_chain(${row.id}::uuid, ${lvl}::int, ${me}::uuid)`);
    const chain = chainRows[0] ?? { next_level: null, skipped: [], is_final: false };
    const finalNeedsApprove = chain.is_final && row.kind !== 'approve';

    if (row.state === 'open' && allows(editR)) {
      out.push({ action: 'start' }, { action: 'edit' });
    } else if (row.state === 'entry' && allows(editR)) {
      out.push({ action: 'edit' });
      if (!finalNeedsApprove || allows(approveR)) {
        out.push({
          action: 'submit',
          step_up: chain.is_final,
          will_skip_to: chain.skipped.length > 0 && !chain.is_final ? chain.next_level : null,
          final: chain.is_final,
        });
      }
    } else if (row.state === 'in_review') {
      if (!finalNeedsApprove || allows(approveR)) {
        out.push({
          action: 'review',
          step_up: chain.is_final,
          will_skip_to: chain.skipped.length > 0 && !chain.is_final ? chain.next_level : null,
          final: chain.is_final,
        });
      }
      out.push({ action: 'reject' });
    } else if (row.state === 'in_approval' && allows(approveR)) {
      out.push({ action: 'approve', step_up: true, final: true }, { action: 'reject' });
    }
    if (!allMembers) {
      if (row.pinned_user === me) out.push({ action: 'release' });
      else if (row.pinned_user === null || info.pinned_elig === false) {
        if (Number(info.n_elig) > 1) out.push({ action: 'claim' });
      }
    }
    return out;
  }
}
