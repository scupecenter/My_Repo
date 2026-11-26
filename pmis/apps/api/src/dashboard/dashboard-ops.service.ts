import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { Query } from "../common/query";
import { DbService } from "../db/db.service";
import { FilterCatalogService } from "../views/filter-catalog.service";
import { dashboardParams } from "./dashboard.service";
import { AgeBuckets, bucketAges, receivePct } from "./dashboard-ops.rules";

interface OrderAges {
  pr_days: number | null;
  po_days: number | null;
  has_po: boolean;
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
 * GET /dashboard/ops (contract 0.15.96): the follow-up sections of the dashboard beyond F13. First section: procurement
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
 */
@Injectable()
export class DashboardOpsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly filters: FilterCatalogService,
  ) {}

  async get(_auth: AuthContext, q: Query): Promise<Record<string, unknown>> {
    const dash = await this.access.requireRegions("dashboard", "view");
    const p = dashboardParams(q);
    await this.access.requireDashboardTab(p.view);
    const procRegions = await this.access.regions("procurement", "view");
    const whRegions = await this.access.regions("warehouse", "view");
    const procScope = intersect(dash, procRegions);
    const whScope = intersect(dash, whRegions);
    const procOk = procRegions === null || procRegions.length > 0;
    const whOk = whRegions === null || whRegions.length > 0;

    const orders = procOk ? await this.ordersSection(procScope, p.region_id ?? null) : null;
    const adv = whOk ? await this.filters.fromQuery("dashboard", q) : null;
    const materials = whOk
      ? await this.materialsSection(whScope, p.region_id ?? null, adv)
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
    };
  }

  /** The open orders with their PR and PO ages, bucketed in the rules. */
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
