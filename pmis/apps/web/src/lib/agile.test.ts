import { describe, expect, it } from 'vitest';
import { burnupSeries, coneForecast, finishDate, flowSeries, meanDone, weeklyDone, type AgileRow } from './agile';

const row = (d: string, done: number, scope: number, by: Record<string, number> = {}): AgileRow => ({ taken_on: d, sites: Object.values(by).reduce((a, b) => a + b, 0), by_status: by, items_done: done, items_applicable: scope, items_planned: done });
const rows = [row('2026-01-01', 10, 100, { in_progress: 4, not_started: 6 }), row('2026-01-08', 20, 100, { in_progress: 5, not_started: 5 }), row('2026-01-15', 40, 120, { in_progress: 6, completed: 1, not_started: 3 })];

describe('agile indicators', () => {
  it('burn-up shows done, scope and the scope change', () => {
    expect(burnupSeries(rows).map((r) => [r.done, r.scope, r.scopeChange])).toEqual([[10, 100, 0], [20, 100, 0], [40, 120, 20]]);
  });
  it('velocity is items per week, normalised by the days, never negative', () => {
    expect(weeklyDone(rows).map((w) => w.done)).toEqual([10, 20]);
    expect(weeklyDone([row('2026-01-01', 10, 100), row('2026-01-15', 20, 100)])[0]!.done).toBe(5);
    expect(weeklyDone([row('2026-01-01', 10, 100), row('2026-01-08', 4, 100)])[0]!.done).toBe(0);
    expect(meanDone(weeklyDone(rows), 4)).toBe(15);
    expect(meanDone(weeklyDone(rows), 1)).toBe(20);
  });
  it('cumulative flow stacks the sites by status in order', () => {
    const f = flowSeries(rows);
    expect(f.statuses).toEqual(['not_started', 'in_progress', 'completed']);
    expect(f.counts.completed).toEqual([0, 0, 1]);
  });
  it('the finish date is the day done reaches the scope at the pace', () => {
    expect(finishDate(rows[2]!, 20)).toBe('2026-02-12');   // 80 left at 20 a week: 28 days after 2026-01-15
    expect(finishDate(rows[2]!, 0)).toBeNull();
    expect(finishDate(row('2026-01-15', 120, 120), 0)).toBe('2026-01-15');
  });
  it('the cone widens and ends at the scope, fast before mean before slow', () => {
    const c = coneForecast(rows, 4)!;
    expect(c.scope).toBe(120);
    expect(c.dates[0]).toBe('2026-01-15');
    expect(c.fast[c.fast.length - 1]).toBe(120);
    expect(c.finish.fast! <= c.finish.mean! && c.finish.mean! <= c.finish.slow!).toBe(true);
    expect((c.slow[1] ?? 0) <= (c.mean[1] ?? 0) && (c.mean[1] ?? 0) <= (c.fast[1] ?? 0)).toBe(true);
    expect(coneForecast([rows[0]!], 4)).toBeNull();
  });
});
