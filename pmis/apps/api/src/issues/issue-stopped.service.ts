import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { DbService } from '../db/db.service';
import { parse } from '../common/zod';

const reason = z.string().trim().min(3).max(500);
const taskCodeSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/, 'Not a task code.');
const mapSchema = z.object({ category: z.string().trim().min(1).max(80), reason: z.string().trim().max(80).nullable().optional(), is_active: z.boolean().default(true), why: reason }).strict();

/**
 * 0171 (contract 0.15.87): the "stopped at" issue rows are COMPUTED, never stored. A site is stopped when it is not finished (not completed or cancelled,
 * On-Air milestone not approved) and has at least one open task that is late (the SLA colour red, the same rule as the My Work "late" bucket) or blocked
 * (rejected or suspended). The row shows the LATEST such task in workflow order (stage sequence, then task order), owner decision 20:18.
 * Category and reason come from the editable map issue_task_map (Settings), never from a hidden rule. A row closes by itself when the cause is gone.
 */
@Injectable()
export class IssueStoppedService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  /** GET /issues/stopped-rows (read only, the caller's Issues regions). */
  async rows(auth: AuthContext): Promise<unknown> {
    void auth;
    const regions = await this.access.requireRegions('issues', 'view');
    const scope = regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`;
    const items = await this.db.tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH open_t AS (
        SELECT t.site_id, t.id AS task_id, td.code AS task_code, td.name_en, td.name_ar, st.code AS stage_code, st.name_en AS stage_name, st.seq, td.sort_order,
               t.state::text AS state, sl.colour, sl.elapsed,
               CASE WHEN t.state IN ('rejected', 'suspended') THEN t.state::text ELSE 'late' END AS why
        FROM task_instances t
        JOIN sites s ON s.id = t.site_id
        JOIN task_definitions td ON td.id = t.task_def_id
        JOIN stage_definitions st ON st.id = td.stage_id
        LEFT JOIN sla_rules r ON r.id = t.sla_rule_id
        LEFT JOIN LATERAL (
          SELECT x.elapsed, sla_colour(x.elapsed, r.min_working_days, r.max_working_days) AS colour
          FROM (SELECT CASE WHEN t.sla_start_date IS NULL OR r.id IS NULL THEN NULL
                            ELSE cal_workdays_between(t.sla_start_date, cal_today(), r.calendar_id) END AS elapsed) x
        ) sl ON true
        WHERE t.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended')
          AND NOT td.is_milestone_task
          AND s.overall_status NOT IN ('completed', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM task_instances m JOIN task_definitions md ON md.id = m.task_def_id
                          WHERE m.site_id = t.site_id AND md.code = 'MS6' AND m.state = 'approved')
          AND (t.state IN ('rejected', 'suspended') OR sl.colour = 'red')
          ${scope}
      ), latest AS (
        SELECT DISTINCT ON (site_id) * FROM open_t ORDER BY site_id, seq DESC, sort_order DESC, task_code DESC
      )
      SELECT s.site_code, l.task_id, l.task_code, l.name_en AS task_name_en, l.name_ar AS task_name_ar, l.stage_code, l.stage_name, l.state, l.why,
             l.elapsed AS working_days_elapsed,
             coalesce(m.category, 'Other') AS category, m.reason AS blocker_reason, (m.task_code IS NULL OR NOT m.is_active) AS not_classified,
             (SELECT count(*)::int FROM open_t o WHERE o.site_id = l.site_id) AS open_blocking_tasks
      FROM latest l
      JOIN sites s ON s.id = l.site_id
      LEFT JOIN issue_task_map m ON m.task_code = l.task_code AND m.is_active
      ORDER BY s.site_code`);
    return { items, counts: { total: items.length, not_classified: items.filter((i) => i.not_classified === true).length } };
  }

  /** GET /settings/issue-task-map: every task of the version in force with its category and reason (a missing row shows as Not classified). */
  async map(auth: AuthContext): Promise<unknown> {
    await this.access.requireModuleView(auth, 'admin.settings');
    const items = await this.db.tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT td.code AS task_code, td.name_en, td.name_ar, st.code AS stage_code, st.seq AS stage_seq,
             m.category, m.reason AS blocker_reason, coalesce(m.is_active, false) AS is_active, (m.task_code IS NULL) AS not_classified
      FROM task_definitions td
      JOIN stage_definitions st ON st.id = td.stage_id
      LEFT JOIN issue_task_map m ON m.task_code = td.code
      WHERE td.workflow_id = sla_workflow() AND td.is_active AND NOT td.is_milestone_task
      ORDER BY st.seq, td.sort_order, td.code`);
    return { items, counts: { total: items.length, not_classified: items.filter((i) => i.not_classified === true).length } };
  }

  /** PUT /settings/issue-task-map/{task_code}: the audited door (Settings edit right, a reason). Nothing is deleted: a row is hidden with is_active=false. */
  async save(auth: AuthContext, taskCode: string, raw: unknown): Promise<unknown> {
    void auth;
    await this.access.requireAdmin('settings', 'edit');
    const code = parse(taskCodeSchema, taskCode);
    const b = parse(mapSchema, raw);
    const r = await this.db.tx.$queryRaw<{ r: unknown }[]>(Prisma.sql`
      SELECT admin_issue_task_map_save(${code}::text, ${b.category}::text, ${b.reason ?? null}::text, ${b.is_active}::boolean, ${b.why}::text) AS r`);
    return r[0]!.r;
  }
}
