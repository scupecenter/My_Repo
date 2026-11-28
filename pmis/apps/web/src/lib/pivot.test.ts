import { describe, expect, it } from 'vitest';
import { buildPivot, cellKey, PIVOT_MAX } from './pivot';

const ax = (k: string) => ({ key: k, label: k || 'none', raw: k || null });
type R = { a: string; b: string; n: number };
const rows: R[] = [
  { a: 'north', b: 'open', n: 2 }, { a: 'north', b: 'open', n: 3 }, { a: 'north', b: 'done', n: 1 },
  { a: 'south', b: 'open', n: 4 }, { a: 'south', b: '', n: 5 },
];
describe('pivot', () => {
  it('counts by two fields with totals, the empty value last', () => {
    const p = buildPivot(rows, (r) => ax(r.a), (r) => ax(r.b), () => 1, 'Other');
    expect(p.rows.map((h) => h.key)).toEqual(['north', 'south']);
    expect(p.cols.map((h) => h.key)).toEqual(['done', 'open', '']);
    expect(p.cells.get(cellKey('north', 'open'))).toBe(2);
    expect(p.rowTotals.get('south')).toBe(2);
    expect(p.colTotals.get('open')).toBe(3);
    expect(p.total).toBe(5);
  });
  it('sums a number and has a single column without a column field', () => {
    const p = buildPivot(rows, (r) => ax(r.a), null, (r) => r.n, 'Other');
    expect(p.cols).toHaveLength(1);
    expect(p.rowTotals.get('north')).toBe(6);
    expect(p.total).toBe(15);
  });
  it('folds the smallest heads into Other past the cap and keeps the totals', () => {
    const many = Array.from({ length: PIVOT_MAX + 5 }, (_, i) => ({ a: `r${String(i).padStart(2, '0')}`, b: 'x', n: 1 }));
    const p = buildPivot([...many, ...many.slice(0, 3)], (r) => ax(r.a), (r) => ax(r.b), () => 1, 'Other');
    expect(p.rows).toHaveLength(PIVOT_MAX);
    expect(p.rows.at(-1)?.key).toBe('_other');
    expect(p.total).toBe(PIVOT_MAX + 8);
    expect(p.rows.slice(0, 3).map((h) => h.key)).toEqual(['r00', 'r01', 'r02']);
  });
});
