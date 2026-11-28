import type { components } from '@/api/schema';

type Node = components['schemas']['PipelineNode'];

export interface GanttRow { code: string; node: Node; baseline: number | null; planned: number | null; actual: number | null }
export interface GanttDep { from: string; to: string; fromDay: number; toDay: number; conflict: boolean }
export interface GanttCritical {
  /** Codes of the stages that can still move the finish date: every dated stage without an actual date, from the first one to the last. */
  codes: string[];
  /** The finish date (day number): the date of the last dated stage. */
  finish: number | null;
  /** The finish date the baselines give (the last baseline), and the days the finish sits after it (negative: ahead). */
  baselineFinish: number | null;
  varianceDays: number | null;
  /** Days each critical stage added to the delay on its own: its slip against baseline minus the slip of the stage before it. */
  added: Record<string, number>;
  /** The critical stage that added the most delay (more than 0), or null. */
  driver: string | null;
}
export interface GanttModel { rows: GanttRow[]; min: number; max: number; today: number | null; deps: GanttDep[]; critical: GanttCritical }

/** The date a row is drawn at for dependency lines: actual, else planned, else baseline. */
export const rowDay = (r: GanttRow): number | null => r.actual ?? r.planned ?? r.baseline;

const day = (d?: string | null): number | null => {
  if (!d) return null;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
};

/** Read-only timeline model from the pipeline dates the site endpoint already returns: baseline, planned and actual per stage (day numbers). Stages with no date are left out. */
export function buildGantt(pipeline: Node[] | undefined, todayIso?: string): GanttModel | null {
  const rows = (pipeline ?? [])
    .filter((n) => n.state !== 'na')
    .map((n) => ({ code: n.code, node: n, baseline: day(n.baseline_date), planned: day(n.planned_date), actual: day(n.actual_date) }))
    .filter((r) => r.baseline !== null || r.planned !== null || r.actual !== null);
  if (!rows.length) return null;
  const today = day(todayIso);
  const all = rows.flatMap((r) => [r.baseline, r.planned, r.actual]).filter((x): x is number => x !== null);
  if (today !== null) all.push(today);
  // Dependencies follow the workflow order the site endpoint returns: each stage or gate waits for the one before it. A line is drawn only
  // between two dated rows, and it is a conflict when the later row sits before the earlier one.
  const deps: GanttDep[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1]!; const b = rows[i]!;
    const fa = rowDay(a); const fb = rowDay(b);
    if (fa !== null && fb !== null) deps.push({ from: a.code, to: b.code, fromDay: fa, toDay: fb, conflict: fb < fa });
  }
  return { rows, min: Math.min(...all), max: Math.max(...all), today, deps, critical: criticalPath(rows) };
}

/**
 * The chain that sets the finish date. Stages wait for the one before (finish to start), so a stage already done (actual date) can no longer
 * move the finish, and every dated stage still open can. The slip of a stage is its date minus its baseline; what it added is its slip minus the
 * slip of the dated stage before it. Display only: nothing is saved and no date changes.
 */
export function criticalPath(rows: GanttRow[]): GanttCritical {
  const dated = rows.filter((r) => rowDay(r) !== null);
  const last = dated[dated.length - 1];
  const codes = dated.filter((r) => r.actual === null).map((r) => r.code);
  const finish = last ? rowDay(last) : null;
  const lastBase = [...rows].reverse().find((r) => r.baseline !== null)?.baseline ?? null;
  const added: Record<string, number> = {};
  let prevSlip = 0;
  for (const r of dated) {
    const d = rowDay(r)!;
    const slip = r.baseline !== null ? d - r.baseline : prevSlip;
    if (codes.includes(r.code)) added[r.code] = slip - prevSlip;
    prevSlip = slip;
  }
  let driver: string | null = null;
  let best = 0;
  for (const c of codes) if ((added[c] ?? 0) > best) { best = added[c]!; driver = c; }
  return { codes, finish, baselineFinish: lastBase, varianceDays: finish !== null && lastBase !== null ? finish - lastBase : null, added, driver };
}

/** Position 0..100 of a day on the model's span. */
export function pos(model: GanttModel, d: number): number {
  const span = Math.max(model.max - model.min, 1);
  return ((d - model.min) / span) * 100;
}
