import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/auth.types';
import { DbService } from '../db/db.service';

export interface UserRefDto {
  id: string;
  display_name: string;
  employee_id: string | null;
}

export interface MatrixAssigneeDto {
  kind: 'user' | 'role' | 'group';
  ref_id: string;
  label: string;
  employee_id: string | null;
  user_id?: string;
  account_status?: 'active' | 'deactivated' | 'deleted';
}

export interface BallInCourtDto {
  level: number;
  level_kind: 'entry' | 'review' | 'approve';
  holders: MatrixAssigneeDto[];
  rule: 'any_one' | 'all_members';
  claimed_by?: UserRefDto;
  votes_done?: number;
  votes_needed?: number;
  external_party?: { id: string; name: string; type: string };
  no_eligible_holder: boolean;
}

export interface TaskSummaryDto {
  id: string;
  site_id: string;
  site_code: string;
  region_id: number;
  task_code: string;
  name_en: string;
  name_ar: string | null;
  stage_code: string;
  stream_code: string | null;
  state: string;
  current_level: number;
  levels_required: number;
  ball_in_court?: BallInCourtDto;
  planned_date: string | null;
  actual_date: string | null;
  sla: {
    code: string | null;
    min_wd: number | null;
    max_wd: number | null;
    start_event: string | null;
    start_date: string | null;
    elapsed_wd: number | null;
    due_date: string | null;
    colour: 'none';
    rule_id: string | null;
    rule_set_version: number | null;
  };
  slots_filled: number;
  slots_required: number;
  template_id: string | null;
  return_count: number;
  last_return_note: string | null;
  admin_override: boolean;
  holder_account_status?: 'active' | 'deactivated' | 'deleted';
  lock_reasons: { kind: string; ref_code: string | null; message: string; count: number | null }[];
  version: number;
}

export interface TaskRow {
  id: string;
  site_id: string;
  site_code: string;
  region_id: number;
  task_def_id: string;
  task_code: string;
  name_en: string;
  name_ar: string | null;
  stage_code: string;
  stream_code: string | null;
  state: string;
  current_level: number;
  n_levels: number;
  frozen: boolean;
  planned_date: string | null;
  actual_date: string | null;
  due_date: string | null;
  planned_start: string | null;
  actual_start: string | null;
  submitted_date: string | null;
  approved_date: string | null;
  baseline_date: string | null;
  values: unknown;
  sla_rule_id: string | null;
  sla_min: number | null;
  sla_max: number | null;
  sla_start: string | null;
  return_count: number;
  last_return_note: string | null;
  admin_override: boolean;
  is_na: boolean;
  na_reason: string | null;
  version: number;
  pinned_user: string | null;
  external_party_id: string | null;
  workflow_version: number;
  kind: string | null;
  cell_id: string | null;
  rule: string | null;
  has_holder: boolean | null;
  votes_needed: bigint | null;
  votes_done: bigint | null;
  slots_filled: bigint;
  slots_required: bigint;
}

interface AssigneeRow {
  cell_id: string;
  kind: string;
  ref_id: string;
  label: string;
  employee_id: string | null;
  status: string | null;
  deleted: boolean | null;
}

interface UserLite {
  id: string;
  display_name: string;
  employee_id: string | null;
  status: string;
  deleted_at: Date | null;
}

const ACTIVE_STATES = ['open', 'entry', 'in_review', 'in_approval'];

