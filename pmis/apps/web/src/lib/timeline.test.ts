import { describe, expect, it } from 'vitest';
import { buildTimeline, posPct } from './timeline';

const rows: Parameters<typeof buildTimeline>[0] = [
  { id: 'a', code: 'TR1', values: { '14': '2026-03-01', '16': '2026-05-10' } },
  { id: 'b', code: 'TR2', values: { '14': '2026-03-09', '16': null } },
  { id: 'c', code: 'TR3', values: {} },
];

describe('cross-site timeline model', () => {
  it('leaves out sites without a chosen date and spans the dates and today', () => {
    const m = buildTimeline(rows, ['14', '16'], '2026-04-01')!;
    expect(m.rows.map((r) => r.code)).toEqual(['TR1', 'TR2']);
    expect(m.rows[0]!.points).toHaveLength(2);
    expect(m.rows[0]!.from).toBeLessThan(m.rows[0]!.to);
    expect(posPct(m, m.min)).toBe(0);
    expect(posPct(m, m.max)).toBe(100);
    expect(m.months.map((x) => x.label)).toEqual(['2026-03', '2026-04', '2026-05']);
  });
  it('today widens the span and only the chosen columns count', () => {
    const m = buildTimeline(rows, ['14'], '2026-07-01')!;
    expect(m.rows[0]!.points).toHaveLength(1);
    expect(m.max).toBeGreaterThan(m.rows[0]!.to);
  });
  it('nothing to draw gives null', () => { expect(buildTimeline(rows, ['99'], '2026-04-01')).toBeNull(); });
  it('V3: any string key works, so a register date field drives the same model', () => {
    const recs = [
      { id: 'r1', code: 'WALK-001', values: { valid_to: '2026-06-01', issued_on: null } },
      { id: 'r2', code: 'WALK-002', values: { valid_to: '2026-06-20', issued_on: '2026-01-15' } },
    ];
    const m = buildTimeline(recs, ['issued_on', 'valid_to'], '2026-04-01')!;
    expect(m.rows).toHaveLength(2);
    expect(m.rows[1]!.points.map((p) => p.key)).toEqual(['issued_on', 'valid_to']);
  });
});
