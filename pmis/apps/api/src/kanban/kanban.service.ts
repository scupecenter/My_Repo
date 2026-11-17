import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { likePattern } from '../common/cursor';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { boolParam, oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { SitesService } from '../sites/sites.service';
import { FilterCatalogService } from '../views/filter-catalog.service';
import { TaskSummaryDto, TaskViewService, taskSelect } from '../workflow/task-view.service';

/**
 * F5 (contract 0.15.32, migration 0118): the two boards of the features build plan of 2026-11-14. Both are read only: nothing here writes,
 * and there is no board endpoint that changes a state, a holder or a date ("Explicitly refused": no automation, no drag that changes data).
 *
 * Sites board (GET /boards/sites): one column per milestone (the stable stage code, ADR 0010) plus "closed". A site sits in the first
 * milestone of its own workflow version that is neither done nor N/A, the same rule as the current stage of GET /sites; it is "closed" when
 * its overall status is completed or every stage with work is done. A site with no task yet sits in the first milestone. Ageing = working
 * days (cal_workdays_between, the default calendar: weekend plus holidays) from the day the site entered the column to today; that day is
 * the latest milestone date (actual date, then the approval of F1, then the approved date) of the milestones before the column, else the
 * day the site was created (open question Q570). Swimlanes: none, region, or contractor (the external party of the site's tasks in its
 * column, open first, else the latest one; Q571). WIP limits are a setting per column (kanban.wip_limits, default none) and only mark the
 * column (Q572). The caller's regions (B3) and row security apply; the filters are those of GET /sites, the F3 tree included.
 *
 * Tasks board (GET /boards/tasks): the tasks the caller may see (Sites view right, B3) in four columns by approval state: entry (open or
 * at L1), review (at L2: in review or in approval), rejected (sent back to L1 by a rejection and not yet resubmitted) and approved. The
 * client turns a drop into the opening of the task's existing action, which the task endpoints check again (allowed_actions of
 * GET /tasks/{id}); the board itself only reads.
 */

export const SITE_SWIMLANES = ['none', 'region', 'contractor'] as const;
export type SiteSwimlane = (typeof SITE_SWIMLANES)[number];
export const CLOSED_COLUMN = 'closed';
export const TASK_COLUMNS = ['entry', 'review', 'rejected', 'approved'] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

const wipSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  limits: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,30}$/), z.number().int().min(1).max(10000).nullable()).refine((v) => Object.keys(v).length <= 100, 'At most 100 columns.'),
}).strict();

interface WipJson {
  limits: Record<string, number>;
  min: number;
  max: number;
  updated_at: string | null;
  updated_by: string | null;
  version: number;
  can_edit: boolean;
}

export interface SiteCardDto {
  id: string;
  site_code: string;
  name: string;
  name_ar: string | null;
  region_id: number;
  overall_status: string;
  delivery_scenario: string | null;
  contractor: { id: string; name: string } | null;
  entered_on: string;
  ageing_wd: number;
  /** F2: the worst SLA colour of the open tasks of the site in its column; null when none is measured. */
  sla_colour: 'green' | 'amber' | 'red' | null;
  /** F2: where the ball is in the column: open tasks at L1 and at L2. */
  at_l1: number;
  at_l2: number;
  late_count: number;
}

interface PlacedRow {
  id: string; site_code: string; name: string; name_ar: string | null; region_id: number; overall_status: string; delivery_scenario: string | null;
  closed: boolean; col: string; lane: string; entered_on: string; n_cell: bigint; contractor_id: string | null; contractor_name: string | null;
}

