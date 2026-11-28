export const TOTAL_FNS = ['sum', 'avg', 'count', 'min', 'max'] as const;
export type TotalFn = (typeof TOTAL_FNS)[number];

/** The figure at the foot of a numeric column. Empty cells are skipped (count counts the filled ones); null when there is nothing to total (min, max and avg of no value). */
export function computeTotal(values: readonly (number | null | undefined)[], fn: TotalFn): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (fn === 'count') return v.length;
  if (!v.length) return fn === 'sum' ? 0 : null;
  const sum = v.reduce((a, b) => a + b, 0);
  switch (fn) {
    case 'sum': return sum;
    case 'avg': return sum / v.length;
    case 'min': return Math.min(...v);
    default: return Math.max(...v);
  }
}

/** Up to 2 decimals, grouped, in the language; a dash when there is no figure. */
export function fmtTotal(n: number | null, lang: string): string {
  return n === null ? '–' : new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(n);
}
