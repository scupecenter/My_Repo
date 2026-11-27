/**
 * Free analytics on any view (item 8 of the PM-platforms report): a count breakdown and number totals computed from the rows the view has
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
