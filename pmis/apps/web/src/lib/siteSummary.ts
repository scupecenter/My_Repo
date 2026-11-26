import type { components } from '@/api/schema';

type Node = components['schemas']['PipelineNode'];

export interface SiteSummary {
  done: number;
  total: number;
  current: Node | null;
  late: Node[];
  nextPlanned: { node: Node; date: string } | null;
}

/** Summary of a site from its pipeline (already returned by the site endpoint): counts, current stage, late stages, next planned date. Not-applicable stages are left out. */
export function summarizePipeline(pipeline: Node[] | undefined): SiteSummary {
  const nodes = (pipeline ?? []).filter((n) => n.state !== 'na');
  const done = nodes.filter((n) => n.state === 'done').length;
  const current = nodes.find((n) => n.state === 'current' || n.state === 'late') ?? null;
  const late = nodes.filter((n) => n.state === 'late');
  const upcoming = nodes
    .filter((n) => n.state !== 'done' && n.planned_date)
    .sort((a, b) => (a.planned_date as string).localeCompare(b.planned_date as string))[0];
  return { done, total: nodes.length, current, late, nextPlanned: upcoming ? { node: upcoming, date: upcoming.planned_date as string } : null };
}