/** Bounded integer query value with a default. */
function intParam(q: Record<string, unknown>, key: string, min: number, max: number, def: number): number {
  const v = oneParam(q, key);
  if (v === undefined || v === '') return def;
  const n = /^[0-9]{1,6}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is an integer from ${min} to ${max}.` }]);
  return n;
}

@Injectable()
export class KanbanService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly sites: SitesService,
    private readonly filters: FilterCatalogService,
    private readonly view: TaskViewService,
  ) {}

  // ------------------------------------------------------------------------------------------------------------ WIP setting
  private async wipDto(j: WipJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    const cols = await this.columns();
    return { limits: j.limits, columns: cols.map((c) => ({ code: c.code, name_en: c.name_en, name_ar: c.name_ar })), min: j.min, max: j.max, updated_at: j.updated_at, updated_by, version: j.version, can_edit: j.can_edit };
  }

  private async wipJson(): Promise<WipJson> {
    const r = await this.db.tx.$queryRaw<{ j: WipJson }[]>(Prisma.sql`SELECT kanban_wip_json() AS j`);
    return r[0]!.j;
  }

  /** GET /settings/kanban-wip */
  async getWip() {
    return this.wipDto(await this.wipJson());
  }

  /** PUT /settings/kanban-wip: a System Admin or an all-regions settings delegate, a reason and If-Match; audited by the database. */
  async putWip(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(wipSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: WipJson }[]>(Prisma.sql`SELECT admin_set_kanban_wip_limits(${JSON.stringify(b.limits)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.wipDto(r[0]!.j);
  }

  /** The milestone columns: the active stages of the workflow versions in use (by stable code; the newest version names it), in order. */
  private async columns(): Promise<{ code: string; name_en: string; name_ar: string | null; seq: number }[]> {
    const rows = await this.db.tx.$queryRaw<{ code: string; name_en: string; name_ar: string | null; seq: number }[]>(Prisma.sql`
      SELECT x.code, x.name_en, x.name_ar, x.seq FROM (
        SELECT DISTINCT ON (st.code) st.code, st.name_en, st.name_ar, st.seq
        FROM stage_definitions st JOIN workflow_definitions w ON w.id = st.workflow_id
        WHERE st.is_active AND (w.id IN (SELECT DISTINCT si.workflow_version_id FROM sites si WHERE si.is_active)
                                OR w.version = (SELECT max(w2.version) FROM workflow_definitions w2 WHERE w2.status::text = 'published'))
        ORDER BY st.code, w.version DESC) x
      ORDER BY x.seq, x.code`);
    return rows;
  }

  // ------------------------------------------------------------------------------------------------------------ sites board
  async sitesBoard(auth: AuthContext, q: Record<string, unknown>): Promise<Record<string, unknown>> {
    const regions = await this.access.requireRegions('sites', 'view');
    const swim = (oneParam(q, 'swimlane') ?? 'none') as SiteSwimlane;
    if (!SITE_SWIMLANES.includes(swim)) throw problems.validation([{ path: '/swimlane', code: 'invalid', message: 'swimlane is none, region or contractor.' }]);
    const limit = intParam(q, 'card_limit', 1, 100, 20);
    const includeCancelled = boolParam(q, 'include_cancelled') ?? false;
    const where = await this.sites.baseWhere(auth, q, regions);
    if (!includeCancelled && oneParam(q, 'overall_status') !== 'cancelled') where.push(Prisma.sql`s.overall_status <> 'cancelled'`);

    const lane = swim === 'region' ? Prisma.sql`p.region_id::text` : swim === 'contractor' ? Prisma.sql`coalesce(p.contractor_id, 'none')` : Prisma.sql`'all'`;
    // One pass, aggregated in SQL (about 1000 sites, no join between two derived sets so the planner never loops over them): the per-stage
    // state of every site from one GROUP BY over its tasks (the rule of the current stage of GET /sites), the current stage by a window over
    // the stages of the site, then one row per site with its column and the day it entered it, the contractor, the count of each cell and
    // its first `limit` cards (oldest in the column first).
    const rows = await this.db.tx.$queryRaw<PlacedRow[]>(Prisma.sql`
      WITH vis AS MATERIALIZED (
        SELECT s.id, s.site_code, s.name, s.name_ar, s.region_id, s.overall_status::text AS overall_status, s.delivery_scenario::text AS delivery_scenario,
          s.workflow_version_id, s.created_at
        FROM sites s JOIN workflow_definitions wd ON wd.id = s.workflow_version_id LEFT JOIN clusters c ON c.id = s.cluster_id
        WHERE ${Prisma.join(where, ' AND ')}
      ), agg AS (
        SELECT t.site_id, td.stage_id,
          count(*) FILTER (WHERE td.counts_toward_milestone AND NOT t.is_na AND t.state NOT IN ('na', 'skipped')) AS total,
          count(*) FILTER (WHERE td.counts_toward_milestone AND t.state = 'approved') AS done,
          coalesce(bool_or(td.is_milestone_task), false) AS has_ms,
          coalesce(bool_or(td.is_milestone_task AND t.state = 'approved'), false) AS ms_done,
          coalesce(bool_or(td.is_milestone_task AND (t.state IN ('na', 'skipped') OR t.is_na)), false) AS ms_na,
          -- the milestone date (Q570): its actual date, else the approval of F1, else its approved date
          max(coalesce(t.actual_date,
                       (SELECT cal_local_date(max(tr.at)) FROM status_transitions tr WHERE tr.entity_type = 'task' AND tr.entity_id = t.id AND tr.to_state = 'approved'),
                       t.approved_date)) FILTER (WHERE td.is_milestone_task AND t.state = 'approved') AS ms_date
        FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id
        WHERE t.site_id IN (SELECT id FROM vis)
        GROUP BY t.site_id, td.stage_id
      ), flags AS (
        SELECT v.*, st.code, st.seq, a.ms_date,
          coalesce(a.ms_done OR (NOT a.has_ms AND a.total > 0 AND a.done >= a.total), false) AS is_done,
          (a.site_id IS NULL OR (a.has_ms AND a.ms_na AND NOT a.ms_done) OR (NOT a.has_ms AND a.total = 0)) AS is_na
        FROM vis v JOIN stage_definitions st ON st.workflow_id = v.workflow_version_id AND st.is_active
        LEFT JOIN agg a ON a.site_id = v.id AND a.stage_id = st.id
      ), fw AS (
        SELECT f.*, min(f.seq) FILTER (WHERE NOT f.is_done AND NOT f.is_na) OVER (PARTITION BY f.id) AS cur_seq FROM flags f
      ), ss AS (
        SELECT id, site_code, name, name_ar, region_id, overall_status, delivery_scenario, created_at,
          (array_agg(code ORDER BY seq) FILTER (WHERE NOT is_done AND NOT is_na))[1] AS cur_stage, (array_agg(code ORDER BY seq))[1] AS first_stage,
          bool_and(is_done OR is_na) AS all_done, bool_or(NOT is_na) AS has_work,
          max(ms_date) FILTER (WHERE seq < cur_seq) AS ms_before, max(ms_date) AS ms_all
        FROM fw GROUP BY id, site_code, name, name_ar, region_id, overall_status, delivery_scenario, created_at
      ), placed AS (
        SELECT ss.*, x.closed,
          CASE WHEN x.closed THEN ${CLOSED_COLUMN} ELSE coalesce(ss.cur_stage, ss.first_stage, ${CLOSED_COLUMN}) END AS col,
          -- the day the site entered its column: the latest milestone date before it (all of them for "closed"), else the day it was created
          coalesce(CASE WHEN x.closed THEN ss.ms_all ELSE ss.ms_before END, cal_local_date(ss.created_at)) AS entered_on
        FROM ss CROSS JOIN LATERAL (SELECT (ss.overall_status = 'completed' OR (coalesce(ss.all_done, false) AND coalesce(ss.has_work, false))) AS closed) x
      ), p AS (
        SELECT pl.*, py.contractor_id, py.contractor_name
        FROM placed pl
        LEFT JOIN LATERAL (
          -- the contractor (Q571): the external party of the site's tasks in its column, open ones first, else of its latest task with one
          SELECT ep.id::text AS contractor_id, ep.name AS contractor_name
          FROM task_instances ct
          JOIN task_definitions ctd ON ctd.id = ct.task_def_id JOIN stage_definitions cst ON cst.id = ctd.stage_id
          JOIN external_parties ep ON ep.id = ct.external_party_id
          WHERE ct.site_id = pl.id AND ct.external_party_id IS NOT NULL
          ORDER BY (cst.code = pl.col) DESC, (ct.state IN ('open', 'entry', 'in_review', 'in_approval')) DESC, cst.seq DESC, ct.updated_at DESC
          LIMIT 1
        ) py ON true
      ), cells AS (
        SELECT p.*, ${lane} AS lane,
          count(*) OVER (PARTITION BY p.col, ${lane}) AS n_cell,
          row_number() OVER (PARTITION BY p.col, ${lane} ORDER BY p.entered_on, p.site_code, p.id) AS rn
        FROM p
      )
      SELECT id::text AS id, site_code, name, name_ar, region_id, overall_status, delivery_scenario, closed, col, lane, entered_on::text AS entered_on, n_cell,
        contractor_id, contractor_name
      FROM cells WHERE rn <= ${limit}`);

    // cell counts (every placed site counts, the cards are the first `limit` of each cell, oldest in the column first)
    const cellCount = new Map<string, number>();
    for (const r of rows) cellCount.set(`${r.col}\u0000${r.lane}`, Number(r.n_cell));
    const cards = await this.siteCards(rows);
    const byId = new Map(cards.map((c) => [c.id, c]));

    const cols = await this.columns();
    const wip = (await this.wipJson()).limits ?? {};
    const colCount = new Map<string, number>();
    for (const [k, n] of cellCount) { const c = k.split('\u0000')[0]!; colCount.set(c, (colCount.get(c) ?? 0) + n); }
    const known = new Set(cols.map((c) => c.code));
    const columns = [
      ...cols.map((c) => {
        const count = colCount.get(c.code) ?? 0;
        const lim = typeof wip[c.code] === 'number' ? wip[c.code]! : null;
        return { key: c.code, kind: 'milestone' as const, name_en: c.name_en, name_ar: c.name_ar, count, wip_limit: lim, over_wip: lim !== null && count > lim };
      }),
      // a stage code only an older version still has, with sites in it
      ...[...colCount.keys()].filter((k) => k !== CLOSED_COLUMN && !known.has(k)).map((k) => ({ key: k, kind: 'milestone' as const, name_en: k, name_ar: null, count: colCount.get(k) ?? 0, wip_limit: null, over_wip: false })),
      { key: CLOSED_COLUMN, kind: 'closed' as const, name_en: 'Closed', name_ar: 'مغلق', count: colCount.get(CLOSED_COLUMN) ?? 0, wip_limit: null, over_wip: false },
    ];

    const laneKeys = [...new Set(rows.map((r) => r.lane))];
    const laneCount = new Map<string, number>();
    for (const [k, n] of cellCount) { const l = k.split('\u0000')[1]!; laneCount.set(l, (laneCount.get(l) ?? 0) + n); }
    let lanes: { key: string; label_en: string; label_ar: string | null; count: number }[];
    if (swim === 'region') {
      const rg = await this.db.tx.$queryRaw<{ id: number; name_en: string; name_ar: string | null }[]>(Prisma.sql`SELECT id, name_en, name_ar FROM regions ORDER BY id`);
      lanes = rg.filter((r) => laneCount.has(String(r.id))).map((r) => ({ key: String(r.id), label_en: r.name_en, label_ar: r.name_ar, count: laneCount.get(String(r.id)) ?? 0 }));
    } else if (swim === 'contractor') {
      const names = new Map(rows.filter((r) => r.contractor_id).map((r) => [r.contractor_id!, r.contractor_name ?? '']));
      lanes = laneKeys.filter((k) => k !== 'none').sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? ''))
        .map((k) => ({ key: k, label_en: names.get(k) ?? k, label_ar: null, count: laneCount.get(k) ?? 0 }));
      if (laneCount.has('none')) lanes.push({ key: 'none', label_en: 'No contractor', label_ar: 'دون مقاول', count: laneCount.get('none') ?? 0 });
    } else {
      lanes = [{ key: 'all', label_en: 'All sites', label_ar: 'كل المواقع', count: laneCount.get('all') ?? 0 }];
    }

    const cells: { column: string; lane: string; count: number; more: boolean; cards: SiteCardDto[] }[] = [];
    for (const c of columns) {
      for (const l of lanes) {
        const n = cellCount.get(`${c.key}\u0000${l.key}`) ?? 0;
        if (n === 0) continue;
        const list = rows.filter((r) => r.col === c.key && r.lane === l.key).map((r) => byId.get(r.id)).filter((x): x is SiteCardDto => !!x);
        cells.push({ column: c.key, lane: l.key, count: n, more: n > list.length, cards: list.sort((a, b) => b.ageing_wd - a.ageing_wd || a.site_code.localeCompare(b.site_code)) });
      }
    }
    const total = [...cellCount.values()].reduce((a, b) => a + b, 0);
    return { swimlane: swim, card_limit: limit, total, columns, lanes, cells };
  }

  /**
   * The cards of the placed sites shown: the ageing in working days (cal_workdays_between once per distinct day, the default calendar) and
   * the F2 timing of the open tasks of each site in its column (the worst SLA colour, the ball at L1 and at L2), in one aggregated query.
   */
  private async siteCards(rows: PlacedRow[]): Promise<SiteCardDto[]> {
    if (!rows.length) return [];
    const days = [...new Set(rows.map((r) => r.entered_on))];
    const age = await this.db.tx.$queryRaw<{ d: string; n: number }[]>(Prisma.sql`
      SELECT x.d::text AS d, cal_workdays_between(x.d, cal_today()) AS n FROM unnest(${days}::date[]) AS x(d)`);
    const ageOf = new Map(age.map((a) => [a.d, Math.max(0, Number(a.n ?? 0))]));
    const open = rows.filter((r) => !r.closed);
    const timing = open.length ? await this.db.tx.$queryRaw<{ id: string; worst: number | null; at_l1: bigint; at_l2: bigint; late: bigint }[]>(Prisma.sql`
      WITH cur AS (SELECT * FROM unnest(${open.map((r) => r.id)}::uuid[], ${open.map((r) => r.col)}::text[]) AS c(site_id, col)),
      ot AS (
        SELECT c.site_id, ot.state::text AS state, ot.sla_start_date, r.calendar_id, r.min_working_days, r.max_working_days, (r.id IS NOT NULL) AS has_rule
        FROM cur c
        JOIN task_instances ot ON ot.site_id = c.site_id AND ot.state IN ('open', 'entry', 'in_review', 'in_approval')
        JOIN task_definitions otd ON otd.id = ot.task_def_id JOIN stage_definitions ost ON ost.id = otd.stage_id AND ost.code = c.col
        LEFT JOIN sla_rules r ON r.id = ot.sla_rule_id
      ), el AS (
        -- the elapsed working days once per (start day, calendar)
        SELECT k.sla_start_date, k.calendar_id, cal_workdays_between(k.sla_start_date, cal_today(), k.calendar_id) AS n
        FROM (SELECT DISTINCT sla_start_date, calendar_id FROM ot WHERE has_rule AND sla_start_date IS NOT NULL) k
      ), x AS (
        SELECT ot.site_id, ot.state,
          CASE WHEN el.n IS NULL THEN NULL ELSE sla_colour(el.n, ot.min_working_days, ot.max_working_days) END AS colour
        FROM ot LEFT JOIN el ON ot.has_rule AND el.sla_start_date = ot.sla_start_date AND el.calendar_id IS NOT DISTINCT FROM ot.calendar_id
      )
      SELECT site_id::text AS id, max(CASE colour WHEN 'red' THEN 3 WHEN 'amber' THEN 2 WHEN 'green' THEN 1 END) AS worst,
        count(*) FILTER (WHERE state IN ('open', 'entry')) AS at_l1, count(*) FILTER (WHERE state IN ('in_review', 'in_approval')) AS at_l2,
        count(*) FILTER (WHERE colour = 'red') AS late
      FROM x GROUP BY site_id`) : [];
    const tm = new Map(timing.map((x) => [x.id, x]));
    return rows.map((r) => {
      const x = tm.get(r.id);
      return {
        id: r.id,
        site_code: r.site_code,
        name: r.name,
        name_ar: r.name_ar,
        region_id: r.region_id,
        overall_status: r.overall_status,
        delivery_scenario: r.delivery_scenario,
        contractor: r.contractor_id ? { id: r.contractor_id, name: r.contractor_name ?? '' } : null,
        entered_on: r.entered_on,
        ageing_wd: ageOf.get(r.entered_on) ?? 0,
        sla_colour: x?.worst === 3 ? 'red' : x?.worst === 2 ? 'amber' : x?.worst === 1 ? 'green' : null,
        at_l1: Number(x?.at_l1 ?? 0),
        at_l2: Number(x?.at_l2 ?? 0),
        late_count: Number(x?.late ?? 0),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------ tasks board
  async tasksBoard(auth: AuthContext, q: Record<string, unknown>): Promise<Record<string, unknown>> {
    const regions = await this.access.requireRegions('sites', 'view');
    const limit = intParam(q, 'card_limit', 1, 100, 30);
    const me = auth.user.id;
    const siteId = oneParam(q, 'site_id');
    if (siteId !== undefined && !uuidSchema.safeParse(siteId).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'site_id is a UUID.' }]);
    const stage = oneParam(q, 'stage_code');
    if (stage !== undefined && !/^[A-Z][A-Z0-9_]{0,30}$/.test(stage)) throw problems.validation([{ path: '/stage_code', code: 'invalid', message: 'Unknown stage code.' }]);
    const text = oneParam(q, 'q')?.trim();
    const mine = boolParam(q, 'mine') ?? false;
    const regionIds = (Array.isArray(q.region_id) ? q.region_id : q.region_id === undefined ? [] : [q.region_id]).map((x) => {
      const n = typeof x === 'string' && /^[0-9]{1,3}$/.test(x) ? Number(x) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 7) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is an integer from 1 to 7.' }]);
      return n;
    });

    const conds: Prisma.Sql[] = [Prisma.sql`s.is_active`, Prisma.sql`t.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'approved')`];
    if (regions !== null) conds.push(Prisma.sql`t.region_id = ANY(${regions}::int[])`);
    if (regionIds.length) conds.push(Prisma.sql`t.region_id = ANY(${regionIds}::int[])`);
    if (siteId) conds.push(Prisma.sql`t.site_id = ${siteId}::uuid`);
    if (stage) conds.push(Prisma.sql`st.code = ${stage}`);
    if (text) conds.push(Prisma.sql`(s.site_code ILIKE ${likePattern(text)} OR s.name ILIKE ${likePattern(text)} OR td.code ILIKE ${likePattern(text)} OR td.name_en ILIKE ${likePattern(text)})`);
    if (mine) {
      // the caller acted on the task, holds its ball, or may act at its current level now
      conds.push(Prisma.sql`(t.ball_in_court_user_id = ${me}::uuid
        OR EXISTS (SELECT 1 FROM workflow_steps mw WHERE mw.task_id = t.id AND mw.acted_by = ${me}::uuid)
        OR (t.state IN ('open', 'entry', 'in_review', 'in_approval') AND coalesce(wf_is_eligible(t.id,
              wf_kind(CASE WHEN t.path_frozen_at IS NULL THEN wf_levels_live(t.id) ELSE t.levels_required END, greatest(t.current_level, 1)), ${me}::uuid), false)))`);
    }
    // F3: the AND/OR filter of a saved view of the board (screen tasks-board, the whitelist of site-tasks)
    const adv = await this.filters.fromQuery('tasks-board', q);
    if (adv) conds.push(adv);

    const ids = await this.db.tx.$queryRaw<{ id: string; col: TaskColumn; n: bigint }[]>(Prisma.sql`
      SELECT x.id::text AS id, x.col, x.n FROM (
        SELECT t.id, c.col, count(*) OVER (PARTITION BY c.col) AS n,
          row_number() OVER (PARTITION BY c.col ORDER BY
            CASE WHEN c.col = 'approved' THEN NULL ELSE coalesce(t.level_opened_at, t.updated_at) END ASC NULLS LAST,
            CASE WHEN c.col = 'approved' THEN coalesce(t.approved_date::timestamptz, t.updated_at) END DESC NULLS LAST, t.id) AS rn
        FROM task_instances t
        JOIN sites s ON s.id = t.site_id
        JOIN task_definitions td ON td.id = t.task_def_id
        JOIN stage_definitions st ON st.id = td.stage_id
        LEFT JOIN LATERAL (SELECT w.action::text AS action FROM workflow_steps w WHERE t.state = 'entry' AND w.task_id = t.id ORDER BY w.created_at DESC LIMIT 1) ls ON true
        CROSS JOIN LATERAL (SELECT CASE
          WHEN t.state = 'rejected' OR (t.state = 'entry' AND ls.action = 'reject') THEN 'rejected'
          WHEN t.state IN ('open', 'entry') THEN 'entry'
          WHEN t.state IN ('in_review', 'in_approval') THEN 'review'
          ELSE 'approved' END AS col) c
        WHERE ${Prisma.join(conds, ' AND ')}
      ) x WHERE x.rn <= ${limit} ORDER BY x.col, x.rn`);

    const count = new Map<string, number>();
    for (const r of ids) count.set(r.col, Number(r.n));
    const summaries = ids.length ? await this.view.summaries(await this.view.rows(taskSelect(Prisma.sql`t.id = ANY(${ids.map((r) => r.id)}::uuid[])`))) : [];
    const byId = new Map(summaries.map((s) => [s.id, s]));
    const columns = TASK_COLUMNS.map((key) => {
      const items = ids.filter((r) => r.col === key).map((r) => byId.get(r.id)).filter((x): x is TaskSummaryDto => !!x);
      const n = count.get(key) ?? 0;
      return { key, count: n, more: n > items.length, items };
    });
    return { card_limit: limit, total: [...count.values()].reduce((a, b) => a + b, 0), columns };
  }
}
