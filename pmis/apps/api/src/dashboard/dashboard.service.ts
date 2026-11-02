import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { boolParam, oneParam, Query } from '../common/query';
import { DbService } from '../db/db.service';

export const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DashboardParams {
  ref_date?: string;
  region_id?: number;
  cluster_code?: string;
  scenario?: string;
  stream?: string;
  exclude_overrides?: boolean;
}

type Json = Record<string, unknown>;

/** Parses and checks the query of GET /dashboard and GET /dashboard/export. */
export function dashboardParams(q: Query): DashboardParams {
  const p: DashboardParams = {};
  const ref = oneParam(q, 'ref_date');
  if (ref !== undefined) {
    if (!DATE_RE.test(ref) || Number.isNaN(Date.parse(`${ref}T00:00:00Z`)) || new Date(`${ref}T00:00:00Z`).toISOString().slice(0, 10) !== ref) {
      throw problems.validation([{ path: '/ref_date', code: 'invalid', message: 'ref_date is a date, YYYY-MM-DD.' }]);
    }
    p.ref_date = ref;
  }
  const region = oneParam(q, 'region_id');
  if (region !== undefined) {
    if (!/^[1-7]$/.test(region)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is 1 to 7.' }]);
    p.region_id = Number(region);
  }
  const cluster = oneParam(q, 'cluster_code');
  if (cluster !== undefined) {
    if (cluster.length === 0 || cluster.length > 40) throw problems.validation([{ path: '/cluster_code', code: 'invalid', message: 'cluster_code is 1 to 40 characters.' }]);
    p.cluster_code = cluster;
  }
  const scenario = oneParam(q, 'scenario');
  if (scenario !== undefined) {
    if (!(SCENARIOS as readonly string[]).includes(scenario)) throw problems.validation([{ path: '/scenario', code: 'invalid', message: 'Unknown delivery scenario.' }]);
    p.scenario = scenario;
  }
  const stream = oneParam(q, 'stream');
  if (stream !== undefined) {
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(stream)) throw problems.validation([{ path: '/stream', code: 'invalid', message: 'stream is a stream code such as CW.' }]);
    p.stream = stream;
  }
  p.exclude_overrides = boolParam(q, 'exclude_overrides');
  return p;
}

