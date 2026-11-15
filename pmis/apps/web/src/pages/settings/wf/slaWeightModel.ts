import type { WeightTotal } from '../../../api/workflowEditor';

export type WeightState = { counts: boolean; value: number; group: string | null };

/** The total a weight group would have after the change: the saved total, minus what this task adds now, plus what it adds after the change. */
export function projectedTotal(totals: WeightTotal[], group: string, current: WeightState, next: WeightState): number {
  const saved = totals.find((x) => x.group === group)?.total ?? 0;
  const minus = current.counts && current.group === group ? current.value : 0;
  const plus = next.counts && next.group === group ? next.value : 0;
  return Math.round((saved - minus + plus) * 1000) / 1000;
}

/** Groups that would not total 100 after the change. Shown as a warning in the draft; publishing refuses them. */
export function groupWarnings(totals: WeightTotal[], current: WeightState, next: WeightState): { group: string; total: number }[] {
  const groups = new Set(totals.map((x) => x.group));
  if (next.counts && next.group) groups.add(next.group);
  return [...groups].sort().map((g) => ({ group: g, total: projectedTotal(totals, g, current, next) })).filter((x) => x.total !== 100);
}
