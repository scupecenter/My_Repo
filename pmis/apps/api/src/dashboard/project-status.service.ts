import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { problems } from '../common/problem';
import { boolParam, isCalendarDate, oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { DashboardService } from './dashboard.service';

type Json = Record<string, unknown>;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const manualSchema = z.object({
  value_pct: z.number().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, 'At most 3 decimals.'),
  effective_date: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD.'),
  reason: z.string().trim().min(3).max(1000),
  // Q176: where the value comes from (required since 0.12.7)
  source: z.string().trim().min(2).max(500),
}).strict();
const threeDecimals = (n: number): boolean => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6;
/** Q177: a plan is 1..120 points (date, planned %), or a target date (100% on that date, from 0% on an optional start date). */
const planSchema = z.object({
  points: z.array(z.object({
    date: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD.'),
    planned_pct: z.number().min(0).max(100).refine(threeDecimals, 'At most 3 decimals.'),
  }).strict()).min(1).max(120).optional(),
  target_date: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD.').optional(),
  start_date: z.string().refine(isCalendarDate, 'Use YYYY-MM-DD.').optional(),
  reason: z.string().trim().min(3).max(1000),
  source: z.string().trim().min(2).max(500),
}).strict().superRefine((b, ctx) => {
  if ((b.points === undefined) === (b.target_date === undefined)) ctx.addIssue({ code: 'custom', path: ['points'], message: 'Send points or target_date, one of them.' });
  if (b.start_date !== undefined && b.target_date === undefined) ctx.addIssue({ code: 'custom', path: ['start_date'], message: 'start_date goes with target_date.' });
  if (b.start_date !== undefined && b.target_date !== undefined && b.start_date >= b.target_date) ctx.addIssue({ code: 'custom', path: ['start_date'], message: 'start_date is before target_date.' });
});

