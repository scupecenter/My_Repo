import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const pct = z.object({ amber: z.number().int().min(0).max(100), red: z.number().int().min(0).max(100) }).strict();
const days = z.object({ amber: z.number().int().min(0).max(365), red: z.number().int().min(0).max(365) }).strict();
const thresholdsSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  thresholds: z.object({
    min_sample: z.number().int().min(1).max(100),
    snag_overdue_pct: pct, snag_return_pct: pct, quality_fail_pct: pct, contract_expiry_days: days,
  }).strict(),
}).strict();

export type Level = 'ok' | 'amber' | 'red' | 'insufficient';
interface Pair { amber: number; red: number }
export interface Thresholds {
  min_sample: number; snag_overdue_pct: Pair; snag_return_pct: Pair; quality_fail_pct: Pair; contract_expiry_days: Pair;
}
interface ThresholdsJson { thresholds: Thresholds; updated_at: string | null; updated_by: string | null; version: number; can_edit: boolean }

interface Row {
  party_id: string; name: string; type: string; is_active: boolean;
  issues_total: number; issues_open: number; delay_days: number;
  snags_total: number; snags_open: number; snags_overdue: number; snags_returned: number;
  quality_total: number; quality_failed: number;
  orders_total: number; orders_open: number;
  contracts_active: number; contract_end: string | null; days_left: number | null;
}

const RANK: Record<Level, number> = { insufficient: 0, ok: 1, amber: 2, red: 3 };

/** A percentage measure: the share of `part` in `total`; "insufficient" below the least sample, else amber at or above amber and red at or above red. */
export function pctLevel(part: number, total: number, t: Pair, minSample: number): { pct: number | null; level: Level } {
  if (total <= 0) return { pct: null, level: 'insufficient' };
  const p = Math.round((part * 1000) / total) / 10;
  if (total < minSample) return { pct: p, level: 'insufficient' };
  return { pct: p, level: p >= t.red ? 'red' : p >= t.amber ? 'amber' : 'ok' };
}

/** Days left to the end of the nearest active contract: amber at or below amber, red at or below red (an ended contract is red). */
export function expiryLevel(daysLeft: number | null, t: Pair): Level {
  if (daysLeft === null) return 'insufficient';
  return daysLeft <= t.red ? 'red' : daysLeft <= t.amber ? 'amber' : 'ok';
}

