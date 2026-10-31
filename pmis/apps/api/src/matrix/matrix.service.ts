import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { accountStatus } from '../workflow/task-view.service';

const reason = z.string().trim().min(3).max(1000);
const code = z.string().trim().min(1).max(60);

const patchSchema = z.object({
  workflow_version: z.number().int().min(1).optional(),
  stage_levels: z.array(z.object({ stage_code: code, approval_levels: z.number().int().min(1).max(3) }).strict()).max(100).optional(),
  cells: z.array(z.object({
    stage_code: code,
    task_code: code.nullish(),
    level: z.number().int().min(1).max(3),
    region_id: z.number().int().min(1).max(99).nullish(),
    rule: z.enum(['any_one', 'all_members']),
    assignees: z.array(z.object({ kind: z.enum(['user', 'role', 'group']), ref_id: z.string().uuid() }).strict()).max(100),
  }).strict()).max(300).optional(),
  reason,
}).strict().refine((b) => (b.stage_levels?.length ?? 0) + (b.cells?.length ?? 0) > 0, { message: 'Change at least one cell or level count.', path: [] });

export type MatrixPatchBody = z.infer<typeof patchSchema>;

interface UserRefDto { id: string; display_name: string; employee_id: string | null }
interface AssigneeDto {
  kind: 'user' | 'role' | 'group'; ref_id: string; label: string; employee_id: string | null;
  user_id?: string; account_status?: 'active' | 'deactivated' | 'deleted'; member_count?: number;
}
interface CellDto {
  id: string; stage_code: string; task_code: string | null; level: number; level_kind: 'entry' | 'review' | 'approve'; used: boolean; region_id: number | null;
  rule: 'any_one' | 'all_members'; assignees: AssigneeDto[]; skip_preview: UserRef[]; updated_at: Date | null;
}
type UserRef = UserRefDto;
interface SkipCaseDto {
  task_code: string | null; user: UserRefDto; from_level_kind: 'entry' | 'review'; skipped_level_kinds: ('review' | 'approve')[]; self_approval: boolean; region_ids: number[];
}
export interface MatrixRowDto {
  kind: 'stage' | 'register' | 'dismantle'; register_key: string | null; code: string; name_en: string; name_ar: string | null; approval_levels: number;
  used_levels: number[]; region_ids_with_cells: number[]; task_counts?: { not_submitted: number; in_flight: number };
  preview: { single_level: boolean; skips: SkipCaseDto[] }; cells: CellDto[];
}
export interface MatrixDto { workflow_version: number; version: number; stages: MatrixRowDto[] }

interface BaseRow { key: string; stage_id: string | null; code: string; kind: 'stage' | 'register' | 'dismantle'; name_en: string; name_ar: string | null; approval_levels: number }
interface CellRow {
  id: string; stage_id: string | null; register_key: string | null; task_code: string | null; level: number; rule: 'any_one' | 'all_members'; region_id: number | null; updated_at: Date | null;
}
interface AssigneeRow {
  cell_id: string; kind: 'user' | 'role' | 'group'; ref_id: string; label: string; employee_id: string | null; status: string | null; deleted: boolean | null; member_count: bigint | null;
}
interface PreviewRow { o_row: string; o_task: string | null; o_region: number; o_user: string; o_from: 'entry' | 'review'; o_skipped: ('review' | 'approve')[]; o_final: boolean }

const LEVEL_KIND = ['entry', 'review', 'approve'] as const;
/** Entry is cell level 1, approve is cell level 3, review is cell level 2 (the engine reads them so whatever the number of levels). */
export const usedLevels = (n: number): number[] => (n <= 1 ? [1] : n === 2 ? [1, 3] : [1, 2, 3]);

