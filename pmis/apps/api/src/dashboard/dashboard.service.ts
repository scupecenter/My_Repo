import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { boolParam, oneParam, Query } from '../common/query';
import { DbService } from '../db/db.service';
import { applyContext } from '../logs/context';
import { z } from 'zod';
import { parse } from '../common/zod';

export const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DashboardParams {
  ref_date?: string;
  region_id?: number;
  cluster_code?: string;
  scenario?: string;
  stream?: string;
  /** a view of workflow_views (CW, TE, OM), Q126 */
  view?: string;
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
  const view = oneParam(q, 'view');
  if (view !== undefined) {
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(view)) throw problems.validation([{ path: '/view', code: 'invalid', message: 'view is a view code such as CW.' }]);
    p.view = view;
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

  /** 422 for a view code that no workflow version has (Q126). */
  private async requireView(code: string): Promise<void> {
    const r = await this.db.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM workflow_views WHERE code = ${code}`;
    if (Number(r[0]?.n ?? 0) === 0) throw problems.validation([{ path: '/view', code: 'unknown_view', message: `There is no view ${code}.` }]);
  }

  async get(_auth: AuthContext, q: Query): Promise<Json> {
    const regions = await this.access.requireRegions('dashboard', 'view');
    const p = dashboardParams(q);
    if (p.stream) await this.requireStream(p.stream);
    if (p.view) await this.requireView(p.view);
    const excl = await this.excludeOverrides(p);
    const rows = await this.db.tx.$queryRaw<{ r: Json }[]>(Prisma.sql`
      SELECT dash_overview(${p.ref_date ?? null}::date, ${p.region_id ?? null}::int, ${p.cluster_code ?? null}::text, ${p.scenario ?? null}::text, ${p.stream ?? null}::text, ${excl}::boolean, ${p.view ?? null}::text) AS r`);
    const r = rows[0]!.r;
    const meta = (r.meta ?? {}) as Json;
    const basis = (r.basis ?? {}) as Json;
    const milestones = (r.milestones ?? []) as Json[];
    const headline = (r.headline ?? {}) as Json;
    const ms6 = milestones.find((m) => m.code === 'MS6');
    const weightSet = await this.weightSetRef(meta.weight_set_id as string | undefined);
    const delay = (r.delay ?? { items: [] }) as Json;
    const health = (r.health ?? {}) as Json;
    const source = basis.source as string;
    const variant = await this.db.tx.$queryRaw<{ v: string }[]>`SELECT dash_pipeline_variant() AS v`;
    return {
      meta: {
        as_of: new Date().toISOString(),
        workflow_versions: meta.workflow_versions ?? [],
        override_flagged_count: meta.override_flagged_count ?? 0,
        historical_flagged_count: meta.historical_flagged_count ?? 0,
        lock_bypass_flagged_count: meta.lock_bypass_flagged_count ?? 0,
        historical_direct_flagged_count: meta.historical_direct_flagged_count ?? 0,   // 0087
        overrides_excluded: excl,
        ...(weightSet ? { weight_set: weightSet } : {}),
        project_wide: meta.project_wide === true,
        central_items_hidden: Number(((headline.project_status ?? {}) as Json).central_items_hidden ?? 0),
        manual_items_measured: Number(((headline.project_status ?? {}) as Json).manual_items_measured ?? 0),
        scope_regions: regions,
        // Q121: health index factors D and I are approved; the index carries no draft label. D16: the other factors carry one each
        health_draft: false,
        health_draft_factors: health.draft_factors ?? [],
        // Q186: blocked gates are known live, or from a snapshot taken on its own date; otherwise historically unavailable (null), not 0
        blocked_gates_available: meta.blocked_gates_available === true,
        // Q116: the pipeline style chosen by the owner (A rings, the default; B flat segmented track)
        pipeline_variant: variant[0]?.v === 'B' ? 'B' : 'A',
      },
      basis: {
        ref_date: basis.ref_date,
        today: basis.today,
        source,
        snapshot_date: basis.snapshot_date ?? null,
        snapshot_dates: basis.snapshots ?? [],
        snapshot_kinds: basis.snapshot_kinds ?? [],
        note: source === 'live' ? null
          : source === 'snapshot' ? `Headline, pipeline and stream figures come from the snapshot of this date; SLA, issues, delay attribution and health are computed as of the date from dated facts.${meta.blocked_gates_available === true ? '' : ' The snapshot was rebuilt after its date, so blocked gates are historically unavailable.'}`
            : 'No snapshot exists for this date: every figure is computed as of the date from dated facts (actual dates up to the date). Blocked gates are historically unavailable for a past date.',
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
        items: ((delay.items ?? []) as Json[]).map((i) => ({ ...i, kind: i.kind ?? (i.external_party_id ? 'external' : i.party === 'unassigned' ? 'unassigned' : 'default_type') })),
        draft: true,
      },
      regions: { items: r.regions ?? [] },
    };
  }

  /** PUT /dashboard/pipeline-variant (Q116): the database checks the right (System Admin or dashboard administer), the value, and audits it. */
  async setPipelineVariant(_auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(z.object({ variant: z.enum(['A', 'B']), reason: z.string().trim().min(3).max(1000) }).strict(), raw);
    const r = await this.db.tx.$queryRaw<{ v: string }[]>(Prisma.sql`SELECT dash_set_pipeline_variant(${b.variant}::text, ${b.reason}::text) AS v`);
    return { variant: r[0]!.v };
  }

  private async weightSetRef(id: string | undefined): Promise<Json | undefined> {
    if (!id) return undefined;
    const r = await this.db.tx.$queryRaw<{ id: string; code: string; version: number; effective_from: string; is_active: boolean }[]>`
      SELECT id::text AS id, code::text AS code, version, effective_from::text AS effective_from, (id = weight_set_in_force(code::text, cal_today())) AS is_active FROM weight_sets WHERE id = ${id}::uuid`;
    return r[0];
  }

  /** The codes among `codes` that a published workflow has as a view, in the order given (the same list as filters().views). */
  private async publishedViews(codes: string[]): Promise<string[]> {
    const r = await this.db.tx.$queryRaw<{ code: string }[]>`
      SELECT DISTINCT v.code FROM workflow_views v JOIN workflow_definitions wd ON wd.id = v.workflow_id WHERE wd.status = 'published' AND v.code = ANY(${codes}::text[])`;
    const have = new Set(r.map((x) => x.code));
    return codes.filter((c) => have.has(c));
  }

  /**
   * Runs a calculation that only reads in a transaction of its own that begins the same verified context as the request (app_begin, migration 0069: the same
   * user, so the database derives the same regions), so it sees what the request sees and can run beside it.
   */
  private async sideRead<T>(fn: () => Promise<T>): Promise<T> {
    const rc = this.db.requestContext;
    if (!rc?.userId) throw new Error('dashboard: no request context for a side read');
    // Always rolled back: the calculation uses temporary tables (so it cannot be a READ ONLY transaction), and nothing it does may be kept.
    const rollback = new Error('dashboard side read: rolled back');
    let out: { v: T } | undefined;
    try {
      await this.db.client.$transaction(
        async (tx) => {
          await applyContext(tx, rc);
          out = { v: await this.db.runIn(tx, fn, rc) };
          throw rollback;
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (e) {
      if (e !== rollback) throw e;
    }
    if (!out) throw new Error('dashboard side read: no result');
    return out.v;
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
    const views = await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null; sort_order: number }[]>`
      SELECT DISTINCT ON (v.code) v.code, v.name_en, v.name_ar, v.sort_order FROM workflow_views v JOIN workflow_definitions wd ON wd.id = v.workflow_id
      WHERE wd.status = 'published' ORDER BY v.code, wd.version DESC`;
    return {
      regions: regs,
      clusters: clusters.map((c) => c.cluster_code),
      scenarios: [...SCENARIOS],
      streams: [...streams.sort((a, b) => a.sort_order - b.sort_order).map(({ code, name_en, name_ar }) => ({ code, name_en, name_ar })), { code: 'DISMANTLE', name_en: 'Dismantle', name_ar: 'الفك' }],
      views: views.sort((a, b) => a.sort_order - b.sort_order).map(({ code, name_en, name_ar }) => ({ code, name_en, name_ar })),
    };
  }

  /**
   * GET /dashboard/export: the current view as an Excel workbook (Q127, the default) or as CSV (`format=csv`, UTF-8 with a byte-order mark so Excel
   * opens Arabic text). Needs the `export` grant on the dashboard; every export is audited.
   */
  async export(auth: AuthContext, q: Query): Promise<{ filename: string; body: Buffer; contentType: string }> {
    await this.access.requireRegions('dashboard', 'view');
    if (!(await this.access.hasGrant(auth, 'dashboard', 'export'))) {
      throw problems.forbidden('action_forbidden', 'You need the export right on the dashboard.');
    }
    const format = oneParam(q, 'format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') throw problems.validation([{ path: '/format', code: 'invalid', message: 'format is xlsx or csv.' }]);
    const query: Query = { ...q };
    delete query.format;
    // Q187: the CW and TE sheets are the same calculation with the view CW or TE. They are computed at the same time as the view on screen, each
    // in a transaction of its own with the request's own user and regions that is always rolled back (sideRead), so the workbook costs one calculation, not three.
    const viewCodes = format === 'xlsx' ? await this.publishedViews(['CW', 'TE']) : [];
    const sides = viewCodes.map((code) => this.sideRead(() => this.get(auth, { ...query, view: code })).then((data) => ({ name: code, data })));
    for (const p of sides) p.catch(() => undefined); // awaited below; a failure of the view on screen first must not leave them unhandled
    const d = await this.get(auth, query);
    const basis = d.basis as Json;
    const rows = exportRows(d);
    const name = `GSDN_Dashboard_${String(basis.ref_date)}`;
    if (format === 'csv') {
      await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('export', 'dashboard', ${String(basis.ref_date)}::text, NULL, ${JSON.stringify({ filters: query, format, rows: rows.length - 1 })}::jsonb, NULL)`);
      const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      return { filename: `${name}.csv`, body: Buffer.from(`${String.fromCharCode(0xfeff)}${csv}\r\n`, 'utf8'), contentType: 'text/csv; charset=utf-8' };
    }
    // Q187: the Project Overview is the view on screen; the CW and TE sheets are the same filters with the view CW or TE (when the workflow has it)
    const streamSheets: { name: string; data: Json }[] = await Promise.all(sides);
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('export', 'dashboard', ${String(basis.ref_date)}::text, NULL,
      ${JSON.stringify({ filters: query, format, rows: rows.length - 1, sheets: ['Project Overview', ...streamSheets.map((x) => x.name), ...DETAIL_SHEETS, 'About'] })}::jsonb, NULL)`);
    return { filename: `${name}.xlsx`, body: await exportWorkbook(d, streamSheets, query), contentType: XLSX_TYPE };
  }
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
type Cell = string | number | null;

/** The rows `section,item,metric,value` of the view (the same rows in both formats). */
export function exportRows(d: Json): Cell[][] {
  const basis = d.basis as Json;
  const rows: Cell[][] = [['section', 'item', 'metric', 'value']];
  const add = (section: string, item: string, metric: string, value: unknown): void => {
    rows.push([section, item, metric, typeof value === 'number' || typeof value === 'string' ? value : value === null || value === undefined ? null : JSON.stringify(value)]);
  };
  add('view', 'reference date', 'date', basis.ref_date);
  add('view', 'source', 'basis', basis.source);
  const h = d.headline as Json;
  add('headline', 'sites', 'active', h.sites_total);
  add('headline', 'sites', 'cancelled', h.sites_cancelled);
  for (const [k, v] of Object.entries((h.by_overall_status ?? {}) as Json)) add('headline', 'overall status', k, v);
  const ps = (h.project_status ?? {}) as Json;
  add('project status', 'project', 'progress %', ps.progress_pct);
  add('project status', 'project', 'planned %', ps.planned_pct ?? null);
  add('project status', 'project', 'progress vs plan index', ps.progress_vs_plan_index ?? null);
  for (const a of ((ps.activities ?? []) as Json[])) {
    for (const i of ((a.items ?? []) as Json[])) if (i.manual) add('project status', `${String(i.code)} ${String(i.name_en)}`, 'manual %', (i.manual as Json).value_pct);
  }
  for (const m of ((d.pipeline as Json).nodes as Json[])) {
    for (const k of ['sites_total', 'completed', 'in_progress', 'not_started', 'blocked', 'plan', 'vs_plan', 'overdue_open', 'achieved_late', 'baseline_missing']) add('milestones', `${String(m.code)} ${String(m.name_en)}`, k, m[k]);
  }
  const fc = (h.final_closure ?? {}) as Json;
  for (const k of ['sites_total', 'sites_closed', 'closed_pct']) add('final closure', 'closure', k, fc[k]);
  add('final closure', 'pending CW FAC', 'count', ((fc.pending_cw_fac ?? {}) as Json).count);
  add('final closure', 'pending TE FAC', 'count', ((fc.pending_te_fac ?? {}) as Json).count);
  for (const s of ((d.streams as Json).items as Json[])) for (const [k, v] of Object.entries((s.counts ?? {}) as Json)) add('streams', `${String(s.code)} ${String(s.name_en)}`, k, v);
  for (const s of (((d.sla as Json | undefined)?.by_stage ?? []) as Json[])) {
    for (const k of ['open_on_time', 'open_at_risk', 'open_late', 'completed_on_time', 'completed_late']) add('sla', `${String(s.stage_code)} ${String(s.name_en)}`, k, s[k]);
  }
  const iss = d.issues as Json | null;
  if (iss) {
    add('issues', 'issues', 'open', iss.open_total);
    add('issues', 'sites', 'with an open issue', iss.sites_with_open_issue);
    for (const o of (iss.by_owner as Json[])) add('issues', `owner ${String(o.owner_name ?? 'none')}`, 'open issues', o.count);
  }
  const hl = d.health as Json;
  add('health index', 'index', 'score', hl.score);
  add('health index', 'index', 'band', hl.band);
  for (const c of ((hl.components ?? []) as Json[])) add('health index', `${String(c.code)} ${String(c.name_en)}${c.draft === true ? ' (draft)' : ''}`, 'value', c.value);
  const dl = d.delay as Json;
  for (const i of ((dl.items ?? []) as Json[])) {
    const sug = (i.suggested_party ?? null) as Json | null;
    // Q7: an unattributed row names its suggested party only as a suggestion; the item text goes through the formula guard like any name
    if (i.kind === 'period') add('delay attribution (draft)', String(i.party), 'attributed late working days', i.late_working_days);
    else if (i.data_gap === true) add('delay attribution (draft)', 'data gap', 'unattributed late working days', i.late_working_days);
    else if (sug) add('delay attribution (draft)', String(sug.name), 'unattributed late working days (suggested party, not attributed)', i.late_working_days);
    else add('delay attribution (draft)', 'unattributed', 'unattributed late working days', i.late_working_days);
  }
  add('delay attribution (draft)', 'attributed', 'share %', dl.attributed_pct ?? 0);
  add('delay attribution (draft)', 'unattributed', 'share %', dl.unattributed_pct ?? 0);
  add('delay attribution (draft)', 'suspension', 'working days left out', dl.suspended_working_days ?? 0);
  for (const r of (((d.regions as Json).items ?? []) as Json[])) {
    add('regions', String(r.region_name), 'sites', r.sites_total);
    add('regions', String(r.region_name), 'progress %', r.progress_pct);
  }
  return rows;
}

export const DETAIL_SHEETS = ['Late tasks', 'Delay attribution', 'Project Status items', 'Regions'] as const;
const CONTRACT_VERSION = '0.12.7';

/** Writes the rows of a sheet: text is always a text cell (number format @), never a formula, so "=..." stays text (no formula injection). */
function fillSheet(ws: ExcelJS.Worksheet, rows: Cell[][], widths: number[]): void {
  ws.columns = widths.map((width) => ({ width }));
  for (const r of rows) {
    const row = ws.addRow(r.map((c) => (c === null ? null : typeof c === 'number' ? c : String(c))));
    row.eachCell((cell) => { if (typeof cell.value === 'string') cell.numFmt = '@'; });
  }
  ws.getRow(1).font = { bold: true };
  if (rows.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
  // printable: landscape, one page wide, the header repeated on every page; no dark fill (Q187: a dark screen never prints dark)
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1', paperSize: 9 };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/**
 * The workbook (Q187): Project Overview (the rows of the view on screen), CW and TE (the same rows for the views CW and TE), the detail sheets
 * (late tasks, delay attribution, Project Status items, regions) and About (filters, reference date, basis, definitions, versions). The figures
 * are those of GET /dashboard, the same calculation as the screen.
 */
export async function exportWorkbook(d: Json, streams: { name: string; data: Json }[], filters: Query): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GSDN Workspace';
  wb.created = new Date();
  fillSheet(wb.addWorksheet('Project Overview'), exportRows(d), [24, 44, 24, 16]);
  for (const s of streams) fillSheet(wb.addWorksheet(s.name), exportRows(s.data), [24, 44, 24, 16]);
  const sla = (d.sla ?? {}) as Json;
  fillSheet(wb.addWorksheet('Late tasks'), [['site', 'region', 'task', 'name', 'stage', 'due date', 'working days late', 'party'],
    ...(((sla.top_late ?? []) as Json[]).map((x) => [x.site_code, x.region_id, x.task_code, x.task_name, x.stage_code, x.due_date, x.days_late_wd, x.party ?? null] as Cell[]))],
  [16, 8, 8, 36, 8, 12, 12, 24]);
  const dl = (d.delay ?? {}) as Json;
  fillSheet(wb.addWorksheet('Delay attribution'), [['kind', 'party', 'suggested party (not an attribution)', 'data gap', 'late tasks', 'late working days', 'share %'],
    ...(((dl.items ?? []) as Json[]).map((i) => [i.kind, i.party, ((i.suggested_party ?? null) as Json | null)?.name ?? null, i.data_gap === true ? 'yes' : 'no', i.late_tasks, i.late_working_days, i.share_pct] as Cell[]))],
  [14, 28, 30, 10, 12, 16, 10]);
  const ps = ((d.headline as Json).project_status ?? {}) as Json;
  const psRows: Cell[][] = [['activity', 'item', 'name', 'weight', 'measured', 'progress %', 'done', 'applicable', 'manual %', 'planned % (plan)', 'reason']];
  for (const a of (ps.activities ?? []) as Json[]) {
    for (const i of (a.items ?? []) as Json[]) {
      psRows.push([a.code, i.code, i.name_en, i.weight, i.measured ? 'yes' : 'no', i.progress_pct, i.done ?? null, i.applicable ?? null,
        ((i.manual ?? null) as Json | null)?.value_pct ?? null, ((i.plan ?? null) as Json | null)?.planned_pct ?? null, i.reason ?? null] as Cell[]);
    }
  }
  fillSheet(wb.addWorksheet('Project Status items'), psRows, [8, 8, 34, 8, 10, 12, 8, 10, 10, 14, 16]);
  fillSheet(wb.addWorksheet('Regions'), [['region', 'sites', 'completed', 'in progress', 'late tasks', 'progress %', 'health'],
    ...((((d.regions as Json).items ?? []) as Json[]).map((r) => [r.region_name, r.sites_total, r.completed ?? null, r.in_progress ?? null, r.late ?? null, r.progress_pct, r.health_score ?? null] as Cell[]))],
  [16, 8, 10, 12, 10, 12, 10]);
  const basis = d.basis as Json;
  const meta = d.meta as Json;
  const ws = (meta.weight_set ?? null) as Json | null;
  const about: Cell[][] = [['item', 'value'],
    ['reference date', String(basis.ref_date)], ['basis', String(basis.source)], ['snapshot date', basis.snapshot_date ? String(basis.snapshot_date) : null],
    ['project wide', String(meta.project_wide)], ['as of', String(meta.as_of)],
    ...Object.entries(filters).map(([k, v]) => [`filter ${k}`, Array.isArray(v) ? v.join(',') : String(v)] as Cell[]),
    ['contract version', CONTRACT_VERSION], ['workflow versions', JSON.stringify(meta.workflow_versions ?? [])],
    ['weight set', ws ? `${String(ws.code)} v${String(ws.version)} from ${String(ws.effective_from)}` : null],
    ['health formula version', String(((d.health ?? {}) as Json).formula_version ?? '')],
    ['definition: progress', 'Project Status, weighted by the weight set in force; ends at HOTO. Central items count in the project-wide figure only (Q175).'],
    ['definition: progress vs plan index', 'Actual / Planned over the same items and weights (Q177); not an EVM SPI.'],
    ['definition: delay attribution', 'Working days after the due date, minus suspension days; approved periods are attributed, the rest is unattributed (Q7). Draft.'],
    ['definition: working days', 'Default work calendar: weekend Friday and Saturday, holidays table.'],
    ['sheets', `Project Overview, ${streams.map((x) => x.name).join(', ')}${streams.length ? ', ' : ''}${DETAIL_SHEETS.join(', ')}, About`]];
  fillSheet(wb.addWorksheet('About'), about, [36, 90]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** One CSV cell. A text that a spreadsheet would read as a formula (=, +, -, @, tab, CR) gets a leading quote; numbers stay numbers. */
export function csvCell(c: unknown): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'number' || typeof c === 'bigint') return String(c);
  let t = String(c);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
