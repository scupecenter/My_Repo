import type { WeightSet } from '@/api/types';

export type WeightIssue = { level: 'activities' | 'items'; activity?: string; sum: number };
const r = (n: number) => Math.round(n * 1000) / 1000;
/** Sum of weights, rounded to the 3 decimals the contract allows. */
export const sumOf = (ws: number[]) => r(ws.reduce((a, x) => a + x, 0));

/** Weights must add up to 100% at each level (the activities, then the items inside each activity that has items). */
export function weightIssues(set: Pick<WeightSet, 'activities'>): WeightIssue[] {
  const out: WeightIssue[] = [];
  const top = sumOf(set.activities.map((x) => x.weight));
  if (top !== 100) out.push({ level: 'activities', sum: top });
  for (const a of set.activities) {
    if (!a.items.length) continue;
    const s = sumOf(a.items.map((i) => i.weight));
    if (s !== 100) out.push({ level: 'items', activity: a.code, sum: s });
  }
  return out;
}
