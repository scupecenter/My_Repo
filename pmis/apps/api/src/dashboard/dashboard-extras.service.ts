import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { Query } from "../common/query";
import { DbService } from "../db/db.service";
import { FilterCatalogService } from "../views/filter-catalog.service";
import { SCENARIOS, dashboardParams } from "./dashboard.service";
import {
  aggregateGaps,
  kpiColour,
  roundDays,
  sharePct,
  targetPct,
  buildRiskMatrix,
  decisionTag,
  riskBand,
  riskScore,
  sortRisksForTop,
  SiteGapReport,
  RiskBand,
} from "./dashboard-extras.rules";

const OVERALL = [
  "not_started",
  "in_progress",
  "on_hold",
  "completed",
  "cancelled",
] as const;

/** The task of the TE PAC milestone and of the On-Air milestone (the milestone tasks of the workflow, migration 0013). */
const TE_PAC_TASK = "MS7";
const ON_AIR_TASK = "MS6";

/** The caller's B3 scope of the counters: the regions (null = every region) and the optional region filter of the read. */
interface RegionScope {
  scope: number[] | null;
  region: number | null;
}

/** The O&M team is assigned (setting views.om_team_assigned, default false), as in the sites read (sites.service.ts). */
const OM_ASSIGNED = Prisma.sql`((calc_setting('views.om_team_assigned', 'false'::jsonb) #>> '{}') = 'true')`;

interface DashSettingsCfg {
  thresholds: Record<string, { green: number; amber: number }>;
  targets: { sites_per_batch: number | null; monthly_on_air: number | null };
  stale_idle_days: number;
  catalogue: {
    kpis: {
      code: string;
      unit: string;
      direction: "higher" | "lower";
      default_green: number;
      default_amber: number;
    }[];
  };
}

interface RiskRow {
  risk_code: string;
  statement: string;
  probability: number;
  impact: number;
  status: string;
  risk_owner: string | null;
  region_id: number | null;
  is_global: boolean;
}

/** The intersection of two region scopes (null = every region). */
function intersect(a: number[] | null, b: number[] | null): number[] | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((r) => b.includes(r)).sort((x, y) => x - y);
}

/**
 * GET /dashboard/extras (contract 0.15.16; F13 of the features build plan). The risk matrix, the data quality panel, the swap and relocation breakdown and the
 * decisions card. Plain reads: the caller's dashboard.view regions limit every section; the risk matrix also needs risks.view and the others sites.view.
 * A section the caller may not see answers available false. The pure rules are in dashboard-extras.rules.ts.
 */
