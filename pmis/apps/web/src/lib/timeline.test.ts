import { describe, expect, it } from 'vitest';
import { buildTimeline, posPct } from './timeline';

const rows: Parameters<typeof buildTimeline>[0] = [
  { site_id: 'a', site_code: 'TR1', values: { '14': '2026-03-01', '16': '2026-05-10' } },
  { site_id: 'b', site_code: 'TR2', values: { '14': '2026-03-09', '16': null } },
  { site_id: 'c', site_code: 'TR3', values: {} },
];

describe('cross-site timeline model', () => {
  it('leaves out sites without a chosen date and spans the dates and today', () => {
    const m = buildTimeline(rows, [14, 16], '2026-04-01')!;
    expect(m.rows.map((r) => r.code)).toEqual(['TR1', 'TR2']);
    expect(m.rows[0]!.points).toHaveLength(2);
    expect(m.rows[0]!.from).toBeLessThan(m.rows[0]!.to);
    expect(posPct(m, m.min)).toBe(0);
    expect(posPct(m, m.max)).toBe(100);
    expect(m.months.map((x) => x.label)).toEqual(['2026-03', '2026-04', '2026-05']);
  });
  it('today widens the span and only the chosen columns count', () => {
    const m = buildTimeline(rows, [14], '2026-07-01')!;
    expect(m.rows[0]!.points).toHaveLength(1);
    expect(m.max).toBeGreaterThan(m.rows[0]!.to);
  });
  it('nothing to draw gives null', () => { expect(buildTimeline(rows, [99], '2026-04-01')).toBeNull(); });
});
