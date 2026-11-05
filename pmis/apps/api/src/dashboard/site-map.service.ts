import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import { ProblemException } from '../common/problem';
import { DbService } from '../db/db.service';

/** The stable code of the On-Air milestone (default workflow, ADR 0010): a site that has reached it shows a steady green light on the map. */
export const ON_AIR_CODE = 'MS6';
/** Valid coordinates of a site on the map (OV-12, docs/spec/dashboard-kpis.md): inside these bounds, exclusive. */
export const MAP_BOUNDS = { latMin: 18, latMax: 34.5, lonMin: 8, lonMax: 26 } as const;

/** SQL test of valid coordinates on the columns of `sites` aliased `s` (the same rule as the map and `GET /sites?coordinates=`). */
export const HAS_COORDINATES = Prisma.sql`(s.latitude > ${MAP_BOUNDS.latMin} AND s.latitude < ${MAP_BOUNDS.latMax} AND s.longitude > ${MAP_BOUNDS.lonMin} AND s.longitude < ${MAP_BOUNDS.lonMax})`;

interface Row {
  id: string;
  site_code: string;
  name: string;
  name_ar: string | null;
  region_id: number;
  sub_region: string | null;
  cluster_code: string | null;
  latitude: number | null;
  longitude: number | null;
  has_coordinates: boolean;
  overall_status: string;
  delivery_scenario: string | null;
  tower_owner: string | null;
  stream_code: string | null;
  milestone_code: string | null;
  last_milestone_code: string | null;
  on_air_reached: boolean;
  late_task_count: number;
  behind_baseline: boolean;
  total: number;
  done: number;
  workflow_id: string;
}

/** A row without one of its keys (the workflow id is internal: it only picks the names of the streams and milestones). */
const withoutKey = <T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k)) as Omit<T, K>;

interface Group { code: string; name_en: string; name_ar: string | null; sort_order: number; stream_code?: string | null }

/**
 * GET /dashboard/site-map (contract 0.14.5; OV-12 and SC-10 of docs/spec/dashboard-kpis.md; technical decision "site map" of 2026-11-05).
 * One compact row per active site the caller may see. Plain reads through the app role, as GET /sites: the API limits the regions (B3: the regions of
 * `dashboard.view` that are also regions of `sites.view`) and the row-level filter of the database applies underneath. No SECURITY DEFINER path.
 * The current milestone follows the rule of the Site Register list (sites.service stageAgg): a stage is reached when its milestone task is approved
 * (or, without a milestone task, every counting task is approved) and N/A when its milestone task is N/A (or it has no counting task).
 */
