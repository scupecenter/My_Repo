import { describe, expect, it } from 'vitest';
import { breakdown, numberStats } from './viewAnalytics';

describe('view analytics', () => {
  it('counts rows by value, largest first, with the empty value named', () => {
    const rows = ['open', 'open', 'done', '', ' '];
    const s = breakdown(rows, (r) => r, 'None', 'Other');
    expect(s.map((x) => [x.label, x.count])).toEqual([['None', 2], ['open', 2], ['done', 1]]);
    expect(s[0].share).toBeCloseTo(0.4);
  });
  it('merges the tail into one Other slice', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const s = breakdown(rows, (r) => r, 'None', 'Other', 3);
    expect(s).toHaveLength(4);
    expect(s[3]).toMatchObject({ key: 'other', count: 9 });
  });
  it('gives no slices for no rows', () => { expect(breakdown([], () => '', 'None', 'Other')).toEqual([]); });
  it('totals numbers and skips text and empty values', () => {
    expect(numberStats([1, '2', 'x', null, ''], (r) => r)).toEqual({ n: 2, sum: 3, avg: 1.5, min: 1, max: 2 });
    expect(numberStats(['a'], (r) => r)).toBeNull();
  });
});
