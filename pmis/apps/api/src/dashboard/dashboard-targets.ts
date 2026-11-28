import { Prisma } from "@prisma/client";
import { autoMonthlyOnAir, targetInForce } from "./dashboard-ops.rules";

/** The part of the database service the target helper needs (the transaction client). */
export interface TargetDb {
  tx: { $queryRaw<T>(q: Prisma.Sql): Promise<T> };
}

export interface MonthlyOnAirTarget {
  /** The target in force: the typed number when the manual override is on and a number is set, else the derived one. */
  value: number | null;
  source: "derived" | "manual";
  /** The derived value, always computed, also while a typed one is in force. */
  derived: number | null;
  remaining: number;
  planned_end: string | null;
  months_left: number | null;
}

/**
 * The monthly On-Air target of a scope (contract 0.15.367): derived from the scope (the sites not yet on air over the months left to the latest planned
 * date of the On-Air task, MS6), unless the manual override of dashboard.target_policy is on and Settings > Dashboard holds a number. `siteWhere` is the
 * caller's scope on `sites s` joined with `clusters c`, the same fragment the other dashboard figures use.
 */
export async function monthlyOnAirTarget(db: TargetDb, siteWhere: Prisma.Sql): Promise<MonthlyOnAirTarget> {
  const counts = (
    await db.tx.$queryRaw<{ sites: bigint; on_air: bigint }[]>(Prisma.sql`
      SELECT count(*) AS sites,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
               WHERE ti.site_id = s.id AND td.code = 'MS6' AND ti.state::text = 'approved')) AS on_air
      FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`)
  )[0]!;
  const end = (
    await db.tx.$queryRaw<{ planned_end: string | null; today: string }[]>(Prisma.sql`
      SELECT max(ti.planned_date)::text AS planned_end, cal_today()::text AS today
      FROM task_instances ti
      JOIN task_definitions td ON td.id = ti.task_def_id
      JOIN sites s ON s.id = ti.site_id
      LEFT JOIN clusters c ON c.id = s.cluster_id
      WHERE td.code = 'MS6' AND s.is_active AND s.overall_status <> 'cancelled' ${siteWhere}`)
  )[0]!;
  const pol = (
    await db.tx.$queryRaw<{ override: boolean; manual: string | null }[]>(Prisma.sql`
      SELECT coalesce((dashboard_target_policy_state() ->> 'manual_override')::boolean, false) AS override,
             (dashboard_settings_json() -> 'targets' ->> 'monthly_on_air') AS manual`)
  )[0]!;
  const remaining = Number(counts.sites) - Number(counts.on_air);
  const auto = autoMonthlyOnAir(remaining, end.planned_end, end.today);
  const k = targetInForce(pol.override, pol.manual === null ? null : Number(pol.manual), auto.value);
  return { ...k, derived: auto.value, remaining, planned_end: end.planned_end, months_left: auto.months_left };
}
