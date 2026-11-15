import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { Query } from "../common/query";
import { DbService } from "../db/db.service";
import { SCENARIOS, dashboardParams } from "./dashboard.service";
import {
  aggregateGaps,
  kpiColour,
  sharePct,
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

interface DashSettingsCfg {
  thresholds: Record<string, { green: number; amber: number }>;
  catalogue: { kpis: { code: string; unit: string; direction: "higher" | "lower"; default_green: number; default_amber: number }[] };
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

    const siteWhere = Prisma.sql`
      ${sitesScope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${sitesScope}::int[])`}
      ${p.region_id ? Prisma.sql`AND s.region_id = ${p.region_id}` : Prisma.empty}
      ${p.cluster_code ? Prisma.sql`AND c.cluster_code = ${p.cluster_code}` : Prisma.empty}
      ${p.scenario ? Prisma.sql`AND s.delivery_scenario = ${p.scenario}::"DeliveryScenario"` : Prisma.empty}`;

    const risk = risksOk
      ? await this.riskSection(risksScope, p.region_id ?? null)
      : null;
    const dq = sitesOk ? await this.dataQuality(siteWhere) : null;
    const swap = sitesOk ? await this.swapRelocation(siteWhere) : null;
    const counters = sitesOk ? await this.counters(siteWhere, dq) : null;

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
      counters: counters ?? { available: false, kpis: null, pending_kpis: null, sla_totals: null, sla_by_stage: null, sites_total: null },
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
  private async counters(siteWhere: Prisma.Sql, dq: { sites_checked: number; sites_with_gaps: number } | null) {
    const cfg = (await this.db.tx.$queryRaw<{ j: DashSettingsCfg }[]>`SELECT dashboard_settings_json() AS j`)[0]!.j;
    const slaRows = await this.db.tx.$queryRaw<{ stage_code: string; stage_name: string; stage_name_ar: string; open_tasks: bigint; breach: bigint; at_risk: bigint }[]>(Prisma.sql`
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
      const open = Number(r.open_tasks), breach = Number(r.breach), atRisk = Number(r.at_risk);
      return { stage_code: r.stage_code, stage_name: r.stage_name, stage_name_ar: r.stage_name_ar, open_tasks: open, breach, at_risk: atRisk,
        breach_pct: sharePct(breach, open), at_risk_pct: sharePct(atRisk, open) };
    });
    const openTotal = sla_by_stage.reduce((a, r) => a + r.open_tasks, 0);
    const breachTotal = sla_by_stage.reduce((a, r) => a + r.breach, 0);
    const atRiskTotal = sla_by_stage.reduce((a, r) => a + r.at_risk, 0);
    const values: Record<string, number | null> = {
      sla_breach: sharePct(breachTotal, openTotal),
      sla_at_risk: sharePct(atRiskTotal, openTotal),
      data_quality_gap: dq ? sharePct(dq.sites_with_gaps, dq.sites_checked) : null,
    };
    const kpis = cfg.catalogue.kpis.map((k) => {
      const th = cfg.thresholds[k.code] ?? { green: k.default_green, amber: k.default_amber };
      const value = values[k.code] ?? null;
      return { code: k.code, unit: k.unit, direction: k.direction, value, green: th.green, amber: th.amber,
        colour: kpiColour(value, th.green, th.amber, k.direction) };
    });
    return {
      available: true,
      kpis,
      pending_kpis: kpis.filter((k) => k.value === null).map((k) => k.code),
      sla_totals: { open_tasks: openTotal, breach: breachTotal, at_risk: atRiskTotal },
      sla_by_stage,
      sites_total: Number(siteRows[0]?.n ?? 0),
    };
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