export function overall(levels: Level[]): Level {
  const known = levels.filter((l) => l !== 'insufficient');
  if (!known.length) return 'insufficient';
  return known.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/**
 * Contractor performance (migration 0180): computed on read from data that already exists, nothing is typed by a person and nothing is stored.
 *   delay days and issues  from `issues` of the party; snags from `snags` (responsible party; cancelled ones are not counted); quality from
 *   `quality_inspections` (a result of Pass or Fail counts, N/A and Pending do not); orders from `procurement_records` (open = the order status is
 *   not one of the closing statuses of the contractor rules); contract from the active rows of `external_party_contracts`, else the party's own end date.
 * The rows are those the caller's regions let it read (row security). The thresholds are the setting `contractors.performance`, edited in Settings.
 */
@Injectable()
export class ContractorPerformanceService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async thresholdsJson(): Promise<ThresholdsJson> {
    const r = await this.db.tx.$queryRaw<{ j: ThresholdsJson }[]>(Prisma.sql`SELECT contractor_perf_thresholds_json() AS j`);
    return r[0]!.j;
  }

  private async dto(j: ThresholdsJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { thresholds: j.thresholds, updated_at: j.updated_at, updated_by, version: j.version, can_edit: j.can_edit };
  }

  async getThresholds(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'contractors');
    return this.dto(await this.thresholdsJson());
  }

  async putThresholds(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(thresholdsSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: ThresholdsJson }[]>(Prisma.sql`
      SELECT admin_set_contractor_perf_thresholds(${JSON.stringify(b.thresholds)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }

  async report(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'contractors');
    return this.reportData();
  }

  /**
   * The report without the module gate, for surfaces that gate on their own: the scorecard section of
   * GET /dashboard/ops (0.15.202, item 5) answers available false when the caller lacks contractors view. Same rows,
   * same rules, so the dashboard card and this screen never disagree.
   */
  async reportData() {
    const th = await this.thresholdsJson();
    const t = th.thresholds;
    const rows = await this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      WITH cfg AS (SELECT closed_order_statuses AS cl FROM contractor_rules LIMIT 1),
      iss AS (SELECT party_id, count(*)::int AS total, (count(*) FILTER (WHERE status::text <> 'closed'))::int AS open, coalesce(sum(delay_days), 0)::int AS delay
              FROM issues WHERE party_id IS NOT NULL GROUP BY party_id),
      sn AS (SELECT responsible_party_id AS party_id, count(*)::int AS total,
                    (count(*) FILTER (WHERE status::text NOT IN ('closed', 'cancelled')))::int AS open,
                    (count(*) FILTER (WHERE target_date IS NOT NULL AND ((status::text NOT IN ('closed', 'cancelled') AND target_date < CURRENT_DATE)
                                                                        OR (status::text = 'closed' AND closed_at::date > target_date))))::int AS overdue,
                    (count(*) FILTER (WHERE return_count > 0))::int AS returned
             FROM snags WHERE responsible_party_id IS NOT NULL AND status::text <> 'cancelled' GROUP BY responsible_party_id),
      q AS (SELECT party_id, count(*)::int AS total, (count(*) FILTER (WHERE lower(btrim(result)) = 'fail'))::int AS failed
            FROM quality_inspections WHERE party_id IS NOT NULL AND lower(btrim(result)) IN ('pass', 'fail') GROUP BY party_id),
      o AS (SELECT pr.party_id, count(*)::int AS total,
                   (count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM cfg, unnest(cfg.cl) x WHERE public.p4b_norm(x) = public.p4b_norm(pr.order_status))))::int AS open
            FROM procurement_records pr WHERE pr.party_id IS NOT NULL GROUP BY pr.party_id),
      c AS (SELECT party_id, (count(*))::int AS active, min(end_date) FILTER (WHERE end_date IS NOT NULL) AS end_date
            FROM external_party_contracts WHERE status = 'active' GROUP BY party_id)
      SELECT p.id::text AS party_id, p.name, p.type::text AS type, p.is_active,
        coalesce(iss.total, 0) AS issues_total, coalesce(iss.open, 0) AS issues_open, coalesce(iss.delay, 0) AS delay_days,
        coalesce(sn.total, 0) AS snags_total, coalesce(sn.open, 0) AS snags_open, coalesce(sn.overdue, 0) AS snags_overdue, coalesce(sn.returned, 0) AS snags_returned,
        coalesce(q.total, 0) AS quality_total, coalesce(q.failed, 0) AS quality_failed,
        coalesce(o.total, 0) AS orders_total, coalesce(o.open, 0) AS orders_open,
        coalesce(c.active, 0) AS contracts_active,
        to_char(coalesce(c.end_date, p.contract_end), 'YYYY-MM-DD') AS contract_end,
        (coalesce(c.end_date, p.contract_end) - CURRENT_DATE)::int AS days_left
      FROM external_parties p LEFT JOIN iss ON iss.party_id = p.id LEFT JOIN sn ON sn.party_id = p.id LEFT JOIN q ON q.party_id = p.id
        LEFT JOIN o ON o.party_id = p.id LEFT JOIN c ON c.party_id = p.id
      WHERE p.is_active
      ORDER BY p.name`);
    const items = rows.map((r) => {
      const overdue = pctLevel(r.snags_overdue, r.snags_total, t.snag_overdue_pct, t.min_sample);
      const returned = pctLevel(r.snags_returned, r.snags_total, t.snag_return_pct, t.min_sample);
      const fail = pctLevel(r.quality_failed, r.quality_total, t.quality_fail_pct, t.min_sample);
      const expiry = expiryLevel(r.days_left, t.contract_expiry_days);
      return {
        party_id: r.party_id, name: r.name, type: r.type,
        delay_days: r.delay_days, issues_total: r.issues_total, issues_open: r.issues_open,
        snags: { total: r.snags_total, open: r.snags_open, overdue: r.snags_overdue, overdue_pct: overdue.pct, overdue_level: overdue.level,
                 returned: r.snags_returned, returned_pct: returned.pct, returned_level: returned.level },
        quality: { total: r.quality_total, failed: r.quality_failed, fail_pct: fail.pct, fail_level: fail.level },
        orders: { total: r.orders_total, open: r.orders_open },
        contract: { active: r.contracts_active, end_date: r.contract_end, days_left: r.days_left, level: expiry },
        level: overall([overdue.level, returned.level, fail.level, expiry]),
      };
    });
    const worst = (a: { level: Level }, b: { level: Level }) => RANK[b.level] - RANK[a.level];
    items.sort((a, b) => worst(a, b) || b.delay_days - a.delay_days || a.name.localeCompare(b.name));
    return { as_of: new Date().toISOString(), thresholds: t, items };
  }
}
