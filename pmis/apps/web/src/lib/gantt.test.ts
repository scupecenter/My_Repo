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