@Injectable()
export class DashboardExtrasService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly filters: FilterCatalogService,
  ) {}

  async get(_auth: AuthContext, q: Query): Promise<Record<string, unknown>> {
    const dash = await this.access.requireRegions("dashboard", "view");
    const p = dashboardParams(q);
    const sitesRegions = await this.access.regions("sites", "view");
    const risksRegions = await this.access.regions("risks", "view");
    const sitesScope = intersect(dash, sitesRegions);
    const risksScope = intersect(dash, risksRegions);
    const sitesOk = sitesRegions === null || sitesRegions.length > 0;
    const risksOk = risksRegions === null || risksRegions.length > 0;

    // 0.15.45: the AND/OR filter (screen `dashboard`, the sites fields) narrows the site-based sections like the filters below; the risk matrix has no site filter
    const adv = await this.filters.fromQuery('dashboard', q);
    const siteWhere = Prisma.sql`
      ${sitesScope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${sitesScope}::int[])`}
      ${adv ? Prisma.sql`AND ${adv}` : Prisma.empty}
      ${p.region_id ? Prisma.sql`AND s.region_id = ${p.region_id}` : Prisma.empty}
      ${p.cluster_code ? Prisma.sql`AND c.cluster_code = ${p.cluster_code}` : Prisma.empty}
      ${p.scenario ? Prisma.sql`AND s.delivery_scenario = ${p.scenario}::"DeliveryScenario"` : Prisma.empty}`;

    const risk = risksOk
      ? await this.riskSection(risksScope, p.region_id ?? null)
      : null;
    const dq = sitesOk ? await this.dataQuality(siteWhere) : null;
    const swap = sitesOk ? await this.swapRelocation(siteWhere) : null;
    const counters = sitesOk
      ? await this.counters(siteWhere, dq, {
          scope: sitesScope,
          region: p.region_id ?? null,
        })
      : null;

    return {
      as_of: new Date().toISOString(),
      scope_regions: dash,
      risk_matrix: risk?.matrix ?? {
        available: false,
        open_total: null,
        invalid_total: null,
        cells: null,
        bands: null,
        top_open_risks: null,
      },
      data_quality: dq ?? {
        available: false,
        sites_checked: null,
        sites_with_gaps: null,
        gaps_total: null,
        by_kind: null,
      },
      swap_relocation: swap ?? {
        available: false,
        unscenarioed: null,
        rows: null,
      },
      counters: counters ?? {
        available: false,
        kpis: null,
        pending_kpis: null,
        sla_totals: null,
        sla_by_stage: null,
        sites_total: null,
        site_master_menus: null,
        site360_menus: null,
      },
      decisions: risk
        ? { available: true, items: risk.decisions }
        : { available: false, items: null },
    };
  }

  private async riskSection(scope: number[] | null, region: number | null) {
    const where = Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND (r.is_global OR r.region_id = ANY(${scope}::int[]))`}
      ${region ? Prisma.sql`AND (r.is_global OR r.region_id = ${region})` : Prisma.empty}`;
    const rows = await this.db.tx.$queryRaw<RiskRow[]>(Prisma.sql`
      SELECT r.risk_code, r.statement, r.probability, r.impact, r.status::text AS status, r.risk_owner, r.region_id, r.is_global
      FROM risks r WHERE r.status IN ('open', 'in_progress') ${where}`);
    const matrix = buildRiskMatrix(
      rows.map((r) => ({ probability: r.probability, impact: r.impact })),
    );
    const scored: {
      risk_code: string;
      statement: string;
      probability: number;
      impact: number;
      score: number;
      band: RiskBand;
      status: "open" | "in_progress";
      risk_owner: string | null;
      region_id: number | null;
      is_global: boolean;
    }[] = [];
    for (const r of rows) {
      const score = riskScore(r.probability, r.impact);
      const band = score === null ? null : riskBand(score);
      if (score === null || band === null) continue;
      scored.push({
        risk_code: r.risk_code,
        statement: r.statement,
        probability: r.probability,
        impact: r.impact,
        score,
        band,
        status: r.status as "open" | "in_progress",
        risk_owner: r.risk_owner,
        region_id: r.region_id,
        is_global: r.is_global,
      });
    }
    const sorted = sortRisksForTop(scored);
    const decisions = sorted.slice(0, 10).map((x) => ({
      tag: decisionTag(x.band),
      risk_code: x.risk_code,
      statement: x.statement,
      score: x.score,
      band: x.band,
      risk_owner: x.risk_owner,
      region_id: x.region_id,
    }));
    return {
      matrix: {
        available: true,
        open_total: rows.length,
        invalid_total: matrix.invalid_total,
        cells: matrix.cells,
        bands: matrix.bands,
        top_open_risks: sorted.slice(0, 10),
      },
      decisions,
    };
  }

  /**
   * F20 (contract 0.15.24): the dashboard counters and the KPI colours. SLA breaches and at-risk come from sla_status of the open tasks of the caller's sites
   * (red = past the maximum, amber = past the minimum); data quality from the data quality section of this read. Thresholds are the saved dashboard settings.
   * A KPI with no source yet answers a null value (listed in pending_kpis), so it is never shown as a figure.
   */
  private async counters(
    siteWhere: Prisma.Sql,
    dq: { sites_checked: number; sites_with_gaps: number } | null,
    reg: RegionScope,
  ) {
    const cfg = (
      await this.db.tx.$queryRaw<
        { j: DashSettingsCfg }[]
      >`SELECT dashboard_settings_json() AS j`
    )[0]!.j;
    const slaRows = await this.db.tx.$queryRaw<
      {
        stage_code: string;
        stage_name: string;
        stage_name_ar: string;
        open_tasks: bigint;
        breach: bigint;
        at_risk: bigint;
      }[]
    >(Prisma.sql`
      SELECT sd.code AS stage_code, sd.name_en AS stage_name, sd.name_ar AS stage_name_ar,
             count(*) AS open_tasks,
             count(*) FILTER (WHERE x.colour = 'red') AS breach,
             count(*) FILTER (WHERE x.colour = 'amber') AS at_risk
      FROM (
        SELECT td.stage_id, (sla_status(ti.id)).colour AS colour
        FROM task_instances ti
        JOIN sites s ON s.id = ti.site_id
        LEFT JOIN clusters c ON c.id = s.cluster_id
        JOIN task_definitions td ON td.id = ti.task_def_id
        WHERE ti.state::text IN ('open', 'entry', 'in_review', 'in_approval', 'rejected')
          AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}
      ) x
      JOIN stage_definitions sd ON sd.id = x.stage_id
      GROUP BY sd.seq, sd.code, sd.name_en, sd.name_ar
      ORDER BY sd.seq`);
    const siteRows = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n
      FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`);
    const sla_by_stage = slaRows.map((r) => {
      const open = Number(r.open_tasks),
        breach = Number(r.breach),
        atRisk = Number(r.at_risk);
      return {
        stage_code: r.stage_code,
        stage_name: r.stage_name,
        stage_name_ar: r.stage_name_ar,
        open_tasks: open,
        breach,
        at_risk: atRisk,
        breach_pct: sharePct(breach, open),
        at_risk_pct: sharePct(atRisk, open),
      };
    });
    const openTotal = sla_by_stage.reduce((a, r) => a + r.open_tasks, 0);
    const breachTotal = sla_by_stage.reduce((a, r) => a + r.breach, 0);
    const atRiskTotal = sla_by_stage.reduce((a, r) => a + r.at_risk, 0);
    const src = await this.counterSources(siteWhere, reg, cfg);
    const site_master_menus = await this.siteMasterMenus(siteWhere);
    const values: Record<string, number | null> = {
      sla_breach: sharePct(breachTotal, openTotal),
      sla_at_risk: sharePct(atRiskTotal, openTotal),
      data_quality_gap: dq
        ? sharePct(dq.sites_with_gaps, dq.sites_checked)
        : null,
      ...src,
    };
    const kpis = cfg.catalogue.kpis.map((k) => {
      const th = cfg.thresholds[k.code] ?? {
        green: k.default_green,
        amber: k.default_amber,
      };
      const value = values[k.code] ?? null;
      return {
        code: k.code,
        unit: k.unit,
        direction: k.direction,
        value,
        green: th.green,
        amber: th.amber,
        colour: kpiColour(value, th.green, th.amber, k.direction),
      };
    });
    return {
      available: true,
      kpis,
      pending_kpis: kpis.filter((k) => k.value === null).map((k) => k.code),
      sla_totals: {
        open_tasks: openTotal,
        breach: breachTotal,
        at_risk: atRiskTotal,
      },
      sla_by_stage,
      sites_total: Number(siteRows[0]?.n ?? 0),
      site_master_menus,
      site360_menus: site_master_menus, // deprecated name, one release (0.15.75)
    };
  }

  /**
   * F20 (migration 0113, contract 0.15.29): the sources of the seven counters that had none before. Each reads the existing tables; the B3
   * scope applies (the regions of the caller; the site-based ones also the cluster and scenario filters). A count with no base answers null.
   *  The latest approved versions are read inline from register_records (not fa_latest, which is definer-only), so the reader's row security applies.
   *  - vehicle_ready: approved field assignments (assignment_readiness) whose vehicle is ready (ready_to_mobilize or awaiting_advance), in % of all.
   *  - advances_open_after_close: approved advances still open (approved for disbursement, disbursed, settlement in progress) of an assignment
   *    whose actual end is set; a count.
   *  - dismantle_pending: Dismantle parts (CW, TE) whose approved version in force is not closed; a count.
   *  - as_built_submitted: sites with the TE PAC milestone approved whose As-Built TE part is submitted, in % of those sites.
   *  - time_in_state_p85: the 85th percentile, in working days, of the closed intervals of the task transitions (status_transitions, migration
   *    0098) in a working state (not approved, n/a or skipped); the interval runs to the next transition of the same task.
   *  - stale_tasks: open tasks idle for at least stale_idle_days working days (since the last activity of a person, task_last_activity of
   *    migration 0116, the same rule as the stale badge of the task lists), in % of the open tasks.
   *  - on_air_vs_target: sites whose On-Air milestone is approved in the current month, in % of the monthly target (null without a target).
   */
  private async counterSources(
    siteWhere: Prisma.Sql,
    reg: RegionScope,
    cfg: DashSettingsCfg,
  ): Promise<Record<string, number | null>> {
    const regionOf = (col: string): Prisma.Sql => Prisma.sql`
      ${reg.scope === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(col)} = ANY(${reg.scope}::int[])`}
      ${reg.region ? Prisma.sql`AND ${Prisma.raw(col)} = ${reg.region}` : Prisma.empty}`;

    const veh = (
      await this.db.tx.$queryRaw<{ total: bigint; ready: bigint }[]>(Prisma.sql`
      WITH cur AS MATERIALIZED (SELECT entity_id, region_id FROM (SELECT DISTINCT ON (r.entity_id) r.* FROM register_records r WHERE r.register_key = 'procurement' AND r.state = 'approved' ORDER BY r.entity_id, r.version_no DESC) lp)
      SELECT count(*) AS total,
             count(*) FILTER (WHERE ar.readiness IN ('ready_to_mobilize', 'awaiting_advance')) AS ready
      FROM assignment_readiness ar
      JOIN cur ON cur.entity_id = ar.procurement_entity_id
      WHERE true ${regionOf("cur.region_id")}`)
    )[0]!;

    const advances = (
      await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      WITH proc AS MATERIALIZED (
        SELECT entity_id FROM (SELECT DISTINCT ON (r.entity_id) r.* FROM register_records r WHERE r.register_key = 'procurement' AND r.state = 'approved' ORDER BY r.entity_id, r.version_no DESC) lp WHERE nullif(data ->> 'actual_end', '') IS NOT NULL),
      adv AS (SELECT a.region_id, a.data FROM (SELECT DISTINCT ON (r.entity_id) r.* FROM register_records r WHERE r.register_key = 'financial_advances' AND r.state = 'approved' ORDER BY r.entity_id, r.version_no DESC) a WHERE a.record_type = 'advance')
      SELECT count(*) AS n
      FROM adv JOIN proc ON proc.entity_id::text = adv.data ->> 'procurement_record_id'
      WHERE adv.data ->> 'advance_state' IN ('approved_for_disbursement', 'disbursed', 'settlement_in_progress')
        ${regionOf("adv.region_id")}`)
    )[0]!;

    const dismantle = (
      await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n
      FROM register_records d
      JOIN sites s ON s.id = d.site_id
      LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE d.register_key = 'dismantle' AND d.is_current AND d.state = 'approved'
        AND d.data ->> 'closed' IS DISTINCT FROM 'true'
        AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`)
    )[0]!;

    const asBuilt = (
      await this.db.tx.$queryRaw<
        { total: bigint; submitted: bigint }[]
      >(Prisma.sql`
      WITH pac AS (
        SELECT DISTINCT ti.site_id
        FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
        WHERE td.code = ${TE_PAC_TASK} AND ti.state::text = 'approved')
      SELECT count(*) AS total,
             count(*) FILTER (WHERE ab.te_submitted_date IS NOT NULL) AS submitted
      FROM pac
      JOIN sites s ON s.id = pac.site_id
      LEFT JOIN clusters c ON c.id = s.cluster_id
      LEFT JOIN as_built_records ab ON ab.site_id = s.id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`)
    )[0]!;

    const timeInState = (
      await this.db.tx.$queryRaw<
        { p85: number | null; n: bigint }[]
      >(Prisma.sql`
      WITH t AS (
        SELECT st.to_state, st.at,
               lead(st.at) OVER (PARTITION BY st.entity_id ORDER BY st.at, st.id) AS next_at
        FROM status_transitions st
        JOIN sites s ON s.id = st.site_id
        LEFT JOIN clusters c ON c.id = s.cluster_id
        WHERE st.entity_type = 'task' AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere})
      SELECT percentile_cont(0.85) WITHIN GROUP (
               ORDER BY cal_workdays_between(cal_local_date(t.at), cal_local_date(t.next_at))::float8) AS p85,
             count(*) AS n
      FROM t
      WHERE t.next_at IS NOT NULL AND t.to_state NOT IN ('approved', 'na', 'skipped')`)
    )[0]!;

    const stale = (
      await this.db.tx.$queryRaw<
        { open_total: bigint; stale: bigint }[]
      >(Prisma.sql`
      SELECT count(*) AS open_total,
             count(*) FILTER (WHERE cal_workdays_between(cal_local_date(task_last_activity(ti.id)), cal_today(), r.calendar_id) >= ${cfg.stale_idle_days}::int) AS stale
      FROM task_instances ti
      LEFT JOIN sla_rules r ON r.id = ti.sla_rule_id
      JOIN sites s ON s.id = ti.site_id
      LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE ti.state::text IN ('open', 'entry', 'in_review', 'in_approval', 'rejected')
        AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`)
    )[0]!;

    const onAir = (
      await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(DISTINCT s.id) AS n
      FROM task_instances ti
      JOIN task_definitions td ON td.id = ti.task_def_id
      JOIN sites s ON s.id = ti.site_id
      LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE td.code = ${ON_AIR_TASK} AND ti.state::text = 'approved'
        AND ti.actual_date >= date_trunc('month', cal_today())::date AND ti.actual_date <= cal_today()
        AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`)
    )[0]!;

    return {
      vehicle_ready: sharePct(Number(veh.ready), Number(veh.total)),
      advances_open_after_close: Number(advances.n),
      dismantle_pending: Number(dismantle.n),
      as_built_submitted: sharePct(
        Number(asBuilt.submitted),
        Number(asBuilt.total),
      ),
      time_in_state_p85:
        Number(timeInState.n) > 0 ? roundDays(timeInState.p85) : null,
      stale_tasks: sharePct(Number(stale.stale), Number(stale.open_total)),
      on_air_vs_target: targetPct(Number(onAir.n), cfg.targets.monthly_on_air),
    };
  }

  /**
   * F20 (migration 0113, contract 0.15.29): the sites per Site Master menu. The menus are the views of the workflow (workflow_views, migration 0023:
   * CW, TE, OM); a site is in a view when it has a task of the view that is not n/a or skipped. "All sites" is sites_total of the counters.
   * Design & Acquisition, Handover & Closure and Dismantle have no view in the schema, so they are not counted.
   */
  private async siteMasterMenus(siteWhere: Prisma.Sql) {
    const views = await this.db.tx.$queryRaw<
      {
        code: string;
        name_en: string;
        name_ar: string | null;
        sort_order: number;
      }[]
    >`
      SELECT DISTINCT ON (v.code) v.code, v.name_en, v.name_ar, v.sort_order
      FROM workflow_views v JOIN workflow_definitions wd ON wd.id = v.workflow_id
      ORDER BY v.code, wd.version DESC`;
    const counts = await this.db.tx.$queryRaw<
      { view_code: string; n: bigint }[]
    >(Prisma.sql`
      WITH vt AS (
        SELECT DISTINCT vm.view_code, vtd.id AS task_def_id
        FROM workflow_view_members vm
        JOIN stage_definitions vst ON vst.workflow_id = vm.workflow_id AND vst.is_active
        JOIN task_definitions vtd ON vtd.stage_id = vst.id AND vtd.is_active
        WHERE ((vm.member_kind = 'stage' AND vm.member_code = vst.code)
               OR (vm.member_kind = 'task' AND vm.member_code = vtd.code))
          AND (vm.om_assigned IS NULL OR vm.om_assigned = ${OM_ASSIGNED})
      )
      SELECT vt.view_code, count(DISTINCT s.id) AS n
      FROM vt
      JOIN task_instances ti ON ti.task_def_id = vt.task_def_id AND ti.state::text NOT IN ('na', 'skipped')
      JOIN sites s ON s.id = ti.site_id
      LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}
      GROUP BY vt.view_code`);
    const byCode = new Map(counts.map((r) => [r.view_code, Number(r.n)]));
    return [...views]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((v) => ({
        code: v.code,
        name_en: v.name_en,
        name_ar: v.name_ar,
        sites: byCode.get(v.code) ?? 0,
      }));
  }

  private async dataQuality(siteWhere: Prisma.Sql) {
    const rows = await this.db.tx.$queryRaw<
      { id: string; g: SiteGapReport }[]
    >(Prisma.sql`
      SELECT s.id::text AS id, site_data_gaps(s.id) AS g
      FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`);
    const agg = aggregateGaps(rows.map((r) => r.g));
    return {
      available: true,
      sites_checked: agg.sites_checked,
      sites_with_gaps: agg.sites_with_gaps,
      gaps_total: agg.gaps_total,
      by_kind: agg.by_kind,
    };
  }

  private async swapRelocation(siteWhere: Prisma.Sql) {
    const rows = await this.db.tx.$queryRaw<
      { scenario: string | null; status: string; n: bigint }[]
    >(Prisma.sql`
      SELECT s.delivery_scenario::text AS scenario, s.overall_status::text AS status, count(*) AS n
      FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.is_active ${siteWhere}
      GROUP BY 1, 2`);
    const table = SCENARIOS.map((sc) => {
      const by: Record<string, number> = Object.fromEntries(
        OVERALL.map((k) => [k, 0]),
      );
      for (const r of rows.filter((x) => x.scenario === sc))
        by[r.status] = (by[r.status] ?? 0) + Number(r.n);
      return {
        scenario: sc,
        sites_total: Object.values(by).reduce((a, b) => a + b, 0),
        by_overall_status: by,
      };
    });
    const unscenarioed = rows
      .filter((r) => r.scenario === null)
      .reduce((a, r) => a + Number(r.n), 0);
    return { available: true, unscenarioed, rows: table };
  }
}