/**
 * The main dashboard (owner request 2026-11-02; spec docs/spec/dashboard-kpis.md). Every number is computed in the database by dash_overview
 * (SECURITY DEFINER, read-only), which limits the sites to the regions of the caller's `dashboard.view` grants (B3, VI-04).
 * The API adds the filter lists, the weight-set reference and the "as of" stamp.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** The default of exclude_overrides is the setting `dashboard.exclude_overrides` (Project Status leaves out admin overrides unless told otherwise). */
  async excludeOverrides(p: DashboardParams): Promise<boolean> {
    if (p.exclude_overrides !== undefined) return p.exclude_overrides;
    const r = await this.db.tx.$queryRaw<{ v: boolean }[]>`SELECT coalesce((calc_setting('dashboard.exclude_overrides', 'true'::jsonb) #>> '{}')::boolean, true) AS v`;
    return r[0]?.v ?? true;
  }

  /** 422 for a stream code that no workflow version has (and is not DISMANTLE). */
  private async requireStream(code: string): Promise<void> {
    if (code === 'DISMANTLE') return;
    const r = await this.db.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM workflow_streams WHERE code = ${code}`;
    if (Number(r[0]?.n ?? 0) === 0) throw problems.validation([{ path: '/stream', code: 'unknown_stream', message: `There is no stream ${code}.` }]);
  }

  async get(_auth: AuthContext, q: Query): Promise<Json> {
    const regions = await this.access.requireRegions('dashboard', 'view');
    const p = dashboardParams(q);
    if (p.stream) await this.requireStream(p.stream);
    const excl = await this.excludeOverrides(p);
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT dash_overview(${p.ref_date ?? null}::date, ${p.region_id ?? null}::int, ${p.cluster_code ?? null}::text, ${p.scenario ?? null}::text, ${p.stream ?? null}::text, ${excl}::boolean) AS r`);
    const r = rows[0]!.r;
    const meta = (r.meta ?? {}) as Json;
    const basis = (r.basis ?? {}) as Json;
    const milestones = (r.milestones ?? []) as Json[];
    const headline = (r.headline ?? {}) as Json;
    const ms6 = milestones.find((m) => m.code === 'MS6');
    const weightSet = await this.weightSetRef(meta.weight_set_id as string | undefined);
    const delay = (r.delay ?? { items: [] }) as Json;
    const source = basis.source as string;
    return {
      meta: {
        as_of: new Date().toISOString(),
        workflow_versions: meta.workflow_versions ?? [],
        override_flagged_count: meta.override_flagged_count ?? 0,
        overrides_excluded: excl,
        ...(weightSet ? { weight_set: weightSet } : {}),
        project_wide: meta.project_wide === true,
        central_items_hidden: Number(((headline.project_status ?? {}) as Json).central_items_hidden ?? 0),
        scope_regions: regions,
        health_draft: true,
      },
      basis: {
        ref_date: basis.ref_date,
        today: basis.today,
        source,
        snapshot_date: basis.snapshot_date ?? null,
        snapshot_dates: basis.snapshots ?? [],
        note: source === 'live' ? null
          : source === 'snapshot' ? 'Headline, pipeline and stream figures come from the weekly snapshot of this date; SLA, issues, delay attribution and health are computed as of the date from dated facts.'
            : 'No snapshot exists for this date: every figure is computed as of the date from dated facts (actual dates up to the date). Blocked gates are not available for a past date.',
      },
      filters: await this.filters(regions),
      headline: {
        sites_total: headline.sites_total,
        sites_cancelled: headline.sites_cancelled,
        by_overall_status: headline.by_overall_status,
        milestones: milestones.map((m) => ({
          code: m.code, name_en: m.name_en, name_ar: m.name_ar, order: m.order, applicable: m.sites_total, done: m.completed, done_pct: m.completed_pct,
          plan: m.plan, vs_plan: m.vs_plan, baseline_missing: m.baseline_missing,
        })),
        on_air: ms6 ? { code: 'MS6', applicable: ms6.sites_total, done: ms6.completed, done_pct: ms6.completed_pct, plan: ms6.plan, vs_plan: ms6.vs_plan } : null,
        final_closure: headline.final_closure,
        project_status: headline.project_status,
      },
      pipeline: { nodes: milestones },
      streams: { items: r.streams ?? [] },
      sla: r.sla,
      gates: r.gates,
      issues: r.issues ?? null,
      health: r.health,
      delay: {
        ...delay,
        items: ((delay.items ?? []) as Json[]).map((i) => ({ ...i, kind: i.external_party_id ? 'external' : i.party === 'unassigned' ? 'unassigned' : 'default_type' })),
        draft: true,
      },
      regions: { items: r.regions ?? [] },
    };
  }

  private async weightSetRef(id: string | undefined): Promise<Json | undefined> {
    if (!id) return undefined;
    const r = await this.db.tx.$queryRaw<{ id: string; code: string; version: number; effective_from: string; is_active: boolean }[]>`
      SELECT id::text AS id, code::text AS code, version, effective_from::text AS effective_from, (id = weight_set_in_force(code::text, cal_today())) AS is_active FROM weight_sets WHERE id = ${id}::uuid`;
    return r[0];
  }

  /** The values the filter bar offers: the caller's regions, the clusters of the sites they see, the scenarios and the streams. */
  private async filters(regions: number[] | null): Promise<Json> {
    const regs = await this.db.tx.$queryRaw<{ id: number; name_en: string; name_ar: string | null }[]>(Prisma.sql`
      SELECT id, name_en, name_ar FROM regions ${regions === null ? Prisma.empty : Prisma.sql`WHERE id = ANY(${regions}::int[])`} ORDER BY id`);
    const clusters = await this.db.tx.$queryRaw<{ cluster_code: string }[]>(Prisma.sql`
      SELECT DISTINCT c.cluster_code FROM clusters c JOIN sites s ON s.cluster_id = c.id AND s.is_active
      ${regions === null ? Prisma.empty : Prisma.sql`WHERE s.region_id = ANY(${regions}::int[])`} ORDER BY c.cluster_code LIMIT 500`);
    const streams = await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null; sort_order: number }[]>`
      SELECT DISTINCT ON (ws.code) ws.code, ws.name_en, ws.name_ar, ws.sort_order FROM workflow_streams ws JOIN workflow_definitions wd ON wd.id = ws.workflow_id
      WHERE wd.status = 'published' ORDER BY ws.code, wd.version DESC`;
    return {
      regions: regs,
      clusters: clusters.map((c) => c.cluster_code),
      scenarios: [...SCENARIOS],
      streams: [...streams.sort((a, b) => a.sort_order - b.sort_order).map(({ code, name_en, name_ar }) => ({ code, name_en, name_ar })), { code: 'DISMANTLE', name_en: 'Dismantle', name_ar: 'الفك' }],
    };
  }

  /** GET /dashboard/export: the current view as a CSV file (UTF-8 with a byte-order mark, so Excel opens Arabic text). Needs the `export` grant on the dashboard. */
  async exportCsv(auth: AuthContext, q: Query): Promise<{ filename: string; body: string }> {
    await this.access.requireRegions('dashboard', 'view');
    if (!(await this.access.hasGrant(auth, 'dashboard', 'export'))) {
      throw problems.forbidden('action_forbidden', 'You need the export right on the dashboard.');
    }
    const d = await this.get(auth, q);
    const basis = d.basis as Json;
    const rows: (string | number | null)[][] = [['section', 'item', 'metric', 'value']];
    const add = (section: string, item: string, metric: string, value: unknown): void => {
      rows.push([section, item, metric, typeof value === 'number' || typeof value === 'string' ? value : value === null || value === undefined ? null : JSON.stringify(value)]);
    };
    add('view', 'reference date', 'date', basis.ref_date);
    add('view', 'source', 'basis', basis.source);
    const h = d.headline as Json;
    add('headline', 'sites', 'active', h.sites_total);
    add('headline', 'sites', 'cancelled', h.sites_cancelled);
    for (const [k, v] of Object.entries((h.by_overall_status ?? {}) as Json)) add('headline', 'overall status', k, v);
    for (const m of ((d.pipeline as Json).nodes as Json[])) {
      for (const k of ['sites_total', 'completed', 'in_progress', 'not_started', 'blocked', 'plan', 'vs_plan', 'overdue_open', 'achieved_late', 'baseline_missing']) add('milestones', `${m.code} ${m.name_en}`, k, m[k]);
    }
    const fc = (h.final_closure ?? {}) as Json;
    for (const k of ['sites_total', 'sites_closed', 'closed_pct']) add('final closure', 'closure', k, fc[k]);
    add('final closure', 'pending CW FAC', 'count', ((fc.pending_cw_fac ?? {}) as Json).count);
    add('final closure', 'pending TE FAC', 'count', ((fc.pending_te_fac ?? {}) as Json).count);
    for (const s of ((d.streams as Json).items as Json[])) for (const [k, v] of Object.entries((s.counts ?? {}) as Json)) add('streams', `${s.code} ${s.name_en}`, k, v);
    for (const s of (((d.sla as Json | undefined)?.by_stage ?? []) as Json[])) {
      for (const k of ['open_on_time', 'open_at_risk', 'open_late', 'completed_on_time', 'completed_late']) add('sla', `${s.stage_code} ${s.name_en}`, k, s[k]);
    }
    const iss = d.issues as Json | null;
    if (iss) {
      add('issues', 'issues', 'open', iss.open_total);
      add('issues', 'sites', 'with an open issue', iss.sites_with_open_issue);
      for (const o of (iss.by_owner as Json[])) add('issues', `owner ${o.owner_name ?? 'none'}`, 'open issues', o.count);
    }
    const hl = d.health as Json;
    add('health index (draft)', 'index', 'score', hl.score);
    add('health index (draft)', 'index', 'band', hl.band);
    for (const c of ((hl.components ?? []) as Json[])) add('health index (draft)', `${c.code} ${c.name_en}`, 'value', c.value);
    for (const i of (((d.delay as Json).items ?? []) as Json[])) add('delay attribution (draft)', String(i.party), 'late working days', i.late_working_days);
    for (const r of (((d.regions as Json).items ?? []) as Json[])) {
      add('regions', String(r.region_name), 'sites', r.sites_total);
      add('regions', String(r.region_name), 'progress %', r.progress_pct);
    }
    const csv = rows.map((r) => r.map((c) => (c === null ? '' : /[",\n\r;]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\r\n');
    await this.db.tx.$executeRaw(Prisma.sql`INSERT INTO audit_log (action, entity_type, entity_id, after, actor_id, ip)
      VALUES ('export', 'dashboard', ${String(basis.ref_date)}, ${JSON.stringify({ filters: q, rows: rows.length - 1 })}::jsonb, ${auth.user.id}::uuid, ${auth.ip}::text)`);
    return { filename: `GSDN_Dashboard_${String(basis.ref_date)}.csv`, body: `${String.fromCharCode(0xfeff)}${csv}\r\n` };
  }
}
