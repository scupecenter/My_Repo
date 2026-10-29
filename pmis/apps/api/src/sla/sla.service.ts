import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { parseIfMatch } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { problems, ProblemException } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const reason = z.string().trim().min(3).max(1000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a date.');
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;
const days = z.number().int().min(0).max(365);

const overrideSchema = z.object({
  scenario: z.enum(SCENARIOS).optional(),
  region_id: z.number().int().min(1).max(7).optional(),
  min_working_days: days,
  max_working_days: days,
}).strict().refine((o) => o.scenario !== undefined || o.region_id !== undefined, { message: 'Name a scenario, a region, or both.', path: [] });

const ruleSchema = z.object({
  task_code: z.string().min(1).max(40),
  min_working_days: days,
  max_working_days: days,
  start_event: z.string().min(1).max(60),
  calendar_code: z.string().min(1).max(60),
  overrides: z.array(overrideSchema).max(47).optional(),
}).strict();

const draftSchema = z.object({ reason }).strict();
const patchSchema = z.object({ reason, rules: z.array(ruleSchema).min(1).max(500) }).strict();
const previewSchema = z.object({ effective_date: isoDate }).strict();
const publishSchema = z.object({ effective_date: isoDate, reason, apply_to_open_tasks: z.boolean().default(false) }).strict();

type UserRef = { id: string; display_name: string; employee_id: string | null };

interface SetRow {
  id: string;
  version: number;
  status: 'draft' | 'published';
  effective_from: string | null;
  effective_to: string | null;
  base_version: number | null;
  reason: string;
  created_by: string | null;
  cb_name: string | null;
  cb_emp: string | null;
  created_at: Date;
  published_by: string | null;
  pb_name: string | null;
  pb_emp: string | null;
  published_at: Date | null;
  apply_to_open_tasks: boolean | null;
  affected_open_tasks: number | null;
  row_version: number;
  rule_count: bigint;
  is_active: boolean;
}

interface RuleRow {
  id: string;
  task_code: string;
  min_working_days: number;
  max_working_days: number;
  start_event: string;
  scenario: string | null;
  region_id: number | null;
  calendar_code: string;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  changed_by: string;
  cb_name: string | null;
  cb_emp: string | null;
  changed_at: Date;
  open_task_count: bigint;
  set_version: number | null;
}

const ref = (id: string | null, name: string | null, emp: string | null): UserRef | undefined =>
  id === null ? undefined : { id, display_name: id === NIL_USER ? 'System (seed)' : (name ?? ''), employee_id: emp?.trim() ?? null };

const SET_SELECT = Prisma.sql`
  SELECT s.id::text AS id, s.version, s.status, s.effective_from::text AS effective_from, s.effective_to::text AS effective_to, s.base_version, s.reason,
    s.created_by::text AS created_by, cu.display_name AS cb_name, cu.employee_id AS cb_emp, s.created_at,
    s.published_by::text AS published_by, pu.display_name AS pb_name, pu.employee_id AS pb_emp, s.published_at,
    s.apply_to_open_tasks, s.affected_open_tasks, s.row_version,
    (SELECT count(*) FROM sla_rule_set_items i WHERE i.set_id = s.id) AS rule_count,
    (s.id = sla_set_in_force()) AS is_active
  FROM sla_rule_sets s LEFT JOIN users cu ON cu.id = s.created_by LEFT JOIN users pu ON pu.id = s.published_by`;

/** SLA rules and the versions of the whole rule set (contract 0.2.6). Writes go through audited admin_* functions. */
@Injectable()
export class SlaService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly idem: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------ GET /settings/sla-rules
  async rules(auth: AuthContext, q: Query): Promise<unknown> {
    // Same gate as the rule-set endpoints: the rows name who changed them and count open tasks in every region.
    await this.access.requireModuleView(auth, 'admin.settings');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const taskCode = oneParam(q, 'task_code');
    const activeOn = oneParam(q, 'active_on');
    if (activeOn !== undefined) parse(isoDate, activeOn);
    const hist = oneParam(q, 'include_history');
    if (hist !== undefined && hist !== 'true' && hist !== 'false') throw problems.validation([{ path: '/include_history', code: 'invalid', message: 'include_history is true or false.' }]);
    const when = activeOn ? Prisma.sql`${activeOn}::date` : Prisma.sql`cal_today()`;
    const rows = await this.db.tx.$queryRaw<RuleRow[]>(Prisma.sql`
      SELECT r.id::text AS id, td.code AS task_code, r.min_working_days, r.max_working_days, coalesce(r.start_ref, r.start_event) AS start_event,
        r.scenario::text AS scenario, r.region_id, c.code AS calendar_code, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
        r.reason, r.changed_by::text AS changed_by, u.display_name AS cb_name, u.employee_id AS cb_emp, r.changed_at,
        (SELECT count(*) FROM task_instances t WHERE t.sla_rule_id = r.id AND t.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended')) AS open_task_count,
        rs.version AS set_version
      FROM sla_rules r JOIN task_definitions td ON td.id = r.task_def_id JOIN work_calendars c ON c.id = r.calendar_id
      LEFT JOIN users u ON u.id = r.changed_by LEFT JOIN sla_rule_sets rs ON rs.id = r.rule_set_id
      WHERE td.workflow_id = sla_workflow()
        ${taskCode ? Prisma.sql`AND td.code = ${taskCode}` : Prisma.empty}
        ${hist === 'true' && !activeOn ? Prisma.empty : Prisma.sql`AND r.effective_from <= ${when} AND (r.effective_to IS NULL OR r.effective_to > ${when})`}
        ${cursor ? Prisma.sql`AND (td.code, r.id::text) > (${cursor[0] as string}, ${cursor[1] as string})` : Prisma.empty}
      ORDER BY td.code, r.id::text LIMIT ${limit + 1}`);
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map((r) => ({
        id: r.id, task_code: r.task_code, min_working_days: r.min_working_days, max_working_days: r.max_working_days, start_event: r.start_event,
        scenario: r.scenario, region_id: r.region_id, calendar_code: r.calendar_code, effective_from: r.effective_from, effective_to: r.effective_to,
        reason: r.reason, changed_by: ref(r.changed_by, r.cb_name, r.cb_emp), changed_at: r.changed_at, open_task_count: Number(r.open_task_count),
        ...(r.set_version !== null ? { set_version: r.set_version } : {}),
      })),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.task_code, last.id]) : null },
    };
  }

  // ------------------------------------------------------------------ rule sets
  private summary(r: SetRow): Record<string, unknown> {
    return {
      id: r.id, version: r.version, status: r.status, is_active: r.is_active, effective_from: r.effective_from, effective_to: r.effective_to, base_version: r.base_version,
      reason: r.reason, created_by: ref(r.created_by, r.cb_name, r.cb_emp) ?? { id: NIL_USER, display_name: 'System (seed)', employee_id: null }, created_at: r.created_at,
      published_by: ref(r.published_by, r.pb_name, r.pb_emp) ?? null, published_at: r.published_at,
      apply_to_open_tasks: r.status === 'draft' ? null : r.apply_to_open_tasks, affected_open_tasks: r.status === 'draft' ? null : r.affected_open_tasks,
      rule_count: Number(r.rule_count),
    };
  }

  private async setRow(rawId: string): Promise<SetRow> {
    const id = parse(uuidSchema, rawId);
    const rows = await this.db.tx.$queryRaw<SetRow[]>(Prisma.sql`${SET_SELECT} WHERE s.id = ${id}::uuid`);
    if (!rows[0]) throw problems.notFound('The rule set does not exist.');
    return rows[0];
  }

  private async items(setId: string): Promise<unknown[]> {
    const rows = await this.db.tx.$queryRaw<{ task_code: string; min_working_days: number; max_working_days: number; start_ref: string; calendar_code: string; overrides: unknown }[]>(Prisma.sql`
      SELECT td.code AS task_code, i.min_working_days, i.max_working_days, i.start_ref, c.code AS calendar_code, i.overrides
      FROM sla_rule_set_items i JOIN task_definitions td ON td.id = i.task_def_id JOIN work_calendars c ON c.id = i.calendar_id
      WHERE i.set_id = ${setId}::uuid ORDER BY td.code`);
    return rows.map((r) => ({
      task_code: r.task_code, min_working_days: r.min_working_days, max_working_days: r.max_working_days, start_event: r.start_ref, calendar_code: r.calendar_code,
      overrides: Array.isArray(r.overrides) ? r.overrides : [],
    }));
  }

  private async full(id: string): Promise<{ body: Record<string, unknown>; version: number }> {
    const r = await this.setRow(id);
    return { body: { ...this.summary(r), rules: await this.items(r.id) }, version: r.row_version };
  }

  /** GET /settings/sla-rule-sets */
  async list(auth: AuthContext, q: Query): Promise<unknown> {
    await this.access.requireModuleView(auth, 'admin.settings');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 1);
    const status = oneParam(q, 'status');
    if (status !== undefined && status !== 'draft' && status !== 'published') throw problems.validation([{ path: '/status', code: 'invalid', message: 'status is draft or published.' }]);
    const rows = await this.db.tx.$queryRaw<SetRow[]>(Prisma.sql`${SET_SELECT}
      WHERE true ${status ? Prisma.sql`AND s.status = ${status}` : Prisma.empty} ${cursor ? Prisma.sql`AND s.version < ${Number(cursor[0])}` : Prisma.empty}
      ORDER BY s.version DESC LIMIT ${limit + 1}`);
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return { items: slice.map((r) => this.summary(r)), page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([String(last.version)]) : null } };
  }

  /** POST /settings/sla-rule-sets */
  async createDraft(auth: AuthContext, raw: unknown): Promise<{ body: Record<string, unknown>; version: number }> {
    await this.access.requireAdmin('sla_rules', 'edit');
    void auth;
    const b = parse(draftSchema, raw);
    const r = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT admin_save_sla_rule_set(NULL::uuid, ${b.reason}::text, NULL::jsonb, NULL::int)::text AS id`);
    return this.full(r[0]!.id);
  }

  /** GET /settings/sla-rule-sets/{id} */
  async get(auth: AuthContext, id: string): Promise<{ body: Record<string, unknown>; version: number }> {
    await this.access.requireModuleView(auth, 'admin.settings');
    return this.full(id);
  }

  /** PATCH /settings/sla-rule-sets/{id} */
  async patch(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<{ body: Record<string, unknown>; version: number }> {
    void auth;
    await this.access.requireAdmin('sla_rules', 'edit');
    const version = parseIfMatch(ifMatch);
    const cur = await this.setRow(id);
    if (cur.status !== 'draft') throw new ProblemException(409, 'invalid_transition', { detail: 'Only the draft rule set can be changed.' });
    const b = parse(patchSchema, raw);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT admin_save_sla_rule_set(${cur.id}::uuid, ${b.reason}::text, ${JSON.stringify(b.rules)}::jsonb, ${version}::int)`);
    return this.full(cur.id);
  }

  /** POST /settings/sla-rule-sets/{id}/preview */
  async preview(auth: AuthContext, id: string, raw: unknown): Promise<unknown> {
    void auth;
    await this.access.requireAdmin('sla_rules', 'edit');
    const cur = await this.setRow(id);
    const b = parse(previewSchema, raw);
    const r = await this.db.tx.$queryRaw<{ r: unknown }[]>(Prisma.sql`SELECT admin_preview_sla_rule_set(${cur.id}::uuid, ${b.effective_date}::date) AS r`);
    return r[0]!.r;
  }

  /** POST /settings/sla-rule-sets/{id}/publish (step-up) */
  async publish(auth: AuthContext, id: string, ifMatch: string | undefined, key: string | undefined, raw: unknown): Promise<unknown> {
    await this.access.requireAdmin('sla_rules', 'edit');
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    return this.idem.run(auth.user.id, 'publishSlaRuleSet', key, { id, raw }, async () => {
      const cur = await this.setRow(id);
      const b = parse(publishSchema, raw);
      const r = await this.db.tx.$queryRaw<{ r: { set_id: string; affected_open_tasks: number } }[]>(Prisma.sql`
        SELECT admin_publish_sla_rule_set(${cur.id}::uuid, ${b.effective_date}::date, ${b.reason}::text, ${b.apply_to_open_tasks}::boolean, ${version}::int) AS r`);
      const after = await this.setRow(cur.id);
      return { rule_set: this.summary(after), affected_open_tasks: r[0]!.r.affected_open_tasks, recalculation_job_id: null };
    });
  }
}