@Injectable()
export class SiteMapService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** The regions of the map: dashboard.view ∩ sites.view (null = every region). 403 module_forbidden without either. */
  async scope(): Promise<number[] | null> {
    const dash = await this.access.requireRegions('dashboard', 'view');
    const sites = await this.access.regions('sites', 'view');
    if (sites !== null && sites.length === 0) throw new ProblemException(403, 'module_forbidden', { detail: 'The site map needs the view right on the Site Register (sites).' });
    if (dash === null) return sites;
    if (sites === null) return dash;
    return dash.filter((r) => sites.includes(r)).sort((a, b) => a - b);
  }

  async get(): Promise<Record<string, unknown>> {
    const regions = await this.scope();
    const where = regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`;
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      WITH d AS (SELECT cal_today() AS today),
      vis AS (
        SELECT s.id, s.site_code, s.name, s.name_ar, s.region_id, s.sub_region, c.cluster_code, s.latitude::float8 AS latitude, s.longitude::float8 AS longitude,
          coalesce(${HAS_COORDINATES}, false) AS has_coordinates, s.overall_status::text AS overall_status, s.delivery_scenario::text AS delivery_scenario,
          s.tower_owner, s.workflow_version_id
        FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id
        WHERE s.is_active ${where}
      ), agg AS (
        SELECT t.site_id, td.stage_id,
          count(*) FILTER (WHERE td.counts_toward_milestone AND NOT t.is_na AND t.state NOT IN ('na', 'skipped')) AS total,
          count(*) FILTER (WHERE td.counts_toward_milestone AND t.state = 'approved') AS done,
          count(*) FILTER (WHERE t.state NOT IN ('approved', 'na', 'skipped', 'locked') AND t.due_date < (SELECT today FROM d)) AS late,
          coalesce(bool_or(td.is_milestone_task), false) AS has_ms,
          coalesce(bool_or(td.is_milestone_task AND t.state = 'approved'), false) AS ms_done,
          coalesce(bool_or(td.is_milestone_task AND (t.state IN ('na', 'skipped') OR t.is_na)), false) AS ms_na
        FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id
        WHERE t.site_id IN (SELECT id FROM vis)
        GROUP BY t.site_id, td.stage_id
      ), st AS (
        SELECT v.id AS site_id, sd.code, sd.seq, sd.stream_code, coalesce(a.total, 0) AS total, coalesce(a.done, 0) AS done, coalesce(a.late, 0) AS late,
          (coalesce(a.ms_done, false) OR (NOT coalesce(a.has_ms, false) AND coalesce(a.total, 0) > 0 AND a.done >= a.total)) AS is_done,
          ((coalesce(a.has_ms, false) AND a.ms_na AND NOT a.ms_done) OR (NOT coalesce(a.has_ms, false) AND coalesce(a.total, 0) = 0)) AS is_na
        FROM vis v JOIN stage_definitions sd ON sd.workflow_id = v.workflow_version_id AND sd.is_active
        LEFT JOIN agg a ON a.site_id = v.id AND a.stage_id = sd.id
      ), bl AS (
        SELECT DISTINCT ON (be.site_id, be.milestone_code) be.site_id, be.milestone_code, be.baseline_date
        FROM baseline_entries be JOIN baseline_versions bv ON bv.id = be.version_id AND bv.status = 'approved'
        WHERE be.site_id IN (SELECT id FROM vis)
        ORDER BY be.site_id, be.milestone_code, bv.version DESC
      ), per AS (
        SELECT st.site_id,
          (array_agg(st.code ORDER BY st.seq) FILTER (WHERE NOT st.is_done AND NOT st.is_na))[1] AS milestone_code,
          (array_agg(st.stream_code ORDER BY st.seq) FILTER (WHERE NOT st.is_done AND NOT st.is_na))[1] AS stream_code,
          (array_agg(st.code ORDER BY st.seq DESC) FILTER (WHERE st.is_done))[1] AS last_milestone_code,
          coalesce(bool_or(st.code = ${ON_AIR_CODE} AND st.is_done), false) AS on_air_reached,
          sum(st.late)::int AS late_task_count, sum(st.total)::int AS total, sum(st.done)::int AS done,
          coalesce(bool_or(NOT st.is_done AND NOT st.is_na AND bl.baseline_date < (SELECT today FROM d)), false) AS behind_baseline
        FROM st LEFT JOIN bl ON bl.site_id = st.site_id AND bl.milestone_code = st.code
        GROUP BY st.site_id
      )
      SELECT vis.id::text AS id, vis.site_code, vis.name, vis.name_ar, vis.region_id, vis.sub_region, vis.cluster_code, vis.latitude, vis.longitude, vis.has_coordinates,
        vis.overall_status, vis.delivery_scenario, vis.tower_owner, per.stream_code, per.milestone_code, per.last_milestone_code,
        coalesce(per.on_air_reached, false) AS on_air_reached, coalesce(per.late_task_count, 0) AS late_task_count, coalesce(per.behind_baseline, false) AS behind_baseline,
        coalesce(per.total, 0) AS total, coalesce(per.done, 0) AS done, vis.workflow_version_id::text AS workflow_id
      FROM vis LEFT JOIN per ON per.site_id = vis.id
      ORDER BY vis.site_code, vis.id`);

    const workflowIds = [...new Set(rows.map((r) => r.workflow_id))];
    // The names of the streams and milestones of the versions in use (the latest published version when the caller sees no site), one per stable code, newest version first.
    const wf = Prisma.sql`(SELECT unnest(${workflowIds}::uuid[]) UNION SELECT id FROM (SELECT id FROM workflow_definitions WHERE status = 'published' ORDER BY version DESC LIMIT 1) l)`;
    const streams = await this.db.tx.$queryRaw<Group[]>(Prisma.sql`
      SELECT code, name_en, name_ar, sort_order FROM (
        SELECT DISTINCT ON (ws.code) ws.code, ws.name_en, ws.name_ar, ws.sort_order FROM workflow_streams ws JOIN workflow_definitions wd ON wd.id = ws.workflow_id
        WHERE ws.workflow_id IN ${wf} ORDER BY ws.code, wd.version DESC) x ORDER BY sort_order, code`);
    const milestones = await this.db.tx.$queryRaw<Group[]>(Prisma.sql`
      SELECT code, name_en, name_ar, seq AS sort_order, stream_code FROM (
        SELECT DISTINCT ON (sd.code) sd.code, sd.name_en, sd.name_ar, sd.seq, sd.stream_code FROM stage_definitions sd JOIN workflow_definitions wd ON wd.id = sd.workflow_id
        WHERE sd.workflow_id IN ${wf} AND sd.is_active ORDER BY sd.code, wd.version DESC) x ORDER BY seq, code`);

    const live = rows.filter((r) => r.overall_status !== 'cancelled');
    return {
      as_of: new Date().toISOString(),
      scope_regions: regions,
      counts: {
        total: rows.length,
        cancelled: rows.length - live.length,
        with_coordinates: live.filter((r) => r.has_coordinates).length,
        without_coordinates: live.filter((r) => !r.has_coordinates).length,
      },
      streams,
      milestones,
      items: rows.map(({ total, done, ...r }) => ({
        ...withoutKey(r, 'workflow_id'),
        late_task_count: Number(r.late_task_count),
        late: Number(r.late_task_count) > 0 || r.behind_baseline,
        task_progress_pct: Number(total) > 0 ? Math.round((Number(done) * 1000) / Number(total)) / 10 : null,
      })),
    };
  }
}
