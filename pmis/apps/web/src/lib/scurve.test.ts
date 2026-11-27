import { describe, expect, it } from 'vitest';
import { forecastFull, scurveSeries, weeklyVelocity } from './scurve';

const weekly = (startISO: string, actuals: (number | null)[], planned: (number | null)[] = []) => {
  const start = new Date(`${startISO}T00:00:00Z`).getTime();
  return actuals.map((actual, i) => ({
    date: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
    actual,
    planned: planned[i] ?? null,
  }));
};

describe('scurveSeries', () => {
  it('sorts by date, drops figures-less rows and keeps one row per date', () => {
    const s = scurveSeries([
      { date: '2026-11-19', actual: 40, planned: 45 },
      { date: '2026-11-05', actual: 30, planned: 31 },
      { date: '2026-11-12', actual: null, planned: 38 },
      { date: '2026-11-19', actual: 41, planned: 46 },
    ]);
    expect(s).toEqual([
      { date: '2026-11-05', actual: 30, planned: 31 },
      { date: '2026-11-19', actual: 41, planned: 46 },
    ]);
  });
});

describe('weeklyVelocity', () => {
  it('averages the weekly gain over the last four gaps', () => {
    // gains 1, 2, 3, 4, 5 per week -> the last four average (2+3+4+5)/4 = 3.5
    expect(weeklyVelocity(weekly('2026-10-01', [10, 11, 13, 16, 20, 25]))).toBeCloseTo(3.5);
  });

  it('normalises a gap longer than a week by its days', () => {
    // one 14-day gap of +7 -> 3.5 per week
    expect(weeklyVelocity([{ date: '2026-11-05', actual: 10 }, { date: '2026-11-19', actual: 17 }])).toBeCloseTo(3.5);
  });

  it('is null with fewer than two figures', () => {
    expect(weeklyVelocity(weekly('2026-10-01', [42]))).toBeNull();
    expect(weeklyVelocity([])).toBeNull();
  });

  it('can be negative (a correction moves the curve down)', () => {
    expect(weeklyVelocity(weekly('2026-10-01', [50, 49, 48]))).toBeCloseTo(-1);
  });
});

describe('forecastFull', () => {
  it('reaches 100 % at the current weekly velocity, rounded up to a whole day', () => {
    const pts = weekly('2026-11-05', [80, 84]); // +4/week, last date 2026-11-12, 16 to go -> 4 weeks -> 2026-12-10
    expect(forecastFull(pts, weeklyVelocity(pts))).toBe('2026-12-10');
  });

  it('rounds a fractional week up', () => {
    const pts = weekly('2026-11-05', [80, 90]); // +10/week, 10 to go -> exactly 1 week -> 2026-11-19
    expect(forecastFull(pts, 10)).toBe('2026-11-19');
    expect(forecastFull(pts, 9)).toBe('2026-11-20'); // 10/9 weeks -> 8 days
  });

  it('is null when the curve stands still or falls, and the last date when done', () => {
    expect(forecastFull(weekly('2026-11-05', [80, 80]), 0)).toBeNull();
    expect(forecastFull(weekly('2026-11-05', [80, 79]), -1)).toBeNull();
    expect(forecastFull(weekly('2026-11-05', [99, 100]), 1)).toBe('2026-11-12');
    expect(forecastFull([], null)).toBeNull();
  });
});
