import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { contentVersion } from '../common/etag';
import { problems } from '../common/problem';
import { oneParam } from '../common/query';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskSummaryDto, TaskViewService, taskSelect } from '../workflow/task-view.service';

/**
 * The stage that holds the TE PAC milestone in the default workflow (stable code, ADR 0010). The cluster progress line
 * ("6 of 9 sites at TE PAC") counts the sites of the cluster whose milestone task of this stage is approved.
 */
export const TE_PAC_STAGE_CODE = 'MS7';
const SORTS = ['site_code', '-site_code', 'region', '-region', 'stage', '-stage', 'due_date', '-due_date'] as const;
const BUCKETS = ['all', 'mine', 'late', 'waiting_approval', 'closed'] as const;
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];

interface SiteRow {
  id: string;
  site_code: string;
  name: string;
  region_id: number;
  cluster_code: string | null;
  delivery_scenario: string | null;
  overall_status: string;
  current_milestone_col: string | null;
  next_milestone_col: string | null;
  workflow_version: number;
  workflow_id: string;
  total: bigint | null;
}

interface StageRow {
  site_id: string;
  code: string;
  seq: number;
  stream_code: string | null;
  name_en: string;
  name_ar: string | null;
  total: bigint;
  done: bigint;
  late: bigint;
  waiting: bigint;
  started: bigint;
  has_ms: boolean;
  ms_done: boolean;
  ms_na: boolean;
  ms_date: string | null;
}

interface StreamRow {
  workflow_id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  sort_order: number;
}

export interface StreamDto {
  code: string;
  name_en: string;
  name_ar: string | null;
  sort_order: number;
}

export interface StreamStatusDto extends StreamDto {
  state: 'not_started' | 'in_progress' | 'done' | 'na';
  current_stage: string | null;
  done_tasks: number;
  total_tasks: number;
  late_count: number;
  milestone_date: string | null;
}

