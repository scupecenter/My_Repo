import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { Query } from "../common/query";
import { DbService } from "../db/db.service";
import { SCENARIOS, dashboardParams } from "./dashboard.service";
import {
  aggregateGaps,
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
