import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const reason = z.string().trim().min(3).max(2000);
const oneBody = z.object({ locked: z.boolean(), reason }).strict();
const bulkBody = z.object({
  locked: z.boolean(),
  reason,
  site_ids: z.array(uuidSchema).min(1).max(5000).optional(),
  master_run_id: uuidSchema.optional(),
  import_batch_id: uuidSchema.optional(),
}).strict().refine((b) => [b.site_ids, b.master_run_id, b.import_batch_id].filter((x) => x !== undefined).length === 1, {
  message: 'send exactly one of site_ids, master_run_id or import_batch_id', path: ['site_ids'],
});

export interface SiteStatusRow {
  site_id: string;
  site_code: string;
  name: string;
  region_id: number;
  overall_status: string;
  workflow_locks: boolean;
  current_stream: string | null;
  current_milestone: string | null;
  next_milestone: string | null;
  done_tasks: number;
  total_tasks: number;
  warnings: number;
  errors: number;
  data_gaps: number;
}

/**
 * Migration 0085 (owner request 2026-11-10): the per-site workflow locks and the status of the sites of an import (missing data per site).
 * The switch is site_workflow_locks_set (a System Admin, or the delegable right "unlock" for the region; a reason and a step-up; audited per site).
 */
@Injectable()
export class SiteLocksService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async call(auth: AuthContext, sql: Prisma.Sql): Promise<Record<string, unknown>> {
    await this.db.tx.$executeRaw`SAVEPOINT site_locks`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Record<string, unknown> }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT site_locks`;
      return rows[0]?.r ?? {};
    } catch (e) {
      const p = e instanceof ProblemException ? e : mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT site_locks`;
      if (p.code === 'step_up_required') {
        throw new ProblemException(401, 'step_up_required', { detail: 'Confirm your password to continue.', step_up_method: auth.session.authMethod === 'local' ? 'password' : 'm365' });
      }
      throw p;
    }
  }

  private set(auth: AuthContext, ids: string[], locked: boolean, why: string): Promise<Record<string, unknown>> {
    return this.call(auth, Prisma.sql`SELECT site_workflow_locks_set(${ids}::uuid[], ${locked}::boolean, ${why}::text) AS r`);
  }

  /** PUT /sites/{id}/workflow-locks */
  async setOne(auth: AuthContext, id: string, raw: unknown): Promise<Record<string, unknown>> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The site does not exist or is not visible to you.');
    const b = parse(oneBody, raw);
    return this.set(auth, [id], b.locked, b.reason);
  }

  /** POST /sites/workflow-locks: a selection, or every site of a Master import run or of an import batch, with one reason. */
  async setMany(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    const b = parse(bulkBody, raw);
    let ids = b.site_ids ?? [];
    if (b.master_run_id) {
      const ok = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT coalesce(mi_can_use(), false) AS ok`;
      if (!ok[0]?.ok) throw problems.forbidden('action_forbidden', 'The sites of a Master import run are chosen by a System Admin or a delegate of templates administer.');
      ids = (await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT DISTINCT r.site_id::text AS id FROM master_reconciliation_rows r WHERE r.run_id = ${b.master_run_id}::uuid AND r.site_id IS NOT NULL`)).map((r) => r.id);
    } else if (b.import_batch_id) {
      const vis = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT coalesce(imp_batch_visible(${b.import_batch_id}::uuid), false) AS ok`);
      if (!vis[0]?.ok) throw problems.notFound('The batch does not exist or is not visible to you.');
      ids = (await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT DISTINCT r.site_id::text AS id FROM import_batch_rows r WHERE r.batch_id = ${b.import_batch_id}::uuid AND r.site_id IS NOT NULL`)).map((r) => r.id);
    }
    if (ids.length === 0) throw problems.validation([{ path: '/site_ids', code: 'required', message: 'No site to change.' }]);
    return this.set(auth, ids, b.locked, b.reason);
  }

  /** The status of the sites of a source (a Master import run or an import batch), with the warnings of its batches and the data gaps of each site. */
  async statusPage(src: { kind: 'run'; id: string; groupId: string | null } | { kind: 'batch'; id: string; groupId: string | null }, q: Record<string, unknown>) {
    const regions = await this.access.requireRegions('sites', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 1);
    const offset = cursor ? Number(cursor[0]) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw problems.badRequest('The cursor is not valid.');
    const gaps = oneParam(q, 'gaps');
    if (gaps !== undefined && gaps !== 'only') throw problems.validation([{ path: '/gaps', code: 'invalid', message: 'gaps is only.' }]);
    const sites = src.kind === 'run'
      ? Prisma.sql`SELECT DISTINCT r.site_id FROM master_reconciliation_rows r WHERE r.run_id = ${src.id}::uuid AND r.site_id IS NOT NULL`
      : Prisma.sql`SELECT DISTINCT r.site_id FROM import_batch_rows r WHERE r.batch_id = ${src.id}::uuid AND r.site_id IS NOT NULL`;
    const batches = src.groupId
      ? Prisma.sql`SELECT b.id FROM import_batches b WHERE b.group_id = ${src.groupId}::uuid`
      : src.kind === 'batch' ? Prisma.sql`SELECT ${src.id}::uuid` : Prisma.sql`SELECT NULL::uuid WHERE false`;
    const rows = await this.db.tx.$queryRaw<(Omit<SiteStatusRow, 'done_tasks' | 'total_tasks' | 'warnings' | 'errors' | 'data_gaps'> & { done_tasks: bigint; total_tasks: bigint; warnings: bigint; errors: bigint; data_gaps: number; total: bigint })[]>(Prisma.sql`
      WITH src AS (${sites}),
      w AS (
        SELECT br.site_id, sum(CASE WHEN jsonb_typeof(br.warnings) = 'array' THEN jsonb_array_length(br.warnings) ELSE 0 END) AS warnings,
          count(*) FILTER (WHERE br.action = 'error') AS errors
        FROM import_batch_rows br WHERE br.batch_id IN (${batches}) AND br.site_id IS NOT NULL GROUP BY br.site_id
      ), base AS (
        SELECT s.id::text AS site_id, s.site_code, s.name, s.region_id, s.overall_status::text AS overall_status, s.workflow_locks,
          (SELECT st.stream_code FROM stage_definitions st WHERE st.workflow_id = s.workflow_version_id AND st.code = coalesce(s.next_milestone, s.current_milestone) LIMIT 1) AS current_stream,
          s.current_milestone, s.next_milestone,
          (SELECT count(*) FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
            WHERE ti.site_id = s.id AND td.counts_toward_milestone AND ti.state = 'approved') AS done_tasks,
          (SELECT count(*) FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
            WHERE ti.site_id = s.id AND td.counts_toward_milestone AND NOT ti.is_na AND ti.state NOT IN ('na', 'skipped')) AS total_tasks,
          coalesce(w.warnings, 0) AS warnings, coalesce(w.errors, 0) AS errors, site_data_gap_count(s.id) AS data_gaps
        FROM src JOIN sites s ON s.id = src.site_id LEFT JOIN w ON w.site_id = s.id
        ${regions === null ? Prisma.empty : Prisma.sql`WHERE s.region_id = ANY(${regions}::int[])`}
      )
      SELECT base.*, count(*) OVER () AS total FROM base
      ${gaps === 'only' ? Prisma.sql`WHERE base.data_gaps > 0 OR base.warnings > 0` : Prisma.empty}
      ORDER BY base.site_code LIMIT ${limit + 1} OFFSET ${offset}`);
    const page = rows.slice(0, limit).map((row) => { const { total, ...r } = row; void total; return {
      ...r, done_tasks: Number(r.done_tasks), total_tasks: Number(r.total_tasks), warnings: Number(r.warnings), errors: Number(r.errors), data_gaps: Number(r.data_gaps),
    }; });
    return { items: page, page: { limit, next_cursor: rows.length > limit ? encodeCursor([String(offset + limit)]) : null, total: rows[0] ? Number(rows[0].total) : 0 } };
  }
}
