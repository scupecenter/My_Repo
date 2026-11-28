/**
 * The agile indicators of the dashboard card (burn-up, cumulative flow, velocity, cone of uncertainty). They read the
 * frozen per-site weekly snapshots, summed per date by `GET /project-status/agile-trend`: the Project Status items done
 * and applicable (the scope), the planned items, and the sites by overall status. The completion percentage of the
 * card stays the weighted figure of the snapshots; these charts show the same work in items and sites, and the last
 * date of both reads the same snapshot date. Pure and unit tested.
 */

export interface AgileRow {
  taken_on: string;
  sites: number;
  by_status: Record<string, number>;
  items_done: number;
  items_applicable: number;
  items_planned: number;
}

const DAY = 86_400_000;
const dayMs = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Rows oldest first, one per date. */
export const agileRows = (rows: AgileRow[]): AgileRow[] => [...new Map(rows.map((r) => [r.taken_on, r])).values()].sort((a, b) => (a.taken_on < b.taken_on ? -1 : 1));

/** Burn-up: done against the total scope; a change of the scope between two dates is listed (added when positive). */
export function burnupSeries(rows: AgileRow[]): { date: string; done: number; scope: number; planned: number; scopeChange: number }[] {
  const s = agileRows(rows);
  return s.map((r, i) => ({ date: r.taken_on, done: r.items_done, scope: r.items_applicable, planned: r.items_planned, scopeChange: i === 0 ? 0 : r.items_applicable - s[i - 1].items_applicable }));
}

/** Items done per week between every two dates (the gap is normalised by its days; never negative: a drop is a scope or data correction). */
export function weeklyDone(rows: AgileRow[]): { date: string; done: number }[] {
  const s = agileRows(rows);
  const out: { date: string; done: number }[] = [];
  for (let i = 1; i < s.length; i += 1) {
    const days = (dayMs(s[i].taken_on) - dayMs(s[i - 1].taken_on)) / DAY;
    if (days <= 0) continue;
    out.push({ date: s[i].taken_on, done: Math.max(0, ((s[i].items_done - s[i - 1].items_done) / days) * 7) });
  }
  return out;
}

/** The mean of the last `window` weekly figures (the same window as the S-curve velocity), or null with none. */
export function meanDone(weeks: { done: number }[], window: number): number | null {
  const last = weeks.slice(-Math.max(1, window));
  return last.length ? last.reduce((a, b) => a + b.done, 0) / last.length : null;
}

/** The statuses of the flow in order: the known ones first, then any other code. */
const ORDER = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
export function flowStatuses(rows: AgileRow[]): string[] {
  const seen = new Set(rows.flatMap((r) => Object.keys(r.by_status)));
  return [...ORDER.filter((c) => seen.has(c)), ...[...seen].filter((c) => !ORDER.includes(c)).sort()];
}

/** Cumulative flow: the sites by overall status per date, stacked to the total of sites of that date. */
export function flowSeries(rows: AgileRow[]): { statuses: string[]; dates: string[]; counts: Record<string, number[]> } {
  const s = agileRows(rows);
  const statuses = flowStatuses(s);
  return { statuses, dates: s.map((r) => r.taken_on), counts: Object.fromEntries(statuses.map((c) => [c, s.map((r) => r.by_status[c] ?? 0)])) };
}

/** The date `done` reaches `scope` at `rate` items per week, from the last date; null when the rate is not positive. */
export function finishDate(last: AgileRow, rate: number | null): string | null {
  if (last.items_done >= last.items_applicable) return last.taken_on;
  if (rate === null || rate <= 0.0001) return null;
  return iso(dayMs(last.taken_on) + Math.ceil(((last.items_applicable - last.items_done) / rate) * 7) * DAY);
}

export interface Cone {
  dates: string[];
  /** The done line if the pace of the best recent week continues, the mean pace and the worst recent week (never below the mean of the slowest half). */
  fast: (number | null)[];
  mean: (number | null)[];
  slow: (number | null)[];
  scope: number;
  finish: { fast: string | null; mean: string | null; slow: string | null };
}

/**
 * Cone of uncertainty: from the last date, the done line at the fastest, the mean and the slowest weekly pace of the last
 * `window` weeks, one point per week until the fast line reaches the scope (at most `maxWeeks`). The cone widens with time.
 */
export function coneForecast(rows: AgileRow[], window: number, maxWeeks = 52): Cone | null {
  const s = agileRows(rows);
  const last = s[s.length - 1];
  if (!last) return null;
  const recent = weeklyDone(s).slice(-Math.max(1, window)).map((w) => w.done);
  if (!recent.length) return null;
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const fast = Math.max(...recent);
  const slow = Math.min(...recent);
  const scope = last.items_applicable;
  const dates: string[] = [last.taken_on];
  const line = (): (number | null)[] => [last.items_done];
  const lines = { fast: line(), mean: line(), slow: line() };
  let w = 0;
  while (w < maxWeeks && (lines.fast[lines.fast.length - 1] ?? 0) < scope) {
    w += 1;
    dates.push(iso(dayMs(last.taken_on) + w * 7 * DAY));
    (Object.entries({ fast, mean, slow }) as [keyof typeof lines, number][]).forEach(([k, rate]) => lines[k].push(Math.min(scope, last.items_done + rate * w)));
  }
  return { dates, ...lines, scope, finish: { fast: finishDate(last, fast), mean: finishDate(last, mean), slow: finishDate(last, slow) } };
}