/** Aggregates of one stage of one site. Used for the filters and, again, for the page that is returned. */
const STAGE_AGG = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE td.counts_toward_milestone AND NOT t.is_na AND t.state NOT IN ('na', 'skipped')) AS total,
      count(*) FILTER (WHERE td.counts_toward_milestone AND t.state = 'approved') AS done,
      count(*) FILTER (WHERE t.state NOT IN ('approved', 'na', 'skipped', 'locked') AND t.due_date < current_date) AS late,
      count(*) FILTER (WHERE t.state IN ('in_review', 'in_approval')) AS waiting,
      count(*) FILTER (WHERE t.state IN ('entry', 'in_review', 'in_approval', 'approved')) AS started,
      coalesce(bool_or(td.is_milestone_task), false) AS has_ms,
      coalesce(bool_or(td.is_milestone_task AND t.state = 'approved'), false) AS ms_done,
      coalesce(bool_or(td.is_milestone_task AND (t.state IN ('na', 'skipped') OR t.is_na)), false) AS ms_na,
      (max(t.actual_date) FILTER (WHERE td.is_milestone_task AND t.state = 'approved'))::text AS ms_date,
      min(t.due_date) FILTER (WHERE t.state NOT IN ('approved', 'na', 'skipped')) AS next_due
    FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id
    WHERE t.site_id = s.id AND td.stage_id = st.id
  ) a ON true`;

const stageDone = (r: StageRow): boolean => r.ms_done || (!r.has_ms && Number(r.total) > 0 && Number(r.done) >= Number(r.total));
const stageNa = (r: StageRow): boolean => (r.has_ms && r.ms_na && !r.ms_done) || (!r.has_ms && Number(r.total) === 0);

@Injectable()
export class SitesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly view: TaskViewService,
  ) {}

  private intList(q: Record<string, unknown>, key: string, min: number, max: number): number[] {
    const v = q[key];
    if (v === undefined) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((x) => {
      const n = typeof x === 'string' && /^[0-9]+$/.test(x) ? Number(x) : NaN;
      if (!Number.isInteger(n) || n < min || n > max) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is an integer from ${min} to ${max}.` }]);
      return n;
    });
  }

  private async streamsOf(workflowIds: string[]): Promise<Map<string, StreamDto[]>> {
    const out = new Map<string, StreamDto[]>();
    if (workflowIds.length === 0) return out;
    const rows = await this.db.tx.$queryRaw<StreamRow[]>(Prisma.sql`
      SELECT workflow_id::text AS workflow_id, code, name_en, name_ar, sort_order FROM workflow_streams WHERE workflow_id = ANY(${workflowIds}::uuid[]) ORDER BY sort_order`);
    for (const r of rows) {
      const list = out.get(r.workflow_id) ?? [];
      list.push({ code: r.code, name_en: r.name_en, name_ar: r.name_ar, sort_order: r.sort_order });
      out.set(r.workflow_id, list);
    }
    return out;
  }

  // ------------------------------------------------------------------ GET /sites
  async list(auth: AuthContext, q: Record<string, unknown>): Promise<unknown> {
    const regions = await this.access.requireRegions('sites', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 1);
    const offset = cursor ? Number(cursor[0]) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw problems.badRequest('The cursor is not valid.');

    const text = oneParam(q, 'q')?.trim();
    const stageCode = oneParam(q, 'stage_code');
    const scenario = oneParam(q, 'scenario');
    const status = oneParam(q, 'overall_status');
    const bucket = oneParam(q, 'bucket') ?? 'all';
    const cluster = oneParam(q, 'cluster_code');
    const batch = oneParam(q, 'delivery_batch');
    const wfv = oneParam(q, 'workflow_version');
    const stream = oneParam(q, 'stream');
    const sort = oneParam(q, 'sort') ?? 'site_code';
    const regionIds = this.intList(q, 'region_id', 1, 7);
    if (scenario !== undefined && !SCENARIOS.includes(scenario)) throw problems.validation([{ path: '/scenario', code: 'invalid', message: 'Unknown delivery scenario.' }]);
    if (status !== undefined && !STATUSES.includes(status)) throw problems.validation([{ path: '/overall_status', code: 'invalid', message: 'Unknown overall status.' }]);
    if (!(BUCKETS as readonly string[]).includes(bucket)) throw problems.validation([{ path: '/bucket', code: 'invalid', message: 'Unknown bucket.' }]);
    if (!(SORTS as readonly string[]).includes(sort)) throw problems.validation([{ path: '/sort', code: 'invalid', message: 'Unknown sort.' }]);
    if (wfv !== undefined && !/^[0-9]{1,6}$/.test(wfv)) throw problems.validation([{ path: '/workflow_version', code: 'invalid', message: 'workflow_version is a positive integer.' }]);
    if (stream !== undefined) await this.requireStream(stream);

    const where: Prisma.Sql[] = [Prisma.sql`s.is_active`];
    if (regions !== null) where.push(Prisma.sql`s.region_id = ANY(${regions}::int[])`);
    if (regionIds.length > 0) where.push(Prisma.sql`s.region_id = ANY(${regionIds}::int[])`);
    if (text) where.push(Prisma.sql`(s.site_code ILIKE ${likePattern(text)} OR s.owner_site_id ILIKE ${likePattern(text)} OR s.name ILIKE ${likePattern(text)})`);
    if (scenario) where.push(Prisma.sql`s.delivery_scenario::text = ${scenario}`);
    if (status) where.push(Prisma.sql`s.overall_status::text = ${status}`);
    if (cluster) where.push(Prisma.sql`c.cluster_code = ${cluster}`);
    if (batch) where.push(Prisma.sql`s.delivery_batch = ${batch}`);
    if (wfv) where.push(Prisma.sql`wd.version = ${Number(wfv)}`);
    for (const pair of this.customPairs(q)) {
      where.push(Prisma.sql`EXISTS (SELECT 1 FROM field_definitions fd WHERE fd.entity_type = 'site' AND fd.code = ${pair[0]} AND fd.is_active AND fd.in_list_filters
        AND coalesce(app_resolve_field_access(${auth.user.id}::uuid, fd.id)::text, 'edit') <> 'hidden') AND s.custom ->> ${pair[0]} = ${pair[1]}`);
    }

    const post: Prisma.Sql[] = [];
    if (stageCode) post.push(Prisma.sql`ss.cur_stage = ${stageCode}`);
    if (stream) post.push(Prisma.sql`coalesce(ss.has_work, false)`);
    if (bucket === 'late') post.push(Prisma.sql`coalesce(ss.late, 0) > 0`);
    else if (bucket === 'waiting_approval') post.push(Prisma.sql`coalesce(ss.waiting, 0) > 0`);
    else if (bucket === 'closed') post.push(Prisma.sql`(vis.overall_status = 'completed' OR (coalesce(ss.all_done, false) AND coalesce(ss.has_work, false)))`);
    else if (bucket === 'mine') {
      post.push(Prisma.sql`EXISTS (SELECT 1 FROM task_instances tt JOIN task_definitions tdd ON tdd.id = tt.task_def_id JOIN stage_definitions stt ON stt.id = tdd.stage_id
        WHERE tt.site_id = vis.id AND tt.state IN ('open', 'entry', 'in_review', 'in_approval') ${stream ? Prisma.sql`AND stt.stream_code = ${stream}` : Prisma.empty}
        AND (tt.ball_in_court_user_id = ${auth.user.id}::uuid OR wf_is_eligible(tt.id,
              wf_kind(CASE WHEN tt.path_frozen_at IS NULL THEN wf_levels_live(tt.id) ELSE tt.levels_required END, greatest(tt.current_level, 1)), ${auth.user.id}::uuid)))`);
    }

    const dir = sort.startsWith('-') ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const key = sort.replace(/^-/, '');
    const order =
      key === 'region' ? Prisma.sql`vis.region_id ${dir}, vis.site_code ASC`
      : key === 'stage' ? Prisma.sql`ss.cur_seq ${dir} NULLS LAST, vis.site_code ASC`
      : key === 'due_date' ? Prisma.sql`ss.next_due ${dir} NULLS LAST, vis.site_code ASC`
      : Prisma.sql`vis.site_code ${dir}`;

    const rows = await this.db.tx.$queryRaw<SiteRow[]>(Prisma.sql`
      WITH vis AS (
        SELECT s.*, c.cluster_code AS cluster_code_v, wd.version AS wf_version
        FROM sites s JOIN workflow_definitions wd ON wd.id = s.workflow_version_id LEFT JOIN clusters c ON c.id = s.cluster_id
        WHERE ${Prisma.join(where, ' AND ')}
      ), flags AS (
        SELECT s.id AS site_id, st.code, st.seq, a.late, a.waiting, a.next_due,
          (a.ms_done OR (NOT a.has_ms AND a.total > 0 AND a.done >= a.total)) AS is_done,
          ((a.has_ms AND a.ms_na AND NOT a.ms_done) OR (NOT a.has_ms AND a.total = 0)) AS is_na
        FROM vis AS s
        JOIN stage_definitions st ON st.workflow_id = s.workflow_version_id AND st.is_active ${stream ? Prisma.sql`AND st.stream_code = ${stream}` : Prisma.empty}
        ${STAGE_AGG}
      ), ss AS (
        SELECT site_id, (array_agg(code ORDER BY seq) FILTER (WHERE NOT is_done AND NOT is_na))[1] AS cur_stage,
          (array_agg(seq ORDER BY seq) FILTER (WHERE NOT is_done AND NOT is_na))[1] AS cur_seq,
          sum(late) AS late, sum(waiting) AS waiting, min(next_due) AS next_due,
          bool_and(is_done OR is_na) AS all_done, bool_or(NOT is_na) AS has_work
        FROM flags GROUP BY site_id
      )
      SELECT vis.id::text AS id, vis.site_code, vis.name, vis.region_id, vis.cluster_code_v AS cluster_code, vis.delivery_scenario::text AS delivery_scenario,
        vis.overall_status::text AS overall_status, vis.current_milestone AS current_milestone_col, vis.next_milestone AS next_milestone_col,
        vis.wf_version AS workflow_version, vis.workflow_version_id::text AS workflow_id, count(*) OVER () AS total
      FROM vis LEFT JOIN ss ON ss.site_id = vis.id
      ${post.length > 0 ? Prisma.sql`WHERE ${Prisma.join(post, ' AND ')}` : Prisma.empty}
      ORDER BY ${order}, vis.id
      LIMIT ${limit + 1} OFFSET ${offset}`);

    const page = rows.slice(0, limit);
    const items = await this.listItems(page, stream);
    return {
      items,
      page: {
        limit,
        next_cursor: rows.length > limit ? encodeCursor([String(offset + limit)]) : null,
        total: rows[0] ? Number(rows[0].total) : 0,
      },
    };
  }

  private customPairs(q: Record<string, unknown>): [string, string][] {
    const v = q.custom;
    if (v === undefined) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((x) => {
      const m = typeof x === 'string' ? /^([a-z0-9_]+):(.+)$/.exec(x) : null;
      if (!m) throw problems.validation([{ path: '/custom', code: 'invalid', message: 'custom is code:value.' }]);
      return [m[1] as string, m[2] as string];
    });
  }

  private async requireStream(code: string, workflowId?: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) throw problems.validation([{ path: '/stream', code: 'invalid', message: 'stream is a stream code such as CW.' }]);
    const rows = workflowId
      ? await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM workflow_streams WHERE code = ${code} AND workflow_id = ${workflowId}::uuid`)
      : await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM workflow_streams WHERE code = ${code}`);
    if (Number(rows[0]?.n ?? 0) === 0) throw problems.validation([{ path: '/stream', code: 'unknown_stream', message: `There is no stream ${code}.` }]);
  }

  /** Per-site items for a page (or one site): the stage rows of the site's whole workflow are read once, then rail and streams are built from them. */
  private async listItems(page: SiteRow[], stream: string | undefined): Promise<Record<string, unknown>[]> {
    if (page.length === 0) return [];
    const ids = page.map((p) => p.id);
    const stages = await this.db.tx.$queryRaw<StageRow[]>(Prisma.sql`
      SELECT s.id::text AS site_id, st.code, st.seq, st.stream_code, st.name_en, st.name_ar,
        a.total, a.done, a.late, a.waiting, a.started, a.has_ms, a.ms_done, a.ms_na, a.ms_date
      FROM sites s
      JOIN stage_definitions st ON st.workflow_id = s.workflow_version_id AND st.is_active
      ${STAGE_AGG}
      WHERE s.id = ANY(${ids}::uuid[]) ORDER BY s.id, st.seq`);
    const streams = await this.streamsOf([...new Set(page.map((p) => p.workflow_id))]);
    return page.map((site) => {
      const all = stages.filter((r) => r.site_id === site.id);
      const scope = stream ? all.filter((r) => r.stream_code === stream) : all;
      return this.siteItem(site, all, scope, streams.get(site.workflow_id) ?? []);
    });
  }

  private siteItem(site: SiteRow, all: StageRow[], scope: StageRow[], streams: StreamDto[]): Record<string, unknown> {
    const open = scope.filter((r) => !stageDone(r) && !stageNa(r));
    const current = open[0];
    const doneRows = scope.filter(stageDone);
    const lastDone = doneRows[doneRows.length - 1];
    const rail = scope.map((r) => ({
      code: r.code,
      state: stageDone(r) ? 'done' : stageNa(r) ? 'na' : r === current ? (Number(r.late) > 0 ? 'late' : 'current') : 'planned',
    }));
    return {
      id: site.id,
      site_code: site.site_code,
      name: site.name,
      region_id: site.region_id,
      cluster_code: site.cluster_code,
      ...(site.delivery_scenario ? { delivery_scenario: site.delivery_scenario } : {}),
      overall_status: site.overall_status,
      current_milestone: lastDone ? lastDone.code : (scope.length === all.length ? site.current_milestone_col : null),
      next_milestone: current ? current.code : null,
      workflow_version: site.workflow_version,
      late_task_count: scope.reduce((n, r) => n + Number(r.late), 0),
      waiting_approval_count: scope.reduce((n, r) => n + Number(r.waiting), 0),
      rail,
      streams: streams.map((s) => this.streamStatus(s, all.filter((r) => r.stream_code === s.code))),
    };
  }

  private streamStatus(s: StreamDto, rows: StageRow[]): StreamStatusDto {
    const live = rows.filter((r) => !stageNa(r));
    const open = live.filter((r) => !stageDone(r));
    const last = rows[rows.length - 1];
    const started = rows.some((r) => Number(r.started) > 0);
    const state: StreamStatusDto['state'] = live.length === 0 ? 'na' : open.length === 0 ? 'done' : started ? 'in_progress' : 'not_started';
    return {
      ...s,
      state,
      current_stage: open[0]?.code ?? null,
      done_tasks: rows.reduce((n, r) => n + Number(r.done), 0),
      total_tasks: rows.reduce((n, r) => n + Number(r.total), 0),
      late_count: rows.reduce((n, r) => n + Number(r.late), 0),
      milestone_date: last && last.ms_done ? last.ms_date : null,
    };
  }

  // ------------------------------------------------------------------ GET /sites/{id}
  private async siteRow(regions: number[] | null, id: string): Promise<(SiteRow & Record<string, unknown>) | undefined> {
    if (!uuidSchema.safeParse(id).success) return undefined;
    const rows = await this.db.tx.$queryRaw<(SiteRow & Record<string, unknown>)[]>(Prisma.sql`
      SELECT s.id::text AS id, s.site_code, s.name, s.region_id, c.cluster_code, s.cluster_id::text AS cluster_id, s.delivery_scenario::text AS delivery_scenario,
        s.overall_status::text AS overall_status, s.current_milestone AS current_milestone_col, s.next_milestone AS next_milestone_col,
        wd.version AS workflow_version, s.workflow_version_id::text AS workflow_id, s.owner_site_id, s.sub_region, s.latitude::float8 AS latitude,
        s.longitude::float8 AS longitude, s.address, s.site_type, s.project_phase, s.delivery_batch, s.cw_delivery_model,
        s.scope_tower_erection::text AS scope_tower_erection, s.scope_site_adaption::text AS scope_site_adaption, s.scope_gecol_power::text AS scope_gecol_power,
        s.scope_hlc_fiber::text AS scope_hlc_fiber, s.scope_te_full::text AS scope_te_full, s.scope_te_ip_router_only::text AS scope_te_ip_router_only,
        s.updated_at, s.custom, 1::bigint AS total
      FROM sites s JOIN workflow_definitions wd ON wd.id = s.workflow_version_id LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.id = ${id}::uuid ${regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`}`);
    return rows[0];
  }

  async get(auth: AuthContext, id: string): Promise<Record<string, unknown>> {
    const regions = await this.access.requireRegions('sites', 'view');
    const site = await this.siteRow(regions, id);
    if (!site) throw problems.notFound('The site does not exist or is not visible to you.');
    const [item] = await this.listItems([site], undefined);
    if (!item) throw problems.notFound();

    const nodes = await this.pipeline(site);
    const counts = await this.db.tx.$queryRaw<{ open_snags: bigint; open_issues: bigint; documents_missing: bigint }[]>(Prisma.sql`
      SELECT (SELECT count(*) FROM snags WHERE site_id = ${site.id}::uuid AND status IN ('open', 'fix_uploaded', 'in_review')) AS open_snags,
        (SELECT count(*) FROM issues WHERE site_id = ${site.id}::uuid AND status IN ('open', 'in_progress')) AS open_issues,
        (SELECT count(*) FROM document_slots ds JOIN document_types dt ON dt.id = ds.doc_type_id
           WHERE ds.site_id = ${site.id}::uuid AND ds.status = 'missing' AND dt.is_mandatory) AS documents_missing`);
    const cluster = site.cluster_id ? await this.clusterProgress(String(site.cluster_id), String(site.cluster_code)) : null;
    const flag = (v: unknown): string | null => (v === 'yes' || v === 'na' ? v : null);
    const custom = await this.visibleCustom(auth, site.custom);
    const detail: Record<string, unknown> = {
      ...item,
      owner_site_id: site.owner_site_id,
      sub_region: site.sub_region,
      latitude: site.latitude,
      longitude: site.longitude,
      address: site.address,
      site_type: site.site_type,
      project_phase: site.project_phase,
      delivery_batch: site.delivery_batch,
      cw_delivery_model: site.cw_delivery_model,
      scope_flags: {
        tower_erection: flag(site.scope_tower_erection),
        site_adaption: flag(site.scope_site_adaption),
        gecol_power: flag(site.scope_gecol_power),
        hlc_fiber: flag(site.scope_hlc_fiber),
        te_full: flag(site.scope_te_full),
        te_ip_router_only: flag(site.scope_te_ip_router_only),
      },
      cluster_progress: cluster,
      pipeline: nodes,
      counts: {
        open_snags: Number(counts[0]?.open_snags ?? 0),
        open_issues: Number(counts[0]?.open_issues ?? 0),
        documents_missing: Number(counts[0]?.documents_missing ?? 0),
      },
      version: contentVersion([String(site.updated_at)]),
    };
    if (Object.keys(custom).length > 0) detail.custom = custom;
    return detail;
  }

  /** Custom field values of the site that the caller may see (field-level rules: a hidden field is left out). */
  private async visibleCustom(auth: AuthContext, custom: unknown): Promise<Record<string, unknown>> {
    if (!custom || typeof custom !== 'object') return {};
    const values = custom as Record<string, unknown>;
    const codes = Object.keys(values);
    if (codes.length === 0) return {};
    const rows = await this.db.tx.$queryRaw<{ code: string; access: string | null }[]>(Prisma.sql`
      SELECT fd.code, app_resolve_field_access(${auth.user.id}::uuid, fd.id)::text AS access
      FROM field_definitions fd WHERE fd.entity_type = 'site' AND fd.is_active AND fd.code = ANY(${codes}::text[])`);
    const out: Record<string, unknown> = {};
    for (const r of rows) if (r.access !== 'hidden') out[r.code] = values[r.code];
    return out;
  }

  private async clusterProgress(clusterId: string, code: string): Promise<Record<string, unknown>> {
    const r = await this.db.tx.$queryRaw<{ total: bigint; at_pac: bigint; kpi: string | null }[]>(Prisma.sql`
      SELECT (SELECT count(*) FROM sites x WHERE x.cluster_id = ${clusterId}::uuid AND x.is_active) AS total,
        (SELECT count(DISTINCT x.id) FROM sites x
           JOIN stage_definitions st ON st.workflow_id = x.workflow_version_id AND st.code = ${TE_PAC_STAGE_CODE}
           JOIN task_definitions td ON td.stage_id = st.id AND td.is_milestone_task
           JOIN task_instances t ON t.site_id = x.id AND t.task_def_id = td.id AND t.state = 'approved'
         WHERE x.cluster_id = ${clusterId}::uuid AND x.is_active) AS at_pac,
        (SELECT kpi_acceptance_date::text FROM clusters WHERE id = ${clusterId}::uuid) AS kpi`);
    return { cluster_code: code, sites_total: Number(r[0]?.total ?? 0), sites_at_te_pac: Number(r[0]?.at_pac ?? 0), kpi_acceptance_date: r[0]?.kpi ?? null };
  }

  /** Milestones and the gates between them, in workflow order (gate Gn sits before milestone n). A gate's date is the previous milestone's date. */
  private async pipeline(site: SiteRow): Promise<Record<string, unknown>[]> {
    const stages = await this.db.tx.$queryRaw<StageRow[]>(Prisma.sql`
      SELECT s.id::text AS site_id, st.code, st.seq, st.stream_code, st.name_en, st.name_ar,
        a.total, a.done, a.late, a.waiting, a.started, a.has_ms, a.ms_done, a.ms_na, a.ms_date
      FROM sites s JOIN stage_definitions st ON st.workflow_id = s.workflow_version_id AND st.is_active
      ${STAGE_AGG}
      WHERE s.id = ${site.id}::uuid ORDER BY st.seq`);
    // gate_eval (migration 0017): the gate date (previous milestone date, later when a required permit starts later, shifted by Change Control) and why it is closed
    const gates = await this.db.tx.$queryRaw<{ link_code: string; seq: number; name_en: string; name_ar: string | null; from_code: string; to_code: string;
      gate_status: string; gate_date: string | null; shifted: boolean; reasons: unknown }[]>(Prisma.sql`
      SELECT r.link_code, r.seq, r.name_en, r.name_ar, r.from_code, r.to_code, ge.status AS gate_status, ge.gate_date::text AS gate_date, ge.shifted, ge.reasons
      FROM phase_gate_rules r CROSS JOIN LATERAL gate_eval(${site.id}::uuid, r.link_code) ge
      WHERE r.workflow_id = ${site.workflow_id}::uuid AND r.is_active ORDER BY r.seq`);
    const baselines = await this.db.tx.$queryRaw<{ milestone_code: string; baseline_date: string | null }[]>(Prisma.sql`
      SELECT DISTINCT ON (be.milestone_code) be.milestone_code, be.baseline_date::text AS baseline_date
      FROM baseline_entries be JOIN baseline_versions bv ON bv.id = be.version_id AND bv.status = 'approved'
      WHERE be.site_id = ${site.id}::uuid ORDER BY be.milestone_code, bv.version DESC`);
    // variance in working days: actual minus baseline (negative = early)
    const pairs = stages.flatMap((r) => {
      const b = baselines.find((x) => x.milestone_code === r.code)?.baseline_date;
      return r.ms_done && r.ms_date && b ? [{ code: r.code, b, a: r.ms_date }] : [];
    });
    const variance = new Map<string, number>();
    if (pairs.length > 0) {
      const v = await this.db.tx.$queryRaw<{ code: string; wd: number | null }[]>(Prisma.sql`
        SELECT u.c AS code, cal_workdays_between(u.b::date, u.a::date) AS wd
        FROM unnest(${pairs.map((p) => p.code)}::text[], ${pairs.map((p) => p.b)}::text[], ${pairs.map((p) => p.a)}::text[]) AS u(c, b, a)`);
      for (const x of v) if (x.wd !== null) variance.set(x.code, Number(x.wd));
    }
    const byCode = new Map(stages.map((s) => [s.code, s]));
    const current = stages.find((r) => !stageDone(r) && !stageNa(r));
    const nodes: Record<string, unknown>[] = [];
    const milestone = (r: StageRow): Record<string, unknown> => ({
      code: r.code,
      kind: 'milestone',
      name_en: r.name_en,
      name_ar: r.name_ar,
      state: stageDone(r) ? 'done' : stageNa(r) ? 'na' : r === current ? (Number(r.late) > 0 ? 'late' : 'current') : 'planned',
      progress: stageDone(r) ? 1 : Number(r.total) > 0 ? Math.min(1, Number(r.done) / Number(r.total)) : 0,
      actual_date: r.ms_done ? r.ms_date : null,
      baseline_date: baselines.find((b) => b.milestone_code === r.code)?.baseline_date ?? null,
      planned_date: null,
      variance_wd: variance.get(r.code) ?? null,
      lock_reasons: [],
      shifted_by_suspension: false,
    });
    const gate = (g: (typeof gates)[number]): Record<string, unknown> => {
      const from = byCode.get(g.from_code);
      const to = byCode.get(g.to_code);
      const fromOk = !from || stageDone(from) || stageNa(from);
      const open = g.gate_status === 'open';
      const state = to && stageDone(to) ? 'done' : to && stageNa(to) && fromOk ? 'na' : fromOk && (open || g.gate_status === 'na') ? 'current' : 'locked';
      return {
        code: g.link_code,
        kind: 'gate',
        name_en: g.name_en,
        name_ar: g.name_ar,
        state,
        progress: state === 'done' ? 1 : 0,
        actual_date: g.gate_date ?? (from && from.ms_done ? from.ms_date : null),
        baseline_date: null,
        planned_date: null,
        variance_wd: null,
        lock_reasons: fromOk && !open && g.gate_status !== 'na' && Array.isArray(g.reasons) ? g.reasons : [],
        shifted_by_suspension: g.shifted === true,
      };
    };
    for (const st of stages) {
      for (const g of gates.filter((x) => x.to_code === st.code)) nodes.push(gate(g));
      nodes.push(milestone(st));
    }
    return nodes;
  }

  // ------------------------------------------------------------------ GET /sites/{id}/tasks
  async tasks(auth: AuthContext, id: string, q: Record<string, unknown>): Promise<unknown> {
    const regions = await this.access.requireRegions('sites', 'view');
    const site = await this.siteRow(regions, id);
    if (!site) throw problems.notFound('The site does not exist or is not visible to you.');
    const stream = oneParam(q, 'stream');
    if (stream !== undefined) await this.requireStream(stream, site.workflow_id);
    void auth;
    const stages = await this.db.tx.$queryRaw<{ id: string; code: string; stream_code: string | null; name_en: string; name_ar: string | null }[]>(Prisma.sql`
      SELECT id::text AS id, code, stream_code, name_en, name_ar FROM stage_definitions
      WHERE workflow_id = ${site.workflow_id}::uuid AND is_active ${stream ? Prisma.sql`AND stream_code = ${stream}` : Prisma.empty} ORDER BY seq`);
    const rows = await this.view.rows(taskSelect(
      Prisma.sql`t.site_id = ${site.id}::uuid ${stream ? Prisma.sql`AND st.stream_code = ${stream}` : Prisma.empty}`,
      Prisma.sql`ORDER BY st.seq, td.sort_order, td.code`,
    ));
    const summaries = await this.view.withLockReasons(rows);
    const byStage = new Map<string, TaskSummaryDto[]>();
    for (const t of summaries) {
      const list = byStage.get(t.stage_code) ?? [];
      list.push(t);
      byStage.set(t.stage_code, list);
    }
    const streams = (await this.streamsOf([site.workflow_id])).get(site.workflow_id) ?? [];
    return {
      workflow_version: site.workflow_version,
      streams,
      stages: stages.map((st) => ({ code: st.code, stream_code: st.stream_code, name_en: st.name_en, name_ar: st.name_ar, tasks: byStage.get(st.code) ?? [] })),
    };
  }
}
