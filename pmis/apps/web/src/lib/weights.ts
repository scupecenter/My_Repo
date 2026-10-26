import type { WeightSet } from '@/api/types';

export type WeightIssue = { level: 'activities' | 'items'; activity?: string; sum: number };
const r = (n: number) => Math.round(n * 1000) / 1000;

/** Weights must add up to 100% at each level (the activities, then the items inside each activity that has items). */
export function weightIssues(set: Pick<WeightSet, 'activities'>): WeightIssue[] {
  const out: WeightIssue[] = [];
  const top = r(set.activities.reduce((a, x) => a + x.weight, 0));
  if (top !== 100) out.push({ level: 'activities', sum: top });
  for (const a of set.activities) {
    if (!a.items.length) continue;
    const s = r(a.items.reduce((n, i) => n + i.weight, 0));
    if (s !== 100) out.push({ level: 'items', activity: a.code, sum: s });
  }
  return out;
}
