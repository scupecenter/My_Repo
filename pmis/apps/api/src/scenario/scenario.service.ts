import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

const reason = z.string().trim().min(3).max(1000);
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;
const RULES = ['applies', 'na', 'sla_not_measured', 'flag'] as const;
const FLAGS = ['cw', 'tower', 'adaption_only', 'gecol', 'hlc', 'rfi', 'te'] as const;

const ruleSchema = z.object({
  task_code: z.string().min(1).max(40),
  scenario: z.enum(SCENARIOS).nullable().default(null),
  rule: z.enum(RULES),
  flag_expr: z.enum(FLAGS).nullable().default(null),
  reason: z.string().trim().min(3).max(500),
}).strict();
const putSchema = z.object({ reason, rules: z.array(ruleSchema).max(500) }).strict();
const applySchema = z.object({ reason }).strict();
const exceptionSchema = z.object({ task_code: z.string().min(1).max(40), reason, change_request_id: uuidSchema.nullable().optional() }).strict();
const revokeSchema = z.object({ reason }).strict();

type UserRef = { id: string; display_name: string; employee_id: string | null };

interface Applicability {
  site_id: string;
  delivery_scenario: string | null;
  rfi: { applies: boolean; master_rfi: boolean; differs: boolean };
  conflicts: { task_code: string; scenario: string; flag_expr: string; message: string }[];
  tasks: Record<string, unknown>[];
  exceptions: { id: string; approved_by: string | UserRef | null; revoked_by: string | UserRef | null; [k: string]: unknown }[];
}

/**
 * Scenario applicability (owner answers Q2, Q3, Q15; migration 0052), the Master SLA sheet column map (Q14) and the gate history (Q9).
 * The database decides every rule; writes go through the audited admin_* functions (owner pmis_definer).
 */
