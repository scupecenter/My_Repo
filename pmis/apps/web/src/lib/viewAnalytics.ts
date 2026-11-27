/**
 * Free analytics on any view (item 8 of the improvement report): a count breakdown and number totals computed from the rows the view has
 * already loaded, so it adds no request, no permission and no hidden field. Pure functions, tested in viewAnalytics.test.ts.
 */
export type Slice = { key: string; label: string; count: number; share: number };
export type NumberStats = { n: number; sum: number; avg: number; min: number; max: number };

/** Largest number of slices drawn; the rest are merged into one "Other" slice by the caller's label. */
export const MAX_SLICES = 8;

/** Counts the rows by `valueOf` (empty value = `emptyLabel`), largest first, ties by label; at most `max` slices, the tail merged into `otherLabel`. */
export function breakdown<T>(rows: readonly T[], valueOf: (r: T) => string, emptyLabel: string, otherLabel: string, max = MAX_SLICES): Slice[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = valueOf(r).trim() || emptyLabel;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const total = rows.length || 1;
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = all.slice(0, max);
  const tail = all.slice(max).reduce((s, [, c]) => s + c, 0);
  const out = head.map(([label, count], i) => ({ key: `s${i}`, label, count, share: count / total }));
  if (tail > 0) out.push({ key: 'other', label: otherLabel, count: tail, share: tail / total });
  return out;
}

/** Sum, average, smallest and largest of the numeric values; null when no row has a number. Text that is not a finite number is skipped. */
export function numberStats<T>(rows: readonly T[], valueOf: (r: T) => unknown): NumberStats | null {
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (const r of rows) {
    const raw = valueOf(r);
    if (raw === null || raw === undefined || raw === '') continue;
    const v = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(v)) continue;
    n++; sum += v; if (v < min) min = v; if (v > max) max = v;
  }
  return n ? { n, sum, avg: sum / n, min, max } : null;
}

export type MeasureSlice = { key: string; label: string; value: number };

/**
 * The chart mode's slices (decision V4): like `breakdown`, but each row adds `weightOf(r)` (1 for a count, the field's number for a sum) to its
 * slice instead of counting rows. Non-finite and empty weights count as 0. Largest first, ties by label; the tail merges into `otherLabel`.
 */
export function measureBreakdown<T>(rows: readonly T[], valueOf: (r: T) => string, weightOf: (r: T) => unknown, emptyLabel: string, otherLabel: string, max = MAX_SLICES): MeasureSlice[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const v = valueOf(r).trim() || emptyLabel;
    const raw = weightOf(r);
    const w = raw === null || raw === undefined || raw === '' ? 0 : (typeof raw === 'number' ? raw : Number(raw));
    sums.set(v, (sums.get(v) ?? 0) + (Number.isFinite(w) ? w : 0));
  }
  const all = [...sums.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = all.slice(0, max);
  const tail = all.slice(max).reduce((s, [, c]) => s + c, 0);
  const out = head.map(([label, value], i) => ({ key: `s${i}`, label, value }));
  if (all.length > max) out.push({ key: 'other', label: otherLabel, value: tail });
  return out;
}
