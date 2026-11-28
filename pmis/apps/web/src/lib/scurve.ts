/**
 * The S-curve figures of the dashboard card (owner approval 2026-11-26, dashboard proposals item 2): the weekly
 * velocity of the saved Project Status snapshots and the forecast date the actual curve reaches 100 % at that
 * velocity. Pure and unit tested; the snapshots are the frozen weekly values of `GET /project-status/snapshots`,
 * never recomputed, so the card does no heavier math than this.
 */

export interface ScurvePoint {
  /** Snapshot date, ISO `YYYY-MM-DD`. */
  date: string;
  /** Actual progress % frozen at the date; a snapshot without a figure is skipped. */
  actual: number | null;
  planned?: number | null;
}

/** How the weekly pace is taken (setting `dashboard.forecast_method`, contract 0.15.474): the mean weekly gain, or the slope of a straight line fitted through the actual points. */
export type ForecastMethod = 'mean' | 'linear';

/** The gaps the velocity averages (the last four real week gaps). */
export const VELOCITY_WINDOW = 4;

const DAY = 86_400_000;
const dayMs = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();

/** The points that carry an actual figure, oldest first, one row per date (a later row of the same date wins). */
export function scurveSeries(points: ScurvePoint[]): { date: string; actual: number; planned: number | null }[] {
  const byDate = new Map<string, { actual: number; planned: number | null }>();
  for (const p of points) {
    if (p.actual === null || p.actual === undefined) continue;
    byDate.set(p.date, { actual: p.actual, planned: p.planned ?? null });
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({ date, ...v }));
}

/**
 * The mean weekly gain of the actual curve over the last `window` real gaps (percent per week; a gap longer or
 * shorter than a week is normalised by its days). Null with fewer than two figures.
 */
export function weeklyVelocity(points: ScurvePoint[], window = VELOCITY_WINDOW, method: ForecastMethod = 'mean'): number | null {
  const s = scurveSeries(points);
  if (method === 'linear') return linearVelocity(s, window);
  const rates: number[] = [];
  for (let i = 1; i < s.length; i += 1) {
    const days = (dayMs(s[i].date) - dayMs(s[i - 1].date)) / DAY;
    if (days <= 0) continue;
    rates.push(((s[i].actual - s[i - 1].actual) / days) * 7);
  }
  const last = rates.slice(-Math.max(1, window));
  if (!last.length) return null;
  return last.reduce((a, b) => a + b, 0) / last.length;
}

/**
 * The date the actual curve reaches 100 % when it keeps the given weekly velocity, ISO `YYYY-MM-DD`, rounded up to
 * a whole day. Null when the velocity is unknown or not positive; the last snapshot date when the curve is done.
 */
export function forecastFull(points: ScurvePoint[], velocity: number | null): string | null {
  const s = scurveSeries(points);
  if (!s.length) return null;
  const last = s[s.length - 1];
  if (last.actual >= 100) return last.date;
  if (velocity === null || velocity <= 0.0001) return null;
  const ms = dayMs(last.date) + Math.ceil(((100 - last.actual) / velocity) * 7) * DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The slope, in percent per week, of the least squares line through the actual points of the last `window` real gaps (so `window + 1` points).
 * Null with fewer than two points or when all the points share one date.
 */
function linearVelocity(s: { date: string; actual: number }[], window: number): number | null {
  const pts = s.slice(-(Math.max(1, window) + 1));
  if (pts.length < 2) return null;
  const x = pts.map((p) => (dayMs(p.date) - dayMs(pts[0].date)) / DAY);
  const y = pts.map((p) => p.actual);
  const n = pts.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const sxx = x.reduce((a, b) => a + (b - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = x.reduce((a, b, i) => a + (b - mx) * (y[i] - my), 0);
  return (sxy / sxx) * 7;
}