@Injectable()
export class ScenarioService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  // ------------------------------------------------------------------ settings
  /** GET /settings/scenario-rules */
  async rules(auth: AuthContext): Promise<{ body: Record<string, unknown>; version: number }> {
    await this.access.requireModuleView(auth, 'admin.settings');
    const v = await this.db.tx.$queryRaw<{ version: number }[]>(Prisma.sql`SELECT version FROM scenario_rule_state`);
    const rows = await this.db.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT r.id::text AS id, r.task_code, r.scenario::text AS scenario, r.rule, r.flag_expr, r.reason, r.version, r.created_at
      FROM scenario_task_rules r WHERE r.is_active AND r.workflow_id = sla_workflow()
      ORDER BY r.task_code COLLATE "C", r.scenario NULLS FIRST, r.rule COLLATE "C"`);
    const version = v[0]?.version ?? 1;
    return { body: { version, items: rows }, version };
  }

  /** PUT /settings/scenario-rules (step-up): replaces the active list; rules reach a site's tasks when its applicability is applied. */
  async putRules(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<{ body: Record<string, unknown>; version: number }> {
    await this.access.requireAdmin('task_definitions', 'edit');
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT admin_save_scenario_rules(${JSON.stringify(b.rules)}::jsonb, ${b.reason}::text, ${version}::int)`);
    return this.rules(auth);
  }

  /** GET /settings/sla-master-columns (Q14) */
  async masterColumns(auth: AuthContext): Promise<{ items: unknown[] }> {
    await this.access.requireModuleView(auth, 'admin.settings');
    const items = await this.db.tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT seq, master_column, sla_code, name_en, from_to, applies_when, task_code, flag_condition, inherited, note FROM sla_master_columns ORDER BY seq`);
    return { items };
  }

  // ------------------------------------------------------------------ sites
  private async site(rawId: string): Promise<{ id: string; region_id: number }> {
    const regions = await this.access.requireRegions('sites', 'view');
    const id = parse(uuidSchema, rawId);
    const rows = await this.db.tx.$queryRaw<{ id: string; region_id: number }[]>(Prisma.sql`
      SELECT id::text AS id, region_id FROM sites WHERE id = ${id}::uuid ${regions === null ? Prisma.empty : Prisma.sql`AND region_id = ANY(${regions}::int[])`}`);
    if (!rows[0]) throw problems.notFound('The site does not exist or is not visible to you.');
    return rows[0];
  }

  private async userRefs(ids: string[]): Promise<Map<string, UserRef>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.tx.$queryRaw<UserRef[]>(Prisma.sql`
      SELECT id::text AS id, display_name, nullif(btrim(employee_id), '') AS employee_id FROM users WHERE id = ANY(${ids}::uuid[])`);
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async applicability(siteId: string): Promise<Applicability> {
    const rows = await this.db.tx.$queryRaw<{ a: Applicability }[]>(Prisma.sql`SELECT site_applicability(${siteId}::uuid) AS a`);
    const a = rows[0]!.a;
    const ids = [...new Set(a.exceptions.flatMap((e) => [e.approved_by, e.revoked_by]).filter((x): x is string => typeof x === 'string'))];
    const refs = await this.userRefs(ids);
    for (const e of a.exceptions) {
      e.approved_by = typeof e.approved_by === 'string' ? (refs.get(e.approved_by) ?? { id: e.approved_by, display_name: '', employee_id: null }) : null;
      e.revoked_by = typeof e.revoked_by === 'string' ? (refs.get(e.revoked_by) ?? { id: e.revoked_by, display_name: '', employee_id: null }) : null;
    }
    return a;
  }

  /** GET /sites/{site_id}/applicability */
  async get(auth: AuthContext, rawId: string): Promise<Applicability> {
    void auth;
    const s = await this.site(rawId);
    return this.applicability(s.id);
  }

  /** POST /sites/{site_id}/applicability/apply (step-up) */
  async apply(auth: AuthContext, rawId: string, raw: unknown): Promise<Record<string, unknown>> {
    const s = await this.site(rawId);
    const b = parse(applySchema, raw);
    await this.stepUp.require(auth);
    const r = await this.db.tx.$queryRaw<{ r: Record<string, unknown> }[]>(Prisma.sql`SELECT admin_apply_applicability(${s.id}::uuid, ${b.reason}::text) AS r`);
    return { result: r[0]!.r, applicability: await this.applicability(s.id) };
  }

  /** POST /sites/{site_id}/scope-exceptions (step-up) */
  async addException(auth: AuthContext, rawId: string, raw: unknown): Promise<Applicability> {
    const s = await this.site(rawId);
    const b = parse(exceptionSchema, raw);
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw(Prisma.sql`
      SELECT admin_save_scope_exception(${s.id}::uuid, ${b.task_code}::text, ${b.change_request_id ?? null}::uuid, ${b.reason}::text)`);
    return this.applicability(s.id);
  }

  /** POST /sites/{site_id}/scope-exceptions/{exception_id}/revoke (step-up) */
  async revokeException(auth: AuthContext, rawId: string, rawEx: string, raw: unknown): Promise<Applicability> {
    const s = await this.site(rawId);
    const ex = parse(uuidSchema, rawEx);
    const b = parse(revokeSchema, raw);
    const own = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text AS id FROM site_scope_exceptions WHERE id = ${ex}::uuid AND site_id = ${s.id}::uuid`);
    if (!own[0]) throw problems.notFound('The exception does not exist on this site.');
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT admin_revoke_scope_exception(${ex}::uuid, ${b.reason}::text)::text AS done`);
    return this.applicability(s.id);
  }

  /** GET /sites/{site_id}/gate-events (Q9): the gate history, newest first. */
  async gateEvents(auth: AuthContext, rawId: string, q: Query): Promise<{ items: unknown[] }> {
    void auth;
    const s = await this.site(rawId);
    const gate = oneParam(q, 'gate_code');
    if (gate !== undefined && !/^G[0-9]{1,2}$/.test(gate)) throw problems.validation([{ path: '/gate_code', code: 'invalid', message: 'gate_code is a gate code such as G4.' }]);
    const items = await this.db.tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT e.id::text AS id, e.gate_code, e.event, e.status, e.gate_date::text AS gate_date, e.previous_date::text AS previous_date, e.shifted, e.cause, e.at
      FROM site_gate_events e WHERE e.site_id = ${s.id}::uuid ${gate ? Prisma.sql`AND e.gate_code = ${gate}` : Prisma.empty}
      ORDER BY e.id DESC LIMIT 500`);
    return { items };
  }
}
