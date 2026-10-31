import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskRow, TaskSummaryDto, TaskViewService, UserRefDto, taskSelect } from './task-view.service';

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
  status: 'pending' | 'current' | 'done' | 'skipped' | 'returned';
  acted_by?: UserRefDto;
  acted_at?: Date | null;
  will_skip?: boolean;
}

export interface DocumentFileDto {
  id: string;
  file_group_id: string;
  version: number;
  is_current: boolean;
  original_name: string;
  download_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by?: UserRefDto;
  uploaded_at: Date;
  approved_date: string | null;
}

export interface DocumentSlotDto {
  id: string;
  doc_code: string;
  name_en: string;
  name_ar: string | null;
  kind: string;
  mandatory: boolean;
  status: string;
  reject_reason: string | null;
  candidate_label: string | null;
  formats: string[];
  max_size_mb: number;
  min_files: number;
  max_files: number | null;
  camera_only: boolean;
  blank_form_file_id: string | null;
  valid_to: string | null;
  files: DocumentFileDto[];
}

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
};

interface SlotRow {
  id: string;
  doc_code: string;
  name_en: string;
  name_ar: string | null;
  kind: string;
  mandatory: boolean;
  status: string;
  reject_reason: string | null;
  candidate_label: string | null;
  formats: string[];
  max_size_mb: number;
  min_files: number;
  max_files: number | null;
  photo_rules: unknown;
  blank_form_file_id: string | null;
  valid_to: string | null;
}

interface FileRow {
  id: string;
  slot_id: string;
  file_group_id: string;
  version: number;
  is_current: boolean;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: bigint;
  sha256: string;
  uploaded_by: string;
  uploaded_at: Date;
  approved_date: string | null;
}

@Injectable()
export class TaskDetailService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly view: TaskViewService,
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
    const [path, slots, missing, allowed] = await Promise.all([this.approvalPath(auth, row), this.slots(row.id), this.missingForSubmit(row), this.allowedActions(auth, row)]);
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
    };
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
      const item: ApprovalPathLevelDto = { level, kind, status };
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

  async slots(taskId: string): Promise<DocumentSlotDto[]> {
    const slots = await this.db.tx.$queryRaw<SlotRow[]>(Prisma.sql`
      SELECT ds.id::text AS id, dt.code AS doc_code, dt.name_en, dt.name_ar, dt.kind::text AS kind, dt.is_mandatory AS mandatory,
        ds.status::text AS status, ds.reject_reason, ds.candidate_label, dt.formats, dt.max_size_mb, dt.min_files, dt.max_files, dt.photo_rules,
        dt.blank_form_file_id::text AS blank_form_file_id, ds.valid_to::text AS valid_to
      FROM document_slots ds JOIN document_types dt ON dt.id = ds.doc_type_id
      WHERE ds.task_id = ${taskId}::uuid ORDER BY dt.code, ds.candidate_label NULLS FIRST, ds.id`);
    if (slots.length === 0) return [];
    const files = await this.db.tx.$queryRaw<FileRow[]>(Prisma.sql`
      SELECT f.id::text AS id, f.slot_id::text AS slot_id, f.file_group_id::text AS file_group_id, f.version, f.is_current, f.original_name, f.stored_name,
        f.mime_type, f.size_bytes, f.sha256, f.uploaded_by::text AS uploaded_by, f.uploaded_at, f.approved_date::text AS approved_date
      FROM document_files f WHERE f.slot_id = ANY(${slots.map((s) => s.id)}::uuid[]) ORDER BY f.uploaded_at, f.id`);
    const refs = await this.view.userRefs([...new Set(files.map((f) => f.uploaded_by))]);
    return slots.map((s) => ({
      id: s.id,
      doc_code: s.doc_code,
      name_en: s.name_en,
      name_ar: s.name_ar,
      kind: s.kind,
      mandatory: s.mandatory,
      status: s.status,
      reject_reason: s.reject_reason,
      candidate_label: s.candidate_label,
      formats: s.formats,
      max_size_mb: s.max_size_mb,
      min_files: s.min_files,
      max_files: s.max_files,
      camera_only: typeof s.photo_rules === 'object' && s.photo_rules !== null && (s.photo_rules as { camera_only?: unknown }).camera_only === true,
      blank_form_file_id: s.blank_form_file_id,
      valid_to: s.valid_to,
      files: files
        .filter((f) => f.slot_id === s.id)
        .map((f) => {
          const u = refs.get(f.uploaded_by);
          const dto: DocumentFileDto = {
            id: f.id,
            file_group_id: f.file_group_id,
            version: f.version,
            is_current: f.is_current,
            original_name: f.original_name,
            download_name: f.stored_name,
            mime_type: f.mime_type,
            size_bytes: Number(f.size_bytes),
            sha256: f.sha256,
            uploaded_at: f.uploaded_at,
            approved_date: f.approved_date,
          };
          if (u) dto.uploaded_by = u;
          return dto;
        }),
    }));
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