/** The columns every task read needs. `${where}` must filter on alias t (task_instances); s, td, st and lv are joined here. */
export function taskSelect(extraWhere: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`
    SELECT t.id::text AS id, t.site_id::text AS site_id, s.site_code, t.region_id, t.task_def_id::text AS task_def_id,
      td.code AS task_code, td.name_en, td.name_ar, st.code AS stage_code, st.stream_code,
      t.state::text AS state, t.current_level, lv.n AS n_levels, (t.path_frozen_at IS NOT NULL) AS frozen,
      t.planned_date::text AS planned_date, t.actual_date::text AS actual_date, t.due_date::text AS due_date,
      t.planned_start::text AS planned_start, t.actual_start::text AS actual_start, t.submitted_date::text AS submitted_date,
      t.approved_date::text AS approved_date, t.baseline_date::text AS baseline_date, t.values AS "values",
      t.sla_rule_id::text AS sla_rule_id, r.min_working_days AS sla_min, r.max_working_days AS sla_max, r.start_event AS sla_start,
      t.return_count, t.last_return_note, t.admin_override, t.is_na, t.na_reason, t.version,
      t.ball_in_court_user_id::text AS pinned_user, t.external_party_id::text AS external_party_id, wd.version AS workflow_version,
      k.kind, k.cell_id::text AS cell_id, k.rule::text AS rule, k.has_holder,
      k.votes_needed, k.votes_done,
      (SELECT count(*) FROM document_slots ds JOIN document_types dt ON dt.id = ds.doc_type_id
         WHERE ds.task_id = t.id AND dt.is_mandatory AND ds.status IN ('uploaded', 'in_review', 'approved')) AS slots_filled,
      (SELECT count(*) FROM document_slots ds JOIN document_types dt ON dt.id = ds.doc_type_id
         WHERE ds.task_id = t.id AND dt.is_mandatory) AS slots_required
    FROM task_instances t
    JOIN sites s ON s.id = t.site_id
    JOIN workflow_definitions wd ON wd.id = s.workflow_version_id
    JOIN task_definitions td ON td.id = t.task_def_id
    JOIN stage_definitions st ON st.id = td.stage_id
    JOIN LATERAL (SELECT CASE WHEN t.path_frozen_at IS NULL THEN least(greatest(coalesce(td.approval_levels, st.approval_levels), 1), 3)
                              ELSE t.levels_required END AS n) lv ON true
    LEFT JOIN sla_rules r ON r.id = t.sla_rule_id
    LEFT JOIN LATERAL (
      SELECT x.kind, wf_cell(t.id, x.kind) AS cell_id, wf_rule(t.id, x.kind) AS rule, wf_has_holder(t.id, x.kind) AS has_holder,
        (SELECT count(*) FROM task_level_voters v WHERE v.task_id = t.id AND v.level = t.current_level AND v.round = t.level_round) AS votes_needed,
        (SELECT count(*) FROM task_level_voters v WHERE v.task_id = t.id AND v.level = t.current_level AND v.round = t.level_round AND v.voted_at IS NOT NULL) AS votes_done
      FROM (SELECT CASE WHEN t.state IN ('open', 'entry', 'in_review', 'in_approval') THEN wf_kind(lv.n, greatest(t.current_level, 1)) END AS kind) x
      WHERE x.kind IS NOT NULL
    ) k ON true
    WHERE ${extraWhere}
    ${tail}`;
}

@Injectable()
export class TaskViewService {
  constructor(private readonly db: DbService) {}

  async rows(sql: Prisma.Sql): Promise<TaskRow[]> {
    return this.db.tx.$queryRaw<TaskRow[]>(sql);
  }

