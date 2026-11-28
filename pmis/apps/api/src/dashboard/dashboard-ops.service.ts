import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { Query } from "../common/query";
import { DbService } from "../db/db.service";
import { ContractorPerformanceService } from "../contractors/contractor-performance.service";
import { FilterCatalogService } from "../views/filter-catalog.service";
import { dashboardParams } from "./dashboard.service";
import { monthlyOnAirTarget } from "./dashboard-targets";
import {
  AgeBuckets,
  ActionDueRow,
  AdvanceRow,
  financeSummary,
  type InvoiceRow,
  actionsSummary,
  ApprovalWaitRow,
  ChangeWaitRow,
  changesSummary,
  approvalsByRole,
  bucketAges,
  firstPassPct,
  meanDays,
  PTW_CHECK_KEYS,
  ptwCheckGaps,
  receivePct,
  scorecardSummary,
  phaseScope,
  PhaseScopeRow,
} from "./dashboard-ops.rules";

interface OrderAges {
  pr_days: number | null;
  po_days: number | null;
  has_po: boolean;
}

interface PtwChecksRow {
  hse_checks: unknown;
}

interface ShortageRow {
  site_id: string;
  site_code: string;
  item_code: string;
  item_name: string;
  item_group: string;
  required: number;
  dispatched: number;
  missing: number;
  party_id: string | null;
}

/**
 * GET /dashboard/ops (contract 0.15.98): the follow-up sections of the dashboard beyond F13. First section: procurement
 * and materials (owner approval 2026-11-26). Read only, not audited. The caller's dashboard.view regions limit every
 * section; the orders also need procurement.view and the materials warehouse.view; a part the caller may not see
 * answers available false. The pure rules are in dashboard-ops.rules.ts.
 *
 * Definitions (documented in the contract):
 *   - open order: a Procurement record whose order status is not one of the closing statuses of the contractor rules
 *     (the same rule as the contractor performance view, so the two screens never disagree).
 *   - PR wait: an open order with a PR date and no PO/WO yet, aged in calendar days from the PR date.
 *   - PO wait: an open order with a PO/WO date, aged in calendar days from the PO/WO date.
 *   - shortage: a warehouse site quantity with required over dispatched, on an active, not cancelled site.
 *   - contractor of a shortage line: the party of the site's newest open procurement order; lines of a site with no
 *     open order are unattributed. Amounts are not part of this section (no price is stored on a Procurement record).
 *   - contractor scorecard (0.15.202, item 5): the aggregate of the contractor performance report — the counts per
 *     level, the on-time rectification rate of snags, the average delay and the rejection (quality fail) rate, and
 *     the five worst parties. No amounts. Needs contractors view, else available false.
 *   - quality (0.15.203, item 6): the open snags and NCRs of the in-scope sites, the average closure age of each and
 *     the first-time acceptance rate (Pass over Pass + Fail of the decided inspections; the data keeps no
 *     re-inspection marker). Needs quality view, else available false.
 *   - approvals (0.15.204, item 7): the tasks waiting for review or approval (the same population as the Approvals
 *     inbox), their ages in calendar days since the level opened (falling back to the last update, as the inbox
 *     orders), split review against approve and grouped by the ball-in-court role. Needs the approvals and the sites
 *     view, else available false.
 *   - changes_meetings (0.15.205, item 8): the change requests still pending (aged since the request date, per kind)
 *     and the approved ones not applied, and the meeting actions not closed with the overdue ones aged by days late.
 *     Each part needs its own module view (change_control, meetings), else that part answers available false.
 *   - finance (0.15.206, item 9): the restricted financial summary (advances, disbursed against assignment completion).
 *     Shown only to a holder of a role the setting dashboard.finance_readers lists (default Project Manager and Finance
 *     Officer, switched off until an admin turns it on) who also has the financial_advances view; otherwise
 *     available false with no figure. Never part of an export or a share link: it is read only here, per caller.
 */
