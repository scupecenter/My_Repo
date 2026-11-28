/**
 * Pivot table of a register (decision 2026-11-28): the loaded rows summarised by two fields, a row field and a column field, each cell a count or
 * the sum of a number field. Pure: the screen gives the key and the label of a record on each axis, this builds the grid with its totals.
 */
export type PivotAxisValue = { key: string; label: string; raw: unknown };
export type PivotHead = { key: string; label: string; raw: unknown };
export type Pivot = {
  rows: PivotHead[];
  cols: PivotHead[];
  /** `${rowKey}\u0001${colKey}` → value */
  cells: Map<string, number>;
  rowTotals: Map<string, number>;
  colTotals: Map<string, number>;
  total: number;
  /** how many rows were counted (rows whose number is missing still count 1 in the count measure, 0 in a sum) */
  n: number;
};
export const cellKey = (r: string, c: string) => `${r}\u0001${c}`;
export const PIVOT_NONE = '';
/** At most this many heads per axis; the rest folds into "Other" so the grid stays readable. */
export const PIVOT_MAX = 12;

export function buildPivot<T>(
  rows: readonly T[],
  rowOf: (r: T) => PivotAxisValue,
  colOf: ((r: T) => PivotAxisValue) | null,
  weightOf: (r: T) => number,
  otherLabel: string,
): Pivot {
  const rh = new Map<string, PivotHead>(), ch = new Map<string, PivotHead>();
  const raw: { r: PivotAxisValue; c: PivotAxisValue; w: number }[] = [];
  const NONE_COL: PivotAxisValue = { key: '_all', label: '', raw: null };
  for (const x of rows) {
    const r = rowOf(x), c = colOf ? colOf(x) : NONE_COL, w = weightOf(x);
    if (!rh.has(r.key)) rh.set(r.key, { key: r.key, label: r.label, raw: r.raw });
    if (!ch.has(c.key)) ch.set(c.key, { key: c.key, label: c.label, raw: c.raw });
    raw.push({ r, c, w });
  }
  const sum = (m: Map<string, number>, k: string, w: number) => m.set(k, (m.get(k) ?? 0) + w);
  const weight = (k: string, side: 'r' | 'c') => raw.reduce((n, x) => n + (x[side].key === k ? Math.abs(x.w) : 0), 0);
  const top = (m: Map<string, PivotHead>, side: 'r' | 'c'): { heads: PivotHead[]; fold: Set<string> } => {
    const all = [...m.values()];
    if (all.length <= PIVOT_MAX) return { heads: all.sort(order), fold: new Set() };
    const ranked = all.map((h) => ({ h, w: weight(h.key, side) })).sort((a, b) => b.w - a.w || order(a.h, b.h));
    const keep = ranked.slice(0, PIVOT_MAX - 1).map((x) => x.h).sort(order);
    return { heads: [...keep, { key: '_other', label: otherLabel, raw: undefined }], fold: new Set(ranked.slice(PIVOT_MAX - 1).map((x) => x.h.key)) };
  };
  // the empty value always sits last
  function order(a: PivotHead, b: PivotHead) { return a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true }); }
  const R = top(rh, 'r'), C = top(ch, 'c');
  const cells = new Map<string, number>(), rowTotals = new Map<string, number>(), colTotals = new Map<string, number>();
  let total = 0;
  for (const x of raw) {
    const rk = R.fold.has(x.r.key) ? '_other' : x.r.key, ck = C.fold.has(x.c.key) ? '_other' : x.c.key;
    sum(cells, cellKey(rk, ck), x.w); sum(rowTotals, rk, x.w); sum(colTotals, ck, x.w); total += x.w;
  }
  return { rows: R.heads, cols: C.heads, cells, rowTotals, colTotals, total, n: raw.length };
}
