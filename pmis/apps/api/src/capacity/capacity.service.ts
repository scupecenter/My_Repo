import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const code = z.string().regex(/^[a-z0-9_]{2,30}$/);
const putBody = z.object({
  skills: z.array(z.object({ code, name_en: z.string().trim().min(1).max(60), name_ar: z.string().trim().max(60) }).strict()).max(30),
  crews: z.array(z.object({
    id: z.string().trim().min(1).max(40), region_id: z.number().int().min(1).max(7), name: z.string().trim().min(1).max(80),
    size: z.number().int().min(1).max(200), skills: z.array(code).max(30),
  }).strict()).max(200),
  efforts: z.array(z.object({ task_code: z.string().trim().min(1).max(60), skill: code, person_days: z.number().gt(0).max(365) }).strict()).max(500),
  days_per_week: z.number().int().min(1).max(7),
  utilization_pct: z.number().int().min(10).max(100),
  horizon_weeks: z.number().int().min(1).max(26),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface CapacityPlanSettingsDto {
  skills: { code: string; name_en: string; name_ar: string }[];
  crews: { id: string; region_id: number; name: string; size: number; skills: string[] }[];
  efforts: { task_code: string; skill: string; person_days: number }[];
  days_per_week: number;
  utilization_pct: number;
  horizon_weeks: number;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

export type CapacityStatus = 'none' | 'ok' | 'tight' | 'over';
export interface CapacityCell { capacity_days: number; demand_days: number; load_pct: number | null; status: CapacityStatus }
export interface CapacityPlanDto {
  horizon_weeks: number;
  weeks: string[];
  regions: {
    region_id: number; code: string; name_en: string; name_ar: string | null;
    skills: { skill: string; name_en: string; name_ar: string; cells: CapacityCell[] }[];
    /** Planned tasks with no effort entry in the settings: they carry no demand until one is added. */
    unestimated: number[];
    crews: number;
  }[];
  undated_tasks: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Load statuses: up to 85 % ok, up to 100 % tight, above 100 % over; demand with no capacity is over. */
export function cellOf(capacity: number, demand: number): CapacityCell {
  const c = round1(capacity), d = round1(demand);
  if (c === 0 && d === 0) return { capacity_days: 0, demand_days: 0, load_pct: null, status: 'none' };
  if (c === 0) return { capacity_days: 0, demand_days: d, load_pct: null, status: 'over' };
  const load = Math.round((demand / capacity) * 100);
  return { capacity_days: c, demand_days: d, load_pct: load, status: load > 100 ? 'over' : load > 85 ? 'tight' : 'ok' };
}

/**
 * Resource capacity planning (migration 0666, contract 0.15.595): crews and skills per region against the planned tasks. The setting `capacity.plan`
 * is edited by a System Admin (or a delegate of `settings` edit for all regions) with a reason, a step-up and If-Match, audited. The weekly plan is
 * computed on read from open tasks (planned date, else due date; late ones count in the first week) and the effort entered per task definition.
 * A crew with several skills splits its days evenly across them, so nothing is counted twice.
 */
@Injectable()
export class CapacityService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<CapacityPlanSettingsDto> {
    const rows = await this.db.tx.$queryRaw<{ r: CapacityPlanSettingsDto }[]>(sql);
    return rows[0]!.r;
  }

  get(): Promise<CapacityPlanSettingsDto> {
    return this.one(Prisma.sql`SELECT capacity_plan_state() AS r`);
  }

  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<CapacityPlanSettingsDto> {
    const { reason, ...body } = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_capacity_plan(${JSON.stringify(body)}::jsonb, ${reason}::text, ${etag}::int) AS r`);
  }

  private async regions(): Promise<number[] | null> {
    const a = await this.access.requireRegions('sites', 'view');
    const b = await this.access.requireRegions('reports', 'view');
    if (a === null) return b;
    if (b === null) return a;
    return a.filter((r) => b.includes(r));
  }

  /** GET /capacity/plan?region_id= */
  async plan(q: Record<string, unknown>): Promise<CapacityPlanDto> {
    const allowed = await this.regions();
    const one = oneParam(q, 'region_id');
    if (one && !/^[1-7]$/.test(one)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    const scope = allowed === null ? null : one ? allowed.filter((r) => r === Number(one)) : allowed;
    const only = scope === null && one ? [Number(one)] : scope;
    const cfg = await this.one(Prisma.sql`SELECT capacity_plan_state() AS r`);
    const weeks = (await this.db.tx.$queryRaw<{ w: string }[]>(Prisma.sql`
      SELECT to_char(date_trunc('week', public.cal_today()::timestamp) + (g * interval '7 days'), 'YYYY-MM-DD') AS w FROM generate_series(0, ${cfg.horizon_weeks - 1}::int) g ORDER BY g`)).map((r) => r.w);
    const regionCond = only === null ? Prisma.sql`true` : Prisma.sql`t.region_id = ANY(${only}::int[])`;
    const demand = await this.db.tx.$queryRaw<{ region_id: number; task_code: string; wk: string; n: number }[]>(Prisma.sql`
      SELECT t.region_id, td.code AS task_code,
             to_char(date_trunc('week', greatest(coalesce(t.planned_date, t.due_date), public.cal_today())::timestamp), 'YYYY-MM-DD') AS wk, count(*)::int AS n
        FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id
       WHERE t.state IN ('locked', 'open', 'entry', 'in_review', 'in_approval') AND NOT t.is_na AND ${regionCond}
         AND coalesce(t.planned_date, t.due_date) IS NOT NULL
         AND coalesce(t.planned_date, t.due_date) < date_trunc('week', public.cal_today()::timestamp)::date + ${cfg.horizon_weeks * 7}::int
       GROUP BY 1, 2, 3`);
    const undated = (await this.db.tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM task_instances t
       WHERE t.state IN ('locked', 'open', 'entry', 'in_review', 'in_approval') AND NOT t.is_na AND ${regionCond} AND t.planned_date IS NULL AND t.due_date IS NULL`))[0]?.n ?? 0;
    const names = await this.db.tx.$queryRaw<{ id: number; code: string; name_en: string; name_ar: string | null }[]>(Prisma.sql`SELECT id, code, name_en, name_ar FROM regions ORDER BY id`);

    const effort = new Map(cfg.efforts.map((e) => [e.task_code, e]));
    const skillName = new Map(cfg.skills.map((s) => [s.code, s]));
    const perCrewDay = (cfg.days_per_week * cfg.utilization_pct) / 100;
    const out: CapacityPlanDto['regions'] = [];
    for (const r of names) {
      if (only !== null && !only.includes(r.id)) continue;
      const crews = cfg.crews.filter((c) => c.region_id === r.id);
      const cap = new Map<string, number>(); // skill -> days per week
      for (const c of crews) for (const s of c.skills) cap.set(s, (cap.get(s) ?? 0) + (c.size * perCrewDay) / c.skills.length);
      const dem = new Map<string, number[]>(); // skill -> days per week index
      const unest = weeks.map(() => 0);
      let any = false;
      for (const d of demand.filter((x) => x.region_id === r.id)) {
        any = true;
        const wi = weeks.indexOf(d.wk);
        if (wi < 0) continue;
        const e = effort.get(d.task_code);
        if (!e) { unest[wi]! += d.n; continue; }
        const arr = dem.get(e.skill) ?? weeks.map(() => 0);
        arr[wi]! += d.n * e.person_days;
        dem.set(e.skill, arr);
      }
      if (!crews.length && !any) continue;
      const skillCodes = [...new Set([...cap.keys(), ...dem.keys()])].sort((a, b) => (skillName.get(a)?.name_en ?? a).localeCompare(skillName.get(b)?.name_en ?? b));
      out.push({
        region_id: r.id, code: r.code, name_en: r.name_en, name_ar: r.name_ar, crews: crews.length, unestimated: unest,
        skills: skillCodes.map((s) => ({
          skill: s, name_en: skillName.get(s)?.name_en ?? s, name_ar: skillName.get(s)?.name_ar ?? '',
          cells: weeks.map((_, i) => cellOf(cap.get(s) ?? 0, dem.get(s)?.[i] ?? 0)),
        })),
      });
    }
    return { horizon_weeks: cfg.horizon_weeks, weeks, regions: out, undated_tasks: undated };
  }
}
