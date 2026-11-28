import { describe, expect, it } from 'vitest';
import { buildGantt, pos } from './gantt';

const n = (code: string, state: string, b?: string, p?: string, a?: string) => ({ code, kind: 'milestone', name_en: code, state, baseline_date: b, planned_date: p, actual_date: a }) as never;

describe('buildGantt', () => {
  it('spans the dates, skips n/a and undated stages', () => {
    const m = buildGantt([n('A', 'done', '2026-01-01', undefined, '2026-01-11'), n('B', 'na', '2026-05-01'), n('C', 'planned'), n('D', 'planned', undefined, '2026-01-21')])!;
    expect(m.rows.map((r) => r.code)).toEqual(['A', 'D']);
    expect(pos(m, m.min)).toBe(0);
    expect(pos(m, m.max)).toBe(100);
    expect(Math.round(pos(m, m.min + 10))).toBe(50);
  });
  it('is null with no dates', () => {
    expect(buildGantt([n('C', 'planned')])).toBeNull();
    expect(buildGantt(undefined)).toBeNull();
  });
});

describe('buildGantt dependencies and today', () => {
  it('joins each dated row to the one before it and flags a row dated earlier', () => {
    const m = buildGantt([n('A', 'done', undefined, undefined, '2026-02-10'), n('B', 'planned', undefined, '2026-03-01'), n('C', 'planned', undefined, '2026-02-20')])!;
    expect(m.deps.map((d) => [d.from, d.to, d.conflict])).toEqual([['A', 'B', false], ['B', 'C', true]]);
  });
  it('skips a dependency across an undated stage and keeps order of the dated ones', () => {
    const m = buildGantt([n('A', 'done', undefined, undefined, '2026-02-10'), n('B', 'planned'), n('C', 'planned', undefined, '2026-03-01')])!;
    expect(m.deps.map((d) => [d.from, d.to])).toEqual([['A', 'C']]);
  });
  it('puts today on the span and widens it when today is outside', () => {
    const m = buildGantt([n('A', 'done', undefined, undefined, '2026-02-10'), n('B', 'planned', undefined, '2026-02-20')], '2026-03-02')!;
    expect(m.today).not.toBeNull();
    expect(m.max).toBe(m.today);
    expect(pos(m, m.today!)).toBe(100);
    expect(buildGantt([n('A', 'done', undefined, undefined, '2026-02-10')])!.today).toBeNull();
  });
});