  /** TaskSummary items for rows (holders, claimants and external parties are looked up in three batched queries). */
  async summaries(rows: TaskRow[]): Promise<TaskSummaryDto[]> {
    const cells = [...new Set(rows.map((r) => r.cell_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map((r) => r.pinned_user).filter((x): x is string => !!x))];
    const partyIds = [...new Set(rows.map((r) => r.external_party_id).filter((x): x is string => !!x))];

    const assignees = cells.length
      ? await this.db.tx.$queryRaw<AssigneeRow[]>(Prisma.sql`
          SELECT a.cell_id::text AS cell_id, a.kind::text AS kind, a.ref_id::text AS ref_id,
            coalesce(u.display_name, ro.name_en, g.name, '') AS label, u.employee_id, u.status::text AS status, (u.deleted_at IS NOT NULL) AS deleted
          FROM matrix_cell_assignees a
          LEFT JOIN users u ON a.kind = 'user' AND u.id = a.ref_id
          LEFT JOIN roles ro ON a.kind = 'role' AND ro.id = a.ref_id
          LEFT JOIN groups g ON a.kind = 'group' AND g.id = a.ref_id
          WHERE a.cell_id = ANY(${cells}::uuid[]) ORDER BY label, a.ref_id`)
      : [];
    const users = await this.usersByIds(userIds);
    const parties = partyIds.length
      ? await this.db.tx.$queryRaw<{ id: string; name: string; type: string }[]>(
          Prisma.sql`SELECT id::text AS id, name, type::text AS type FROM external_parties WHERE id = ANY(${partyIds}::uuid[])`)
      : [];

    const byCell = new Map<string, MatrixAssigneeDto[]>();
    for (const a of assignees) {
      const dto: MatrixAssigneeDto = {
        kind: a.kind as MatrixAssigneeDto['kind'],
        ref_id: a.ref_id,
        label: a.label,
        employee_id: a.kind === 'user' ? (a.employee_id?.trim() ?? null) : null,
      };
      if (a.kind === 'user') {
        dto.user_id = a.ref_id;
        dto.account_status = accountStatus(a.status, a.deleted);
      }
      const list = byCell.get(a.cell_id) ?? [];
      list.push(dto);
      byCell.set(a.cell_id, list);
    }

    return rows.map((r) => {
      const dto: TaskSummaryDto = {
        id: r.id,
        site_id: r.site_id,
        site_code: r.site_code,
        region_id: r.region_id,
        task_code: r.task_code,
        name_en: r.name_en,
        name_ar: r.name_ar,
        stage_code: r.stage_code,
        stream_code: r.stream_code,
        state: r.state === 'rejected' ? 'entry' : r.state,
        current_level: r.current_level,
        levels_required: r.n_levels,
        planned_date: r.planned_date,
        actual_date: r.actual_date,
        sla: {
          code: null,
          min_wd: r.sla_min,
          max_wd: r.sla_max,
          start_event: r.sla_start,
          start_date: null,
          elapsed_wd: null,
          due_date: r.due_date,
          colour: 'none',
          rule_id: r.sla_rule_id,
          rule_set_version: null,
        },
        slots_filled: Number(r.slots_filled),
        slots_required: Number(r.slots_required),
        template_id: null,
        return_count: r.return_count,
        last_return_note: r.last_return_note,
        admin_override: r.admin_override,
        lock_reasons: [],
        version: r.version,
      };
      if (r.kind) {
        const pinned = r.pinned_user ? users.get(r.pinned_user) : undefined;
        const party = r.external_party_id ? parties.find((p) => p.id === r.external_party_id) : undefined;
        dto.ball_in_court = {
          level: Math.max(r.current_level, 1),
          level_kind: r.kind as BallInCourtDto['level_kind'],
          holders: r.cell_id ? (byCell.get(r.cell_id) ?? []) : [],
          rule: (r.rule as BallInCourtDto['rule']) ?? 'any_one',
          no_eligible_holder: r.has_holder === false,
        };
        if (pinned) {
          dto.ball_in_court.claimed_by = { id: pinned.id, display_name: pinned.display_name, employee_id: pinned.employee_id?.trim() ?? null };
          dto.holder_account_status = accountStatus(pinned.status, pinned.deleted_at !== null);
        }
        if (r.rule === 'all_members') {
          dto.ball_in_court.votes_needed = Number(r.votes_needed ?? 0);
          dto.ball_in_court.votes_done = Number(r.votes_done ?? 0);
        }
        if (party) dto.ball_in_court.external_party = party;
      }
      return dto;
    });
  }

  /** The predecessors that keep a locked task locked, as lock reasons. */
  async lockReasons(taskIds: string[]): Promise<Map<string, TaskSummaryDto['lock_reasons']>> {
    const out = new Map<string, TaskSummaryDto['lock_reasons']>();
    if (taskIds.length === 0) return out;
    const rows = await this.db.tx.$queryRaw<{ task_id: string; code: string; name_en: string }[]>(Prisma.sql`
      SELECT t.id::text AS task_id, pd.code, pd.name_en
      FROM task_instances t
      JOIN task_predecessors tp ON tp.task_def_id = t.task_def_id
      JOIN task_definitions pd ON pd.id = tp.predecessor_id
      JOIN task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
      WHERE t.id = ANY(${taskIds}::uuid[]) AND t.state = 'locked' AND pi.state NOT IN ('approved', 'na', 'skipped')
      ORDER BY pd.code`);
    for (const r of rows) {
      const list = out.get(r.task_id) ?? [];
      list.push({ kind: 'predecessor_not_approved', ref_code: r.code, message: `${r.code} ${r.name_en} is not approved yet.`, count: null });
      out.set(r.task_id, list);
    }
    return out;
  }

  async withLockReasons(rows: TaskRow[]): Promise<TaskSummaryDto[]> {
    const dtos = await this.summaries(rows);
    const locked = dtos.filter((d) => d.state === 'locked').map((d) => d.id);
    const reasons = await this.lockReasons(locked);
    for (const d of dtos) d.lock_reasons = reasons.get(d.id) ?? [];
    return dtos;
  }

  async usersByIds(ids: string[]): Promise<Map<string, UserLite>> {
    const map = new Map<string, UserLite>();
    if (ids.length === 0) return map;
    const rows = await this.db.tx.$queryRaw<UserLite[]>(Prisma.sql`
      SELECT id::text AS id, display_name, employee_id, status::text AS status, deleted_at FROM users WHERE id = ANY(${ids}::uuid[])`);
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  async userRefs(ids: string[]): Promise<Map<string, UserRefDto>> {
    const m = await this.usersByIds(ids);
    const out = new Map<string, UserRefDto>();
    for (const [id, u] of m) out.set(id, { id, display_name: u.display_name, employee_id: u.employee_id?.trim() ?? null });
    return out;
  }

  isActiveState(state: string): boolean {
    return ACTIVE_STATES.includes(state);
  }
}

export function accountStatus(status: string | null, deleted: boolean | null): 'active' | 'deactivated' | 'deleted' {
  if (deleted) return 'deleted';
  return status === 'suspended' || status === 'disabled' ? 'deactivated' : 'active';
}

export type { AuthContext };