@Injectable()
export class DashboardOpsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly filters: FilterCatalogService,
    private readonly perf: ContractorPerformanceService,
  ) {}

  async get(_auth: AuthContext, q: Query): Promise<Record<string, unknown>> {
    const dash = await this.access.requireRegions("dashboard", "view");
    const p = dashboardParams(q);
    await this.access.requireDashboardTab(p.view);
    const procRegions = await this.access.regions("procurement", "view");
    const whRegions = await this.access.regions("warehouse", "view");
    const permitRegions = await this.access.regions("permits_hse", "view");
    const gecolRegions = await this.access.regions("gecol", "view");
    const hlcRegions = await this.access.regions("hlc", "view");
    const contractorRegions = await this.access.regions("contractors", "view");
    const qualityRegions = await this.access.regions("quality", "view");
    const approvalsRegions = await this.access.regions("approvals", "view");
    const sitesRegions = await this.access.regions("sites", "view");
    const dashOk = dash === null || dash.length > 0;
    const changeRegions = await this.access.regions("change_control", "view");
    const meetingRegions = await this.access.regions("meetings", "view");
    const finRegions = await this.access.regions("financial_advances", "view");
    const finReader = await this.financeReader();
    const financeOk = finReader && (finRegions === null || finRegions.length > 0);
    const finScope = intersect(dash, finRegions);
    const changeScope = intersect(dash, changeRegions);
    const meetingScope = intersect(dash, meetingRegions);
    const changesOk = changeRegions === null || changeRegions.length > 0;
    const meetingsOk = meetingRegions === null || meetingRegions.length > 0;
    const procScope = intersect(dash, procRegions);
    const whScope = intersect(dash, whRegions);
    const permitScope = intersect(dash, permitRegions);
    const gecolScope = intersect(dash, gecolRegions);
    const hlcScope = intersect(dash, hlcRegions);
    const qualityScope = intersect(dash, qualityRegions);
    const approvalsScope = intersect(
      dash,
      intersect(approvalsRegions, sitesRegions),
    );
    const procOk = procRegions === null || procRegions.length > 0;
    const whOk = whRegions === null || whRegions.length > 0;
    const permitsOk = permitRegions === null || permitRegions.length > 0;
    const gecolOk = gecolRegions === null || gecolRegions.length > 0;
    const hlcOk = hlcRegions === null || hlcRegions.length > 0;
    const contractorsOk =
      contractorRegions === null || contractorRegions.length > 0;
    const qualityOk =
      qualityRegions === null || qualityRegions.length > 0;
    const approvalsOk =
      (approvalsRegions === null || approvalsRegions.length > 0) &&
      (sitesRegions === null || sitesRegions.length > 0);

    const orders = procOk ? await this.ordersSection(procScope, p.region_id ?? null) : null;
    const adv = whOk ? await this.filters.fromQuery("dashboard", q) : null;
    const materials = whOk
      ? await this.materialsSection(whScope, p.region_id ?? null, adv)
      : null;
    const permits = permitsOk
      ? await this.permitsSection(permitScope, p.region_id ?? null)
      : null;
    const gecol = gecolOk
      ? await this.gecolSection(gecolScope, p.region_id ?? null)
      : null;
    const hlc = hlcOk
      ? await this.hlcSection(hlcScope, p.region_id ?? null)
      : null;
    const score = contractorsOk
      ? scorecardSummary((await this.perf.reportData()).items)
      : null;
    const quality = qualityOk
      ? await this.qualitySection(qualityScope, p.region_id ?? null)
      : null;
    const approvals = approvalsOk
      ? await this.approvalsSection(approvalsScope, p.region_id ?? null)
      : null;
    const changes = changesOk
      ? await this.changesSection(changeScope, p.region_id ?? null)
      : null;
    const finance = financeOk
      ? await this.financeSection(finScope, p.region_id ?? null)
      : null;
    const actions = meetingsOk
      ? await this.actionsSection(meetingScope, p.region_id ?? null)
      : null;

    const phase = dashOk
      ? await this.phaseSection(dash, p.region_id ?? null, await this.filters.fromQuery("dashboard", q))
      : null;

    return {
      as_of: new Date().toISOString(),
      scope_regions: dash,
      procurement: {
        available: procOk,
        open_total: orders?.open_total ?? null,
        pr_wait: orders?.pr_wait ?? null,
        po_wait: orders?.po_wait ?? null,
        materials: {
          available: whOk,
          receive_pct: materials?.receive_pct ?? null,
          required_total: materials?.required_total ?? null,
          dispatched_total: materials?.dispatched_total ?? null,
          sites_short: materials?.sites_short ?? null,
          top_shortages: materials?.top_shortages ?? null,
          by_contractor: materials?.by_contractor ?? null,
        },
      },
      gecol_hlc: {
        gecol: {
          available: gecolOk,
          in_scope: gecol?.in_scope ?? null,
          powered: gecol?.powered ?? null,
          waiting: gecol?.waiting ?? null,
          no_record: gecol?.no_record ?? null,
          civil_ready_no_power: gecol?.civil_ready_no_power ?? null,
        },
        hlc: {
          available: hlcOk,
          in_scope: hlc?.in_scope ?? null,
          in_service: hlc?.in_service ?? null,
          waiting: hlc?.waiting ?? null,
          no_record: hlc?.no_record ?? null,
          installed_not_in_service: hlc?.installed_not_in_service ?? null,
        },
      },
      permits_hse: {
        available: permitsOk,
        total: permits?.total ?? null,
        by_status: permits?.by_status ?? null,
        waiting: permits?.waiting ?? null,
        sites_without_permit: permits?.sites_without_permit ?? null,
        expiring_14: permits?.expiring_14 ?? null,
        expired: permits?.expired ?? null,
        stop_work_active: permits?.stop_work_active ?? null,
        ptw: {
          open: permits?.ptw.open ?? null,
          with_gaps: permits?.ptw.with_gaps ?? null,
          gaps: permits?.ptw.gaps ?? null,
        },
      },
      quality: {
        available: qualityOk,
        snags: quality?.snags ?? null,
        ncrs: quality?.ncrs ?? null,
        first_pass_pct: quality?.first_pass_pct ?? null,
      },
      approvals: {
        available: approvalsOk,
        total: approvals?.total ?? null,
        review: approvals?.review ?? null,
        approve: approvals?.approve ?? null,
        waiting: approvals?.waiting ?? null,
        by_role: approvals?.by_role ?? null,
        unassigned: approvals?.unassigned ?? null,
      },
      finance: {
        available: financeOk,
        advances: finance?.advances ?? null,
        amounts: finance?.amounts ?? null,
        open_aging: finance?.open_aging ?? null,
        achievement: finance?.achievement ?? null,
      },
      changes_meetings: {
        available: changesOk || meetingsOk,
        changes: {
          available: changesOk,
          pending: changes?.pending ?? null,
          approved_not_applied: changes?.approved_not_applied ?? null,
          by_kind: changes?.by_kind ?? null,
          pending_aging: changes?.pending_aging ?? null,
        },
        actions: {
          available: meetingsOk,
          open: actions?.open ?? null,
          overdue: actions?.overdue ?? null,
          no_due_date: actions?.no_due_date ?? null,
          overdue_aging: actions?.overdue_aging ?? null,
        },
      },
      phase_scope: {
        available: dashOk,
        phases: phase?.phases ?? null,
        total: phase?.total ?? null,
        monthly_on_air_auto: phase?.monthly_on_air_auto ?? null,
      },
      contractor_scorecard: {
        available: contractorsOk,
        parties: score?.parties ?? null,
        by_level: score?.by_level ?? null,
        avg_delay_days: score?.avg_delay_days ?? null,
        on_time_pct: score?.on_time_pct ?? null,
        quality_fail_pct: score?.quality_fail_pct ?? null,
        snags: score?.snags ?? null,
        quality: score?.quality ?? null,
        worst: score?.worst ?? null,
      },
    };
  }

  /**
   * The GECOL power position (0.15.201, item 4): the active, not cancelled sites with the GECOL scope, the powered
   * ones (power_on_date set), the waiting ones with their age since the GECOL request date (bucketed 0-7, 8-14,
   * 15-30, over 30), the in-scope sites with no GECOL record at all, and the civilly ready but not electrified: the
   * CW PAC (task B13) is approved but the power is not on yet.
   */
  private async gecolSection(
    scope: number[] | null,
    region: number | null,
  ): Promise<{
    in_scope: number;
    powered: number;
    waiting: AgeBuckets;
    no_record: number;
    civil_ready_no_power: number;
  }> {
    const where = Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND s.region_id = ${region}` : Prisma.empty}`;
    const counts = await this.db.tx.$queryRaw<
      { in_scope: number; powered: number; no_record: number; civil_ready_no_power: number }[]
    >(Prisma.sql`
      SELECT count(*)::int AS in_scope,
             count(*) FILTER (WHERE g.power_on_date IS NOT NULL)::int AS powered,
             count(*) FILTER (WHERE g.id IS NULL)::int AS no_record,
             count(*) FILTER (WHERE g.power_on_date IS NULL AND pac.approved_date IS NOT NULL)::int AS civil_ready_no_power
      FROM sites s
      LEFT JOIN gecol_records g ON g.site_id = s.id AND g.region_id = s.region_id
      LEFT JOIN LATERAL (
        SELECT ti.approved_date FROM task_instances ti
        JOIN task_definitions td ON td.id = ti.task_def_id
        WHERE ti.site_id = s.id AND td.code = 'B13' AND ti.approved_date IS NOT NULL
        LIMIT 1
      ) pac ON true
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND s.scope_gecol_power = 'yes' ${where}`);
    const ages = await this.db.tx.$queryRaw<{ days: number | null }[]>(Prisma.sql`
      SELECT (CURRENT_DATE - g.request_date)::int AS days
      FROM sites s JOIN gecol_records g ON g.site_id = s.id AND g.region_id = s.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND s.scope_gecol_power = 'yes'
        AND g.power_on_date IS NULL ${where}`);
    const c = counts[0] ?? { in_scope: 0, powered: 0, no_record: 0, civil_ready_no_power: 0 };
    return {
      in_scope: c.in_scope,
      powered: c.powered,
      waiting: bucketAges(ages.map((r) => r.days).filter((d): d is number => d !== null)),
      no_record: c.no_record,
      civil_ready_no_power: c.civil_ready_no_power,
    };
  }

  /**
   * The HLC fiber position (0.15.201, item 4): the active, not cancelled sites with the HLC scope, the in-service
   * ones (in_service_date set), the waiting ones with their age since the request (the HLC record's request date,
   * else the PR date of the linked Procurement order), the installed lines not yet in service, and the in-scope
   * sites with no HLC record at all.
   */
  private async hlcSection(
    scope: number[] | null,
    region: number | null,
  ): Promise<{
    in_scope: number;
    in_service: number;
    waiting: AgeBuckets;
    no_record: number;
    installed_not_in_service: number;
  }> {
    const where = Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND s.region_id = ${region}` : Prisma.empty}`;
    const counts = await this.db.tx.$queryRaw<
      { in_scope: number; in_service: number; no_record: number; installed_not_in_service: number }[]
    >(Prisma.sql`
      SELECT count(*)::int AS in_scope,
             count(*) FILTER (WHERE h.in_service_date IS NOT NULL)::int AS in_service,
             count(*) FILTER (WHERE h.id IS NULL)::int AS no_record,
             count(*) FILTER (WHERE h.in_service_date IS NULL AND h.installation_date IS NOT NULL)::int AS installed_not_in_service
      FROM sites s
      LEFT JOIN hlc_records h ON h.site_id = s.id AND h.region_id = s.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND s.scope_hlc_fiber = 'yes' ${where}`);
    const ages = await this.db.tx.$queryRaw<{ days: number | null }[]>(Prisma.sql`
      SELECT (CURRENT_DATE - coalesce(h.request_date, pr.pr_date))::int AS days
      FROM sites s
      JOIN hlc_records h ON h.site_id = s.id AND h.region_id = s.region_id
      LEFT JOIN procurement_records pr ON pr.id = h.procurement_record_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND s.scope_hlc_fiber = 'yes'
        AND h.in_service_date IS NULL ${where}`);
    const c = counts[0] ?? { in_scope: 0, in_service: 0, no_record: 0, installed_not_in_service: 0 };
    return {
      in_scope: c.in_scope,
      in_service: c.in_service,
      waiting: bucketAges(ages.map((r) => r.days).filter((d): d is number => d !== null)),
      no_record: c.no_record,
      installed_not_in_service: c.installed_not_in_service,
    };
  }

  /**
   * The permits and HSE position (0.15.200, item 3): status mix, validity pressure and open stop-work over the
   * permit records of active, not cancelled sites, plus the safety-check gaps of the open PTWs (status Applied or
   * Approved). A check counts as covered only when it is Done or N/A (ptwCheckGaps). "Expiring" means an approved,
   * dated permit whose validity ends within the next 14 calendar days; "expired" means that date has passed.
   * The incident side of item 3 lands with the Incidents register (#263); this section is the permits side.
   */
  private async permitsSection(
    scope: number[] | null,
    region: number | null,
  ): Promise<{
    total: number;
    by_status: { status: string; count: number }[];
    waiting: number;
    sites_without_permit: number;
    expiring_14: number;
    expired: number;
    stop_work_active: number;
    ptw: { open: number; with_gaps: number; gaps: { key: string; count: number }[] };
  }> {
    const where = Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND p.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND p.region_id = ${region}` : Prisma.empty}`;
    const agg = await this.db.tx.$queryRaw<
      {
        total: number;
        waiting: number;
        expiring_14: number;
        expired: number;
        stop_work_active: number;
      }[]
    >(Prisma.sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE p.status = 'Applied')::int AS waiting,
             count(*) FILTER (WHERE p.status = 'Approved' AND p.has_expiry
                              AND p.valid_to >= CURRENT_DATE AND p.valid_to <= CURRENT_DATE + 14)::int AS expiring_14,
             count(*) FILTER (WHERE p.status = 'Approved' AND p.has_expiry
                              AND p.valid_to < CURRENT_DATE)::int AS expired,
             count(*) FILTER (WHERE p.stop_work AND p.stop_lifted_date IS NULL)::int AS stop_work_active
      FROM permit_records p JOIN sites s ON s.id = p.site_id AND s.region_id = p.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${where}`);
    const statuses = await this.db.tx.$queryRaw<
      { status: string; count: number }[]
    >(Prisma.sql`
      SELECT coalesce(nullif(btrim(p.status), ''), '(none)') AS status, count(*)::int AS count
      FROM permit_records p JOIN sites s ON s.id = p.site_id AND s.region_id = p.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${where}
      GROUP BY 1 ORDER BY count DESC, status COLLATE "C"`);
    const ptwRows = await this.db.tx.$queryRaw<PtwChecksRow[]>(Prisma.sql`
      SELECT p.hse_checks
      FROM permit_records p JOIN sites s ON s.id = p.site_id AND s.region_id = p.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled'
        AND p.permit_type ILIKE 'PTW%' AND p.status IN ('Applied', 'Approved') ${where}`);
    const gapCounts = new Map<string, number>();
    let withGaps = 0;
    for (const r of ptwRows) {
      const gaps = ptwCheckGaps(
        r.hse_checks && typeof r.hse_checks === "object" && !Array.isArray(r.hse_checks)
          ? (r.hse_checks as Record<string, unknown>)
          : null,
      );
      if (gaps.length > 0) withGaps += 1;
      for (const k of gaps) gapCounts.set(k, (gapCounts.get(k) ?? 0) + 1);
    }
    const noPermit = await this.db.tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM sites s
      WHERE s.is_active AND s.overall_status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM permit_records p WHERE p.site_id = s.id AND p.region_id = s.region_id)
        ${scope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${scope}::int[])`}
        ${region ? Prisma.sql`AND s.region_id = ${region}` : Prisma.empty}`);
    const a = agg[0] ?? {
      total: 0,
      waiting: 0,
      expiring_14: 0,
      expired: 0,
      stop_work_active: 0,
    };
    return {
      total: a.total,
      by_status: statuses,
      waiting: a.waiting,
      sites_without_permit: noPermit[0]?.n ?? 0,
      expiring_14: a.expiring_14,
      expired: a.expired,
      stop_work_active: a.stop_work_active,
      ptw: {
        open: ptwRows.length,
        with_gaps: withGaps,
        gaps: PTW_CHECK_KEYS.map((k) => ({
          key: k,
          count: gapCounts.get(k) ?? 0,
        })).filter((g) => g.count > 0),
      },
    };
  }

  /** The open orders with their PR and PO ages, bucketed in the rules. */
  /**
   * The quality position (0.15.203, item 6): the snags and NCRs of the active, not cancelled sites in scope. A snag is
   * open while its status is open, fix_uploaded or in_review; returned_open counts the open ones returned at least
   * once (return_count over 0). An NCR is a quality record of record type ncr; it is open while it has no closed_date.
   * The closure ages are calendar days from raised to closed, averaged over the closed ones (meanDays). The
   * first-time acceptance is Pass over Pass + Fail of the decided inspections (result pass or fail, case and space
   * insensitive), one decimal; the data keeps no re-inspection marker, so a re-inspected record counts like any other.
   */
  private async qualitySection(
    scope: number[] | null,
    region: number | null,
  ): Promise<{
    snags: { open: number; closed: number; avg_close_days: number | null; returned_open: number };
    ncrs: { open: number; closed: number; avg_close_days: number | null };
    first_pass_pct: number | null;
  }> {
    const where = (alias: string) => Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(alias)}.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND ${Prisma.raw(alias)}.region_id = ${region}` : Prisma.empty}`;
    const snagCounts = await this.db.tx.$queryRaw<
      { open: number; closed: number; returned_open: number }[]
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE sn.status::text IN ('open', 'fix_uploaded', 'in_review'))::int AS open,
             count(*) FILTER (WHERE sn.status::text = 'closed')::int AS closed,
             count(*) FILTER (WHERE sn.status::text IN ('open', 'fix_uploaded', 'in_review') AND sn.return_count > 0)::int AS returned_open
      FROM snags sn
      JOIN sites s ON s.id = sn.site_id AND s.region_id = sn.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND sn.status::text <> 'cancelled' ${where('sn')}`);
    const snagAges = await this.db.tx.$queryRaw<{ days: number | null }[]>(Prisma.sql`
      SELECT (sn.closed_at::date - sn.raised_at::date)::int AS days
      FROM snags sn
      JOIN sites s ON s.id = sn.site_id AND s.region_id = sn.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND sn.status::text = 'closed'
        AND sn.closed_at IS NOT NULL ${where('sn')}`);
    const ncrCounts = await this.db.tx.$queryRaw<
      { open: number; closed: number; avg_close_days: number | null }[]
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE q.closed_date IS NULL)::int AS open,
             count(*) FILTER (WHERE q.closed_date IS NOT NULL)::int AS closed,
             avg((q.closed_date - q.raised_date)::int) FILTER (WHERE q.closed_date IS NOT NULL AND q.raised_date IS NOT NULL) AS avg_close_days
      FROM quality_inspections q
      JOIN sites s ON s.id = q.site_id AND s.region_id = q.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND lower(btrim(q.record_type)) = 'ncr' ${where('q')}`);
    const decided = await this.db.tx.$queryRaw<{ pass: number; fail: number }[]>(Prisma.sql`
      SELECT count(*) FILTER (WHERE lower(btrim(q.result)) = 'pass')::int AS pass,
             count(*) FILTER (WHERE lower(btrim(q.result)) = 'fail')::int AS fail
      FROM quality_inspections q
      JOIN sites s ON s.id = q.site_id AND s.region_id = q.region_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' AND lower(btrim(q.result)) IN ('pass', 'fail') ${where('q')}`);
    const sc = snagCounts[0] ?? { open: 0, closed: 0, returned_open: 0 };
    const nc = ncrCounts[0] ?? { open: 0, closed: 0, avg_close_days: null };
    const dc = decided[0] ?? { pass: 0, fail: 0 };
    return {
      snags: {
        open: sc.open,
        closed: sc.closed,
        avg_close_days: meanDays(
          snagAges.map((r) => r.days).filter((d): d is number => d !== null),
        ),
        returned_open: sc.returned_open,
      },
      ncrs: {
        open: nc.open,
        closed: nc.closed,
        avg_close_days: nc.avg_close_days === null ? null : Math.round(Number(nc.avg_close_days) * 10) / 10,
      },
      first_pass_pct: firstPassPct(dc.pass, dc.fail),
    };
  }

  /**
   * The pending approvals bottleneck (0.15.204, item 7): the tasks of the active, not cancelled sites in scope whose
   * state is in_review or in_approval (the population of the Approvals inbox), aged in calendar days from
   * level_opened_at (falling back to updated_at, the same fallback the inbox orders by), and grouped by the
   * ball-in-court role (approvalsByRole). A level a group holds, or nobody holds yet, has no role and counts as
   * unassigned.
   */
  private async approvalsSection(
    scope: number[] | null,
    region: number | null,
  ) {
    const rows = await this.db.tx.$queryRaw<ApprovalWaitRow[]>(Prisma.sql`
      SELECT t.ball_in_court_role_id::text AS role_id, r.name_en, r.name_ar,
             (CURRENT_DATE - coalesce(t.level_opened_at::date, t.updated_at::date))::int AS days,
             t.state::text AS state
      FROM task_instances t
      JOIN sites s ON s.id = t.site_id AND s.region_id = t.region_id
      LEFT JOIN roles r ON r.id = t.ball_in_court_role_id
      WHERE t.state::text IN ('in_review', 'in_approval') AND s.is_active AND s.overall_status <> 'cancelled'
      ${scope === null ? Prisma.empty : Prisma.sql`AND t.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND t.region_id = ${region}` : Prisma.empty}`);
    return approvalsByRole(rows);
  }

  /** Does the caller see the restricted financial summary (the setting dashboard.finance_readers, role based). */
  private async financeReader(): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT dashboard_finance_reader() AS ok`;
    return r[0]?.ok === true;
  }

  /**
   * The advances (0.15.206, item 9): the latest approved version of each advance record in the regions in scope, with
   * the completion of the assignment (procurement record) it belongs to. Amounts of a record whose amounts are hidden
   * are left out (financeSummary).
   */
  private async financeSection(scope: number[] | null, region: number | null) {
    const rows = await this.db.tx.$queryRaw<AdvanceRow[]>(Prisma.sql`
      WITH num AS (SELECT '^-?[0-9]+([.][0-9]+)?$'::text AS re),
      adv AS (
        SELECT a.* FROM (SELECT DISTINCT ON (r.entity_id) r.* FROM register_records r
                         WHERE r.register_key = 'financial_advances' AND r.state = 'approved'
                         ORDER BY r.entity_id, r.version_no DESC) a
        WHERE a.record_type = 'advance'
        ${scope === null ? Prisma.empty : Prisma.sql`AND a.region_id = ANY(${scope}::int[])`}
        ${region ? Prisma.sql`AND a.region_id = ${region}` : Prisma.empty}),
      proc AS (
        SELECT l.entity_id::text AS id, nullif(l.data ->> 'actual_end', '') IS NOT NULL AS done
        FROM (SELECT DISTINCT ON (r.entity_id) r.* FROM register_records r
              WHERE r.register_key = 'procurement' AND r.state = 'approved'
              ORDER BY r.entity_id, r.version_no DESC) l)
      SELECT adv.data ->> 'advance_state' AS state,
             CASE WHEN adv.data ->> 'approved_amount' ~ num.re THEN (adv.data ->> 'approved_amount')::numeric END::float8 AS approved,
             CASE WHEN adv.data ->> 'disbursed_amount' ~ num.re THEN (adv.data ->> 'disbursed_amount')::numeric END::float8 AS disbursed,
             CASE WHEN adv.data ->> 'returned_amount' ~ num.re THEN (adv.data ->> 'returned_amount')::numeric END::float8 AS returned,
             CASE WHEN adv.data ->> 'disbursed_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (CURRENT_DATE - (adv.data ->> 'disbursed_date')::date)::int END AS days_since_disbursed,
             proc.id AS assignment_id, coalesce(proc.done, false) AS assignment_done,
             coalesce(adv.data ->> 'amounts_hidden', 'false') = 'true' AS amounts_hidden
      FROM adv CROSS JOIN num LEFT JOIN proc ON proc.id = adv.data ->> 'procurement_record_id'`);
    // 0.15.540: the invoices register (latest approved version of each invoice), in the same regions
    const inv = await this.db.tx.$queryRaw<InvoiceRow[]>(Prisma.sql`
      SELECT i.data ->> 'invoice_state' AS state,
             CASE WHEN i.data ->> 'invoice_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (CURRENT_DATE - (i.data ->> 'invoice_date')::date)::int END AS days_since_invoice,
             CASE WHEN i.data ->> 'due_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (CURRENT_DATE - (i.data ->> 'due_date')::date)::int END AS days_past_due
      FROM (SELECT DISTINCT ON (r.entity_id) r.* FROM register_records r
            WHERE r.register_key = 'invoices' AND r.state = 'approved'
            ORDER BY r.entity_id, r.version_no DESC) i
      WHERE true
      ${scope === null ? Prisma.empty : Prisma.sql`AND i.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND i.region_id = ${region}` : Prisma.empty}`);
    return financeSummary(rows, inv);
  }

  /**
   * The change requests (0.15.205, item 8): rows of change_requests in the regions in scope (a global row, with no
   * region, is outside a regional scope like every other card), aged from request_date.
   */
  private async changesSection(scope: number[] | null, region: number | null) {
    const rows = await this.db.tx.$queryRaw<ChangeWaitRow[]>(Prisma.sql`
      SELECT c.kind::text AS kind, c.status::text AS status, (CURRENT_DATE - c.request_date)::int AS days
      FROM change_requests c
      WHERE c.status::text IN ('requested', 'approved')
      ${scope === null ? Prisma.empty : Prisma.sql`AND c.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND c.region_id = ${region}` : Prisma.empty}`);
    return changesSummary(rows);
  }

  /** The meeting actions not closed (0.15.205, item 8), by the region of their meeting; days overdue against the due date. */
  private async actionsSection(scope: number[] | null, region: number | null) {
    const rows = await this.db.tx.$queryRaw<ActionDueRow[]>(Prisma.sql`
      SELECT a.status::text AS status, (CURRENT_DATE - a.due_date)::int AS days_overdue
      FROM meeting_actions a JOIN meetings m ON m.id = a.meeting_id
      WHERE a.status::text IN ('open', 'in_progress')
      ${scope === null ? Prisma.empty : Prisma.sql`AND m.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND m.region_id = ${region}` : Prisma.empty}`);
    return actionsSummary(rows);
  }

  private async ordersSection(
    scope: number[] | null,
    region: number | null,
  ): Promise<{ open_total: number; pr_wait: AgeBuckets; po_wait: AgeBuckets }> {
    const rows = await this.db.tx.$queryRaw<OrderAges[]>(Prisma.sql`
      WITH cfg AS (SELECT closed_order_statuses AS cl FROM contractor_rules LIMIT 1)
      SELECT (CURRENT_DATE - pr.pr_date)::int AS pr_days,
             (CURRENT_DATE - pr.po_wo_date)::int AS po_days,
             (pr.po_wo_no IS NOT NULL AND btrim(pr.po_wo_no) <> '') AS has_po
      FROM procurement_records pr
      WHERE NOT EXISTS (SELECT 1 FROM cfg, unnest(cfg.cl) x WHERE public.p4b_norm(x) = public.p4b_norm(pr.order_status))
        ${scope === null ? Prisma.empty : Prisma.sql`AND pr.region_id = ANY(${scope}::int[])`}
        ${region ? Prisma.sql`AND pr.region_id = ${region}` : Prisma.empty}`);
    // a waiting PR has no PO/WO yet; a waiting PO is an open order with a PO/WO date
    const prWait = rows
      .filter((r) => !r.has_po && r.pr_days !== null)
      .map((r) => r.pr_days!);
    const poWait = rows
      .filter((r) => r.has_po && r.po_days !== null)
      .map((r) => r.po_days!);
    return {
      open_total: rows.length,
      pr_wait: bucketAges(prWait),
      po_wait: bucketAges(poWait),
    };
  }

  /** The materials position: the receive rate over every required line and the shortage lines with their contractor. */
  /**
   * Phase scope (0.15.367): the registered, not cancelled sites per project phase (sites.project_phase) and how many are on air (the approved
   * On-Air task, as the monthly counter reads it). Only the sites table and its tasks are read, no typed number. monthly_on_air_auto is the
   * target the monthly On-Air counter is measured against when no manual override is on.
   */
  private async phaseSection(
    scope: number[] | null,
    region: number | null,
    adv: Prisma.Sql | null,
  ) {
    const siteWhere = Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND s.region_id = ${region}` : Prisma.empty}
      ${adv ? Prisma.sql`AND ${adv}` : Prisma.empty}`;
    const rows = await this.db.tx.$queryRaw<
      (Omit<PhaseScopeRow, "sites" | "completed" | "in_progress" | "not_started" | "on_hold" | "on_air"> & {
        sites: bigint; completed: bigint; in_progress: bigint; not_started: bigint; on_hold: bigint; on_air: bigint;
      })[]
    >(Prisma.sql`
      SELECT nullif(btrim(s.project_phase), '') AS phase,
             count(*) AS sites,
             count(*) FILTER (WHERE s.overall_status = 'completed') AS completed,
             count(*) FILTER (WHERE s.overall_status = 'in_progress') AS in_progress,
             count(*) FILTER (WHERE s.overall_status = 'not_started') AS not_started,
             count(*) FILTER (WHERE s.overall_status = 'on_hold') AS on_hold,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
               WHERE ti.site_id = s.id AND td.code = 'MS6' AND ti.state::text = 'approved')) AS on_air
      FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}
      GROUP BY 1`);
    const summary = phaseScope(
      rows.map((r) => ({
        phase: r.phase, sites: Number(r.sites), completed: Number(r.completed), in_progress: Number(r.in_progress),
        not_started: Number(r.not_started), on_hold: Number(r.on_hold), on_air: Number(r.on_air),
      })),
    );
    const monthly = await monthlyOnAirTarget(this.db, siteWhere);
    return {
      ...summary,
      monthly_on_air_auto: monthly,
    };
  }

  private async materialsSection(
    scope: number[] | null,
    region: number | null,
    adv: Prisma.Sql | null,
  ): Promise<{
    receive_pct: number | null;
    required_total: number;
    dispatched_total: number;
    sites_short: number;
    top_shortages: {
      site_id: string;
      site_code: string;
      item_code: string;
      item_name: string;
      missing: number;
      required: number;
      dispatched: number;
      contractor: string | null;
    }[];
    by_contractor: {
      party_id: string | null;
      name: string;
      sites: number;
      missing_lines: number;
      missing_qty: number;
    }[];
  }> {
    const siteWhere = Prisma.sql`
      ${scope === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${scope}::int[])`}
      ${region ? Prisma.sql`AND s.region_id = ${region}` : Prisma.empty}
      ${adv ? Prisma.sql`AND ${adv}` : Prisma.empty}`;
    const totals = await this.db.tx.$queryRaw<
      { required: number; dispatched: number }[]
    >(Prisma.sql`
      SELECT coalesce(sum(q.required), 0)::float8 AS required, coalesce(sum(q.dispatched), 0)::float8 AS dispatched
      FROM warehouse_site_qty q JOIN sites s ON s.id = q.site_id
      WHERE q.required > 0 AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`);
    const short = await this.db.tx.$queryRaw<ShortageRow[]>(Prisma.sql`
      SELECT s.id::text AS site_id, s.site_code, i.item_code, i.name AS item_name, i.item_group,
             q.required::float8 AS required, q.dispatched::float8 AS dispatched,
             (q.required - q.dispatched)::float8 AS missing,
             (SELECT p.party_id::text FROM procurement_records p
              WHERE p.site_id = s.id AND p.party_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM contractor_rules cr, unnest(cr.closed_order_statuses) x
                                WHERE public.p4b_norm(x) = public.p4b_norm(p.order_status))
              ORDER BY p.po_wo_date DESC NULLS LAST, p.pr_date DESC NULLS LAST LIMIT 1) AS party_id
      FROM warehouse_site_qty q
      JOIN sites s ON s.id = q.site_id
      JOIN warehouse_items i ON i.id = q.item_id
      WHERE q.required > q.dispatched AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}
      ORDER BY missing DESC, s.site_code COLLATE "C", i.item_code COLLATE "C"`);
    const partyIds = [...new Set(short.map((r) => r.party_id).filter((x): x is string => x !== null))];
    const parties = partyIds.length
      ? await this.db.tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
          SELECT id::text, name FROM external_parties WHERE id = ANY(${partyIds}::uuid[])`)
      : [];
    const nameOf = new Map(parties.map((x) => [x.id, x.name]));
    const byParty = new Map<
      string | null,
      { sites: Set<string>; missing_lines: number; missing_qty: number }
    >();
    for (const r of short) {
      const cur = byParty.get(r.party_id) ?? {
        sites: new Set<string>(),
        missing_lines: 0,
        missing_qty: 0,
      };
      cur.sites.add(r.site_id);
      cur.missing_lines += 1;
      cur.missing_qty += r.missing;
      byParty.set(r.party_id, cur);
    }
    const by_contractor = [...byParty.entries()]
      .map(([party_id, v]) => ({
        party_id,
        name: party_id ? (nameOf.get(party_id) ?? "") : "",
        sites: v.sites.size,
        missing_lines: v.missing_lines,
        missing_qty: Math.round(v.missing_qty * 100) / 100,
      }))
      .sort((a, b) => b.missing_qty - a.missing_qty || a.name.localeCompare(b.name))
      .slice(0, 10);
    return {
      receive_pct: receivePct(
        totals[0]?.required ?? 0,
        totals[0]?.dispatched ?? 0,
      ),
      required_total: Math.round((totals[0]?.required ?? 0) * 100) / 100,
      dispatched_total: Math.round((totals[0]?.dispatched ?? 0) * 100) / 100,
      sites_short: new Set(short.map((r) => r.site_id)).size,
      top_shortages: short.slice(0, 10).map((r) => ({
        site_id: r.site_id,
        site_code: r.site_code,
        item_code: r.item_code,
        item_name: r.item_name,
        missing: Math.round(r.missing * 100) / 100,
        required: Math.round(r.required * 100) / 100,
        dispatched: Math.round(r.dispatched * 100) / 100,
        contractor: r.party_id ? (nameOf.get(r.party_id) ?? null) : null,
      })),
      by_contractor,
    };
  }
}

/** The intersection of two region scopes (null = every region), as in dashboard-extras.service.ts. */
function intersect(a: number[] | null, b: number[] | null): number[] | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((r) => b.includes(r)).sort((x, y) => x - y);
}
