import type { components } from '@/api/schema';

type Node = components['schemas']['PipelineNode'];

export interface GanttRow { code: string; node: Node; baseline: number | null; planned: number | null; actual: number | null }
export interface GanttModel { rows: GanttRow[]; min: number; max: number }

const day = (d?: string | null): number | null => {
  if (!d) return null;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
};

/** Read-only timeline model from the pipeline dates the site endpoint already returns: baseline, planned and actual per stage (day numbers). Stages with no date are left out. */
export function buildGantt(pipeline: Node[] | undefined): GanttModel | null {
  const rows = (pipeline ?? [])
    .filter((n) => n.state !== 'na')
    .map((n) => ({ code: n.code, node: n, baseline: day(n.baseline_date), planned: day(n.planned_date), actual: day(n.actual_date) }))
    .filter((r) => r.baseline !== null || r.planned !== null || r.actual !== null);
  if (!rows.length) return null;
  const all = rows.flatMap((r) => [r.baseline, r.planned, r.actual]).filter((x): x is number => x !== null);
  return { rows, min: Math.min(...all), max: Math.max(...all) };
}

/** Position 0..100 of a day on the model's span. */
export function pos(model: GanttModel, d: number): number {
  const span = Math.max(model.max - model.min, 1);
  return ((d - model.min) / span) * 100;
}
