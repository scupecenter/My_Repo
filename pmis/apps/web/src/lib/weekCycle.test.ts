import { describe, expect, it } from 'vitest';
import type { DailyPlanDay, DailyPlanRow } from '@/api/dailyPlan';
import { buildWeek, carryCandidates, dayTotals, shiftWeek, weekDays } from './weekCycle';

const row = (site: string, below: boolean, region = 1) => ({ site_id: `id-${site}`, site_code: site, region_id: region, below_target: below, values: {} }) as unknown as DailyPlanRow;
const dayOf = (rows: DailyPlanRow[]) => ({ rows, plans: [] }) as unknown as DailyPlanDay;

describe('week cycle', () => {
  it('lists the seven days of the week from Sunday, or from Monday', () => {
    expect(weekDays('2026-11-27')[0]).toBe('2026-11-22'); // Friday -> Sunday
    expect(weekDays('2026-11-27')[6]).toBe('2026-11-28');
    expect(weekDays('2026-11-22')[0]).toBe('2026-11-22');
    expect(weekDays('2026-11-27', 1)[0]).toBe('2026-11-23');
    expect(shiftWeek('2026-11-27', -1)).toBe('2026-11-20');
  });
  it('builds one row per site with its state on each day', () => {
    const dates = weekDays('2026-11-25');
    const w = buildWeek(dates, { '2026-11-22': dayOf([row('B1', true), row('A1', false)]), '2026-11-23': dayOf([row('A1', false)]), '2026-11-29': undefined }, [], '2026-11-24');
    expect(w.map((r) => r.site_code)).toEqual(['A1', 'B1']);
    expect(w[0]!.cells['2026-11-22']).toBe('done');
    expect(w[1]!.cells['2026-11-22']).toBe('below');
    expect(w[1]!.cells['2026-11-23']).toBe('none');
  });
  it('plans the days after today and keeps the region scope', () => {
    const w = buildWeek(['2026-11-30'], { '2026-11-30': dayOf([row('A1', false, 1), row('Z9', false, 2)]) }, [1], '2026-11-27');
    expect(w.map((r) => r.site_code)).toEqual(['A1']);
    expect(w[0]!.cells['2026-11-30']).toBe('planned');
  });
  it('carries over only the rows below target that the next day does not have', () => {
    const from = dayOf([row('A1', true), row('B1', true), row('C1', false), row('D1', true, 2)]);
    const to = dayOf([row('B1', false)]);
    expect(carryCandidates(from, to, []).map((c) => c.site_code)).toEqual(['A1', 'D1']);
    expect(carryCandidates(from, to, [1]).map((c) => c.site_code)).toEqual(['A1']);
    expect(carryCandidates(undefined, to, [])).toEqual([]);
  });
  it('counts the rows and the rows below target of a day', () => {
    expect(dayTotals(dayOf([row('A', true), row('B', false)]), [])).toEqual({ rows: 2, below: 1 });
  });
});