/** Project Status (ends at HOTO): the weighted progress of rules.md section 6, computed with the weight set in force, or with one named for a comparison. */
@Injectable()
export class ProjectStatusService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly dash: DashboardService,
  ) {}

  private async ref(id: string): Promise<Json> {
    const r = await this.db.tx.$queryRaw<Json[]>`
      SELECT id::text AS id, code::text AS code, version, effective_from::text AS effective_from, (id = weight_set_in_force(code::text, cal_today()) AND status = 'published') AS is_active
      FROM weight_sets WHERE id = ${id}::uuid`;
    return r[0] as Json;
  }

  // ------------------------------------------------------------------ GET /project-status
  async get(_auth: AuthContext, q: Query): Promise<Json> {
    await this.access.requireRegions('dashboard', 'view');
    const regionRaw = oneParam(q, 'region_id');
    const siteRaw = oneParam(q, 'site_id');
    const group = oneParam(q, 'group_by') ?? 'none';
    const versionRaw = oneParam(q, 'weight_set_version');
    const setRaw = oneParam(q, 'weight_set_id');
    const excl = boolParam(q, 'exclude_overrides');
    if (regionRaw !== undefined && !/^[1-7]$/.test(regionRaw)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    if (siteRaw !== undefined && !uuidSchema.safeParse(siteRaw).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a UUID.' }]);
    if (!['none', 'region', 'site'].includes(group)) throw problems.validation([{ path: '/group_by', code: 'invalid', message: 'group_by is none, region or site.' }]);
    if (versionRaw !== undefined && !/^[1-9][0-9]{0,5}$/.test(versionRaw)) throw problems.validation([{ path: '/weight_set_version', code: 'invalid', message: 'weight_set_version is a positive integer.' }]);
    if (setRaw !== undefined && !uuidSchema.safeParse(setRaw).success) throw problems.validation([{ path: '/weight_set_id', code: 'invalid', message: 'weight_set_id is a UUID.' }]);
    if (versionRaw !== undefined && setRaw !== undefined) throw problems.validation([{ path: '/weight_set_id', code: 'conflict', message: 'Send weight_set_version or weight_set_id, not both.' }]);
    let ws: string | null = null;
    if (setRaw !== undefined) {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM weight_sets WHERE id = ${setRaw}::uuid AND code = 'project_status' AND status = 'published'`;
      if (!r[0]) throw problems.validation([{ path: '/weight_set_id', code: 'unknown_weight_set', message: 'There is no published Project Status weight set with this id.' }]);
      ws = r[0].id;
    }
    if (versionRaw !== undefined) {
      const r = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM weight_sets WHERE version = ${Number(versionRaw)} AND code = 'project_status' AND status = 'published'`;
      if (!r[0]) throw problems.validation([{ path: '/weight_set_version', code: 'unknown_weight_set', message: 'There is no published Project Status weight set of this version.' }]);
      ws = r[0].id;
    }
    const exclude = await this.dash.excludeOverrides({ exclude_overrides: excl });
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT dash_project_status(NULL::date, ${regionRaw ? Number(regionRaw) : null}::int, ${siteRaw ?? null}::uuid, ${group}::text, ${ws}::uuid, ${exclude}::boolean) AS r`);
    const r = rows[0]!.r;
    const meta = (r.meta ?? {}) as Json;
    const ps = (r.ps ?? {}) as Json;
    const card = (ps.card ?? {}) as Json;
    const weightSet = await this.ref(meta.weight_set_id as string);
    const flagged = Number(meta.override_flagged_count ?? 0);
    return {
      meta: {
        as_of: new Date().toISOString(),
        workflow_versions: meta.workflow_versions ?? [],
        override_flagged_count: flagged,
        historical_flagged_count: Number(meta.historical_flagged_count ?? 0),
        overrides_excluded: exclude,
        weight_set: weightSet,
      },
      scope: siteRaw ? { kind: 'site', site_id: siteRaw } : regionRaw ? { kind: 'region', region_id: Number(regionRaw) } : { kind: 'project' },
      weight_set: weightSet,
      progress_pct: card.progress_pct ?? 0,
      planned_pct: card.planned_pct ?? null,
      // Q177: Actual / Planned over the same items is named "progress vs plan index"; `spi` keeps the same value for older clients
      progress_vs_plan_index: card.progress_vs_plan_index ?? null,
      spi: card.spi ?? null,
      partial_index: card.partial_index ?? null,
      plan_coverage_pct: card.plan_coverage_pct ?? 0,
      central_items_hidden: Number(card.central_items_hidden ?? 0),
      // Q175: below the whole project the manual central values are shown apart, outside the figure
      central_line: card.central_line ?? null,
      sites_in_scope: Number(ps.sites_in_scope ?? 0),
      activities: card.activities ?? [],
      ...(group !== 'none'
        ? { rows: ((ps.rows ?? []) as Json[]).map((x) => ({ key: x.key, label: x.label, progress_pct: x.progress_pct, planned_pct: x.planned_pct ?? null, activities: x.activities ?? {} })) }
        : {}),
    };
  }

  // ------------------------------------------------------------------ Q118: manual percentage of the central items
  /**
   * GET /project-status/manual-items: the central items of the weight set in force, the value in force today and the full history of each (with its
   * source, Q176, and the historical-correction flag, Q178), and the plan of each item (Q177).
   */
  async manualItems(): Promise<Json> {
    await this.access.requireRegions('dashboard', 'view');
    const items = await this.db.tx.$queryRaw<{ item_code: string; name_en: string; name_ar: string | null; weight: string; activity_code: string; activity_name_en: string; activity_name_ar: string | null }[]>`
      SELECT item_code, name_en, name_ar, weight::text AS weight, activity_code, activity_name_en, activity_name_ar FROM ps_central_items(cal_today()) ORDER BY sort`;
    const hist = await this.db.tx.$queryRaw<{ id: string; item_code: string; version: number; value_pct: string; effective_date: string; reason: string; created_at: Date;
      by_id: string; by_name: string | null; by_emp: string | null; in_force: boolean; source: string; corr: boolean }[]>`
      SELECT v.id::text AS id, v.item_code, v.version, v.value_pct::text AS value_pct, v.effective_date::text AS effective_date, v.reason, v.created_at,
        v.source, v.historical_correction AS corr,
        v.entered_by::text AS by_id, u.display_name AS by_name, u.employee_id AS by_emp,
        (v.id = (SELECT x.id FROM ps_manual_values x WHERE x.item_code = v.item_code AND x.effective_date <= cal_today() ORDER BY x.effective_date DESC, x.version DESC LIMIT 1)) AS in_force
      FROM ps_manual_values v LEFT JOIN users u ON u.id = v.entered_by
      ORDER BY v.item_code, v.version DESC`;
    const plans = await this.db.tx.$queryRaw<{ id: string; item_code: string; version: number; points: { date: string; planned_pct: number }[]; reason: string; source: string;
      created_at: Date; by_id: string; by_name: string | null; by_emp: string | null; today_pct: string }[]>`
      SELECT DISTINCT ON (p.item_code) p.id::text AS id, p.item_code, p.version, p.points, p.reason, p.source, p.created_at, p.entered_by::text AS by_id,
        u.display_name AS by_name, u.employee_id AS by_emp, round(ps_plan_pct(p.points, cal_today()), 3)::text AS today_pct
      FROM ps_manual_plans p LEFT JOIN users u ON u.id = p.entered_by ORDER BY p.item_code, p.version DESC`;
    const can = await this.db.tx.$queryRaw<{ ok: boolean; corr: boolean; today: string; month: string }[]>`
      SELECT ps_manual_can_edit() AS ok, ps_manual_can_correct() AS corr, cal_today()::text AS today, date_trunc('month', cal_today())::date::text AS month`;
    const out = items.map((i) => {
      const h = hist.filter((x) => x.item_code === i.item_code).map((x) => ({
        id: x.id, version: x.version, value_pct: Number(x.value_pct), effective_date: x.effective_date, reason: x.reason, created_at: x.created_at.toISOString(), in_force: x.in_force,
        entered_by: { id: x.by_id, display_name: x.by_name ?? '', employee_id: x.by_emp?.trim() ?? null },
        source: x.source, historical_correction: x.corr,
      }));
      const cur = h.find((x) => x.in_force);
      const pl = plans.find((x) => x.item_code === i.item_code);
      return {
        item_code: i.item_code, name_en: i.name_en, name_ar: i.name_ar, weight: Number(i.weight), activity_code: i.activity_code,
        activity_name_en: i.activity_name_en, activity_name_ar: i.activity_name_ar,
        current: cur ? { value_pct: cur.value_pct, effective_date: cur.effective_date, version: cur.version, source: cur.source } : null,
        history: h,
        plan: pl ? {
          id: pl.id, version: pl.version, points: pl.points.map((p) => ({ date: p.date, planned_pct: Number(p.planned_pct) })), reason: pl.reason, source: pl.source,
          created_at: pl.created_at.toISOString(), planned_pct_today: Number(pl.today_pct),
          entered_by: { id: pl.by_id, display_name: pl.by_name ?? '', employee_id: pl.by_emp?.trim() ?? null },
        } : null,
      };
    });
    return {
      as_of: can[0]!.today,
      can_edit: can[0]!.ok,
      // Q178: a date before this day is a historical correction (closed month); can_correct_history says whether the caller may enter one
      open_period_from: can[0]!.month,
      can_correct_history: can[0]!.ok && can[0]!.corr,
      without_plan: out.filter((i) => i.weight > 0 && !i.plan).length,
      items: out,
      without_value: out.filter((i) => i.weight > 0 && !i.current).length,
    };
  }

  /** POST /project-status/manual-items/{item_code}/values: one new entry (value, effective date, reason). The database checks who may and audits it. */
  async addManualValue(_auth: AuthContext, rawItem: string, raw: unknown): Promise<Json> {
    await this.access.requireRegions('dashboard', 'view');
    const item = /^[A-Za-z0-9._-]{1,20}$/.test(rawItem) ? rawItem : null;
    if (!item) throw problems.notFound('There is no such central item.');
    const b = parse(manualSchema, raw);
    const r = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT ps_manual_set(${item}::text, ${b.value_pct}::numeric, ${b.effective_date}::date, ${b.reason}::text, ${b.source}::text) AS r`);
    const v = r[0]!.r;
    return { ...v, value_pct: Number(v.value_pct) };
  }

  /** POST /project-status/manual-items/{item_code}/plan (Q177): a new version of the item's plan. The database checks who may, the points and audits it. */
  async setManualPlan(_auth: AuthContext, rawItem: string, raw: unknown): Promise<Json> {
    await this.access.requireRegions('dashboard', 'view');
    const item = /^[A-Za-z0-9._-]{1,20}$/.test(rawItem) ? rawItem : null;
    if (!item) throw problems.notFound('There is no such central item.');
    const b = parse(planSchema, raw);
    const points = b.points ?? [...(b.start_date ? [{ date: b.start_date, planned_pct: 0 }] : []), { date: b.target_date as string, planned_pct: 100 }];
    const r = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT ps_manual_plan_set(${item}::text, ${JSON.stringify(points)}::jsonb, ${b.reason}::text, ${b.source}::text) AS r`);
    const v = r[0]!.r;
    return { ...v, points: ((v.points ?? []) as { date: string; planned_pct: number }[]).map((p) => ({ date: p.date, planned_pct: Number(p.planned_pct) })) };
  }

  // ------------------------------------------------------------------ GET /project-status/snapshots
  async snapshots(_auth: AuthContext, q: Query): Promise<Json> {
    const regions = await this.access.requireRegions('dashboard', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const regionRaw = oneParam(q, 'region_id');
    const from = oneParam(q, 'from');
    const to = oneParam(q, 'to');
    if (regionRaw !== undefined && !/^[1-7]$/.test(regionRaw)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    for (const [k, v] of [['from', from], ['to', to]] as const) {
      if (v !== undefined && (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw problems.validation([{ path: `/${k}`, code: 'invalid', message: `${k} is a date, YYYY-MM-DD.` }]);
    }
    // The whole-project row is a figure over every region: a caller limited to some regions sees only the rows of those regions (VI-04).
    const rows = await this.db.tx.$queryRaw<{ id: string; taken_on: string; is_global: boolean; region_id: number | null; actual_pct: string; planned_pct: string | null; spi: string | null;
      health_index: string | null; ws_id: string; kinds: string[] }[]>(Prisma.sql`
      SELECT p.id::text AS id, p.snapshot_date::text AS taken_on, p.is_global, p.region_id, p.actual_pct::text AS actual_pct, p.planned_pct::text AS planned_pct, p.spi::text AS spi,
        p.health_index::text AS health_index, p.weight_set_id::text AS ws_id,
        coalesce((SELECT array_agg(r.kind ORDER BY r.kind) FROM dash_snapshot_runs r WHERE r.snapshot_date = p.snapshot_date), ARRAY[]::text[]) AS kinds
      FROM progress_snapshots p
      WHERE true
        ${regions === null ? Prisma.empty : Prisma.sql`AND NOT p.is_global AND p.region_id = ANY(${regions}::int[])`}
        ${regionRaw ? Prisma.sql`AND p.region_id = ${Number(regionRaw)}` : Prisma.empty}
        ${from ? Prisma.sql`AND p.snapshot_date >= ${from}::date` : Prisma.empty} ${to ? Prisma.sql`AND p.snapshot_date <= ${to}::date` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (p.snapshot_date, p.id::text) < (${cursor[0] as string}::date, ${cursor[1] as string})` : Prisma.empty}
      ORDER BY p.snapshot_date DESC, p.id::text DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const sets = new Map<string, Json>();
    for (const id of new Set(page.map((r) => r.ws_id))) sets.set(id, await this.ref(id));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        taken_on: r.taken_on,
        // Q127, D186: weekly (every Thursday by default), month_end (last day of the month; wins when both), manual (taken by hand, no scheduled run)
        kind: r.kinds.includes('month_end') ? 'month_end' : r.kinds.includes('weekly') ? 'weekly' : 'manual',
        kinds: r.kinds,
        scope: r.is_global ? 'project' : 'region',
        region_id: r.region_id,
        progress_pct: Number(r.actual_pct),
        planned_pct: r.planned_pct === null ? null : Number(r.planned_pct),
        spi: r.spi === null ? null : Number(r.spi),
        health_index: r.health_index === null ? null : Number(r.health_index),
        weight_set: sets.get(r.ws_id),
      })),
      page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.taken_on, last.id]) : null },
    };
  }
}
