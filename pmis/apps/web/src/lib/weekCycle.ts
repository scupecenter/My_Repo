import type { DailyPlanDay, DailyPlanRow } from '@/api/dailyPlan';

/**
 * The weekly cycle plan (item 10): the seven days of a week of My Work > Daily Plan side by side, and the carry-over of the rows that fell below target to
 * the next working day. Everything is computed from the daily plans the server already returns (GET /daily-plans, one call per day); the carry-over adds
 * sites to the next day's plan with the existing add-site call, so the daily plan's own rights, locks and region rules decide (no new permission).
 */
export type CellState = 'none' | 'planned' | 'below' | 'done';
export interface WeekRow { site_id: string; site_code: string; site_name: string; region_id: number; cells: Record<string, CellState> }
export interface CarryItem { site_id: string; site_code: string; region_id: number }

const day = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** The week that holds `date`, seven ISO dates from `weekStart` (0 = Sunday, the first day of the Libyan work week; 1 = Monday). */
export function weekDays(date: string, weekStart = 0): string[] {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const first = day(date, -((dow - weekStart + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => day(first, i));
}

export const shiftWeek = (date: string, weeks: number): string => day(date, 7 * weeks);

/** How one row stands on one day: below target, planned (today or later, or nothing recorded as missing), or done. */
export function cellState(r: DailyPlanRow, today: string, date: string): CellState {
  if (r.below_target) return 'below';
  return date > today ? 'planned' : 'done';
}

/** One row per site that appears on any day of the week, with its state per day ('none' where it is not in that day's plan). `days` maps a date to its plan. */
export function buildWeek(dates: string[], days: Record<string, DailyPlanDay | undefined>, regions: number[], today: string): WeekRow[] {
  const rows = new Map<string, WeekRow>();
  for (const d of dates) {
    for (const r of days[d]?.rows ?? []) {
      if (regions.length && !regions.includes(r.region_id)) continue;
      let w = rows.get(r.site_id);
      if (!w) { w = { site_id: r.site_id, site_code: r.site_code, site_name: r.site_name ?? '', region_id: r.region_id, cells: Object.fromEntries(dates.map((x) => [x, 'none' as CellState])) }; rows.set(r.site_id, w); }
      w.cells[d] = cellState(r, today, d);
    }
  }
  return [...rows.values()].sort((a, b) => a.site_code.localeCompare(b.site_code));
}

/** The rows of `from` that are below target and not yet in the plan of `to`: what a carry-over would add. */
export function carryCandidates(from: DailyPlanDay | undefined, to: DailyPlanDay | undefined, regions: number[]): CarryItem[] {
  const there = new Set((to?.rows ?? []).map((r) => r.site_id));
  return (from?.rows ?? [])
    .filter((r) => r.below_target && !there.has(r.site_id) && (!regions.length || regions.includes(r.region_id)))
    .map((r) => ({ site_id: r.site_id, site_code: r.site_code, region_id: r.region_id }));
}

/** Totals of a day for the column header. */
export function dayTotals(d: DailyPlanDay | undefined, regions: number[]): { rows: number; below: number } {
  const rows = (d?.rows ?? []).filter((r) => !regions.length || regions.includes(r.region_id));
  return { rows: rows.length, below: rows.filter((r) => r.below_target).length };
}