/** Responsibility Matrix (contract tag `matrix`, P1-BE-12): reads follow the caller's regions; the only writer is the SECURITY DEFINER function matrix_save. */
@Injectable()
export class MatrixService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  /** View on the matrix screen, or the right to edit it (a delegate of matrix.edit needs no profile). */
  private async requireRead(auth: AuthContext): Promise<void> {
    if (await this.access.hasGrant(auth, 'admin.matrix', 'view')) return;
    if (await this.access.isAdmin('matrix', 'edit')) return;
    throw new ProblemException(403, 'module_forbidden', { detail: 'You cannot use the Responsibility Matrix.' });
  }

  private async workflowOf(requested: number | undefined): Promise<{ id: string; version: number } | undefined> {
    const rows = requested
      ? await this.db.tx.$queryRaw<{ id: string; version: number }[]>(Prisma.sql`SELECT id::text AS id, version FROM workflow_definitions WHERE version = ${requested}::int`)
      : await this.db.tx.$queryRaw<{ id: string; version: number }[]>(Prisma.sql`SELECT id::text AS id, version FROM workflow_definitions WHERE id = active_workflow_id()`);
    return rows[0];
  }

  /** GET /matrix */
  async get(auth: AuthContext, q: Query): Promise<MatrixDto> {
    await this.requireRead(auth);
    const wv = oneParam(q, 'workflow_version');
    const rg = oneParam(q, 'region_id');
    if (wv !== undefined && !/^[1-9][0-9]{0,8}$/.test(wv)) throw problems.validation([{ path: '/workflow_version', code: 'invalid', message: 'workflow_version is a positive integer.' }]);
    let region: number | undefined;
    if (rg !== undefined) {
      region = /^[0-9]{1,3}$/.test(rg) ? Number(rg) : NaN;
      const ok = Number.isInteger(region) && (await this.db.tx.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM regions WHERE id = ${region}::int`)).length > 0;
      if (!ok) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'Unknown region.' }]);
    }
    const wf = await this.workflowOf(wv ? Number(wv) : undefined);
    if (!wf) throw problems.notFound('The workflow version does not exist.');
    return this.read(wf, region);
  }

  private async read(wf: { id: string; version: number }, region: number | undefined): Promise<MatrixDto> {
    const tx = this.db.tx;
    const stages = await tx.$queryRaw<BaseRow[]>(Prisma.sql`
      SELECT 'S:' || s.id::text AS key, s.id::text AS stage_id, s.code, 'stage' AS kind, s.name_en, s.name_ar, s.approval_levels
      FROM stage_definitions s WHERE s.workflow_id = ${wf.id}::uuid AND s.is_active ORDER BY s.seq`);
    const registers = await tx.$queryRaw<BaseRow[]>(Prisma.sql`
      SELECT 'R:' || m.register_key AS key, NULL::text AS stage_id, m.register_key AS code, m.kind, m.name_en, m.name_ar, m.approval_levels
      FROM register_definitions m WHERE m.is_active ORDER BY (m.kind = 'dismantle'), m.sort_order, m.register_key COLLATE "C"`);
    const bases = [...stages, ...registers];

    const cells = await tx.$queryRaw<CellRow[]>(Prisma.sql`
      SELECT c.id::text AS id, c.stage_id::text AS stage_id, c.register_key, td.code AS task_code, c.level, c.rule::text AS rule, c.region_id, c.updated_at
      FROM matrix_cells c
      LEFT JOIN task_definitions td ON td.id = c.task_def_id
      WHERE (c.stage_id IN (SELECT id FROM stage_definitions WHERE workflow_id = ${wf.id}::uuid) OR c.register_key IS NOT NULL)
        AND (c.region_id IS NULL ${region !== undefined ? Prisma.sql`OR c.region_id = ${region}::int` : Prisma.empty})
      ORDER BY c.level, (td.code IS NOT NULL), (c.region_id IS NOT NULL), td.code COLLATE "C", c.region_id, c.id`);
    const regional = await tx.$queryRaw<{ key: string; regions: number[] }[]>(Prisma.sql`
      SELECT CASE WHEN c.register_key IS NOT NULL THEN 'R:' || c.register_key ELSE 'S:' || c.stage_id::text END AS key, array_agg(DISTINCT c.region_id ORDER BY c.region_id) AS regions
      FROM matrix_cells c WHERE c.region_id IS NOT NULL GROUP BY 1`);
    const ids = cells.map((c) => c.id);
    const assignees = ids.length
      ? await tx.$queryRaw<AssigneeRow[]>(Prisma.sql`
          SELECT a.cell_id::text AS cell_id, a.kind::text AS kind, a.ref_id::text AS ref_id, coalesce(u.display_name, ro.name_en, g.name, '') AS label,
                 u.employee_id, u.status::text AS status, (u.deleted_at IS NOT NULL) AS deleted,
                 CASE a.kind
                   WHEN 'role' THEN (SELECT count(DISTINCT ua.user_id) FROM user_role_assignments ua WHERE ua.role_id = a.ref_id AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now()))
                   WHEN 'group' THEN (SELECT count(*) FROM group_members gm WHERE gm.group_id = a.ref_id)
                 END AS member_count
          FROM matrix_cell_assignees a
          LEFT JOIN users u ON a.kind = 'user' AND u.id = a.ref_id
          LEFT JOIN roles ro ON a.kind = 'role' AND ro.id = a.ref_id
          LEFT JOIN groups g ON a.kind = 'group' AND g.id = a.ref_id
          WHERE a.cell_id = ANY(${ids}::uuid[]) ORDER BY coalesce(u.display_name, ro.name_en, g.name, '') COLLATE "C", a.ref_id`)
      : [];
    const preview = await tx.$queryRaw<PreviewRow[]>(Prisma.sql`
      SELECT o_row, o_task, o_region, o_user::text AS o_user, o_from, o_skipped, o_final FROM matrix_preview(${wf.version}::int) ORDER BY o_row COLLATE "C", o_task COLLATE "C" NULLS FIRST, o_region, o_user`);
    const userIds = [...new Set(preview.map((p) => p.o_user))];
    const users = userIds.length
      ? await tx.$queryRaw<{ id: string; display_name: string; employee_id: string | null }[]>(Prisma.sql`
          SELECT id::text AS id, display_name, employee_id FROM users WHERE id = ANY(${userIds}::uuid[])`)
      : [];
    const userRef = new Map<string, UserRefDto>(users.map((u) => [u.id, { id: u.id, display_name: u.display_name, employee_id: u.employee_id?.trim() ?? null }]));
    const counts = await tx.$queryRaw<{ stage_id: string; not_submitted: bigint; in_flight: bigint }[]>(Prisma.sql`
      SELECT td.stage_id::text AS stage_id,
             count(*) FILTER (WHERE ti.path_frozen_at IS NULL AND td.approval_levels IS NULL) AS not_submitted,
             count(*) FILTER (WHERE ti.path_frozen_at IS NOT NULL) AS in_flight
      FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
      WHERE td.workflow_id = ${wf.id}::uuid AND ti.state NOT IN ('approved', 'na', 'skipped')
      GROUP BY td.stage_id`);

    const byCell = new Map<string, AssigneeDto[]>();
    for (const a of assignees) {
      const dto: AssigneeDto = { kind: a.kind, ref_id: a.ref_id, label: a.label, employee_id: a.kind === 'user' ? (a.employee_id?.trim() ?? null) : null };
      if (a.kind === 'user') {
        dto.user_id = a.ref_id;
        dto.account_status = accountStatus(a.status, a.deleted);
      } else {
        dto.member_count = Number(a.member_count ?? 0);
      }
      const list = byCell.get(a.cell_id) ?? [];
      list.push(dto);
      byCell.set(a.cell_id, list);
    }

    const rows: MatrixRowDto[] = bases.map((b) => {
      const mine = cells.filter((c) => (b.stage_id ? c.stage_id === b.stage_id : c.register_key === b.code));
      const pv = preview.filter((p) => p.o_row === b.code); // stage codes are upper case, register keys lower case: a code names one row
      const skips = new Map<string, SkipCaseDto>();
      for (const p of pv) {
        const u = userRef.get(p.o_user);
        if (!u) continue;
        const key = [p.o_task ?? '', p.o_user, p.o_from, p.o_skipped.join('>'), p.o_final].join('|');
        const e = skips.get(key) ?? { task_code: p.o_task, user: u, from_level_kind: p.o_from, skipped_level_kinds: p.o_skipped, self_approval: p.o_final, region_ids: [] };
        e.region_ids.push(p.o_region);
        skips.set(key, e);
      }
      const skipCases = [...skips.values()];
      const defaults = mine.filter((c) => c.task_code === null && c.region_id === null);
      const others = mine.filter((c) => !(c.task_code === null && c.region_id === null));
      const used = usedLevels(b.approval_levels);
      const toCell = (c: CellRow): CellDto => {
        const kind = LEVEL_KIND[c.level - 1] ?? 'approve';
        const sp = new Map<string, UserRefDto>();
        for (const s of skipCases) {
          if (s.task_code === c.task_code && s.from_level_kind === kind && (c.region_id === null || s.region_ids.includes(c.region_id))) sp.set(s.user.id, s.user);
        }
        return {
          id: c.id, stage_code: b.code, task_code: c.task_code, level: c.level, level_kind: kind, used: used.includes(c.level), region_id: c.region_id, rule: c.rule,
          assignees: byCell.get(c.id) ?? [], skip_preview: [...sp.values()], updated_at: c.updated_at,
        };
      };
      const row: MatrixRowDto = {
        kind: b.kind, register_key: b.kind === 'stage' ? null : b.code, code: b.code, name_en: b.name_en, name_ar: b.name_ar, approval_levels: b.approval_levels,
        used_levels: used, region_ids_with_cells: regional.find((r) => r.key === b.key)?.regions ?? [],
        preview: { single_level: b.approval_levels === 1, skips: skipCases },
        cells: [...defaults, ...others].map(toCell),
      };
      if (b.stage_id) {
        const n = counts.find((c) => c.stage_id === b.stage_id);
        row.task_counts = { not_submitted: Number(n?.not_submitted ?? 0), in_flight: Number(n?.in_flight ?? 0) };
      }
      return row;
    });

    const rev = await tx.$queryRaw<{ revision: number }[]>(Prisma.sql`SELECT revision FROM matrix_state WHERE id`);
    return { workflow_version: wf.version, version: rev[0]?.revision ?? 1, stages: rows };
  }

  /** PATCH /matrix (step-up, If-Match, reason) */
  async patch(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<MatrixDto> {
    await this.access.requireAdmin('matrix', 'edit');
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    const b = parse(patchSchema, raw);

    const dupLevels = new Set<string>();
    const errors: { path: string; code: string; message: string }[] = [];
    (b.stage_levels ?? []).forEach((l, i) => {
      if (dupLevels.has(l.stage_code)) errors.push({ path: `/stage_levels/${i}/stage_code`, code: 'duplicate', message: 'This row appears twice.' });
      dupLevels.add(l.stage_code);
    });
    const dupCells = new Set<string>();
    (b.cells ?? []).forEach((c, i) => {
      const k = [c.stage_code, c.task_code ?? '', c.level, c.region_id ?? ''].join('|');
      if (dupCells.has(k)) errors.push({ path: `/cells/${i}`, code: 'duplicate', message: 'This cell appears twice.' });
      dupCells.add(k);
    });
    if (errors.length > 0) throw problems.validation(errors);

    const wf = await this.workflowOf(b.workflow_version);
    if (!wf) {
      if (b.workflow_version) throw problems.validation([{ path: '/workflow_version', code: 'unknown_version', message: 'No such workflow version.' }]);
      throw problems.notFound('There is no published workflow version.');
    }
    const levels = (b.stage_levels ?? []).map((l) => ({ code: l.stage_code, approval_levels: l.approval_levels }));
    const cells = (b.cells ?? []).map((c) => ({
      code: c.stage_code, task_code: c.task_code ?? null, level: c.level, region_id: c.region_id ?? null, rule: c.rule, assignees: c.assignees,
    }));
    await this.db.tx.$queryRaw(Prisma.sql`
      SELECT matrix_save(${wf.version}::int, ${version}::int, ${JSON.stringify(levels)}::jsonb, ${JSON.stringify(cells)}::jsonb, ${b.reason}::text)`);
    return this.read(wf, undefined);
  }
}
