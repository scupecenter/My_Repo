import { describe, expect, it } from 'vitest';
import { forecastFull, weeklyVelocity, type ScurvePoint } from './scurve';

/** Phase 5 (contract 0.15.474): the forecast method of the dashboard, mean (default) or a fitted straight line. */
const P = (date: string, actual: number): ScurvePoint => ({ date, actual });
const even: ScurvePoint[] = [P('2026-01-01', 10), P('2026-01-08', 20), P('2026-01-15', 30), P('2026-01-22', 40)];
const bumpy: ScurvePoint[] = [P('2026-01-01', 10), P('2026-01-08', 12), P('2026-01-15', 30), P('2026-01-22', 40)];

describe('forecast method', () => {
  it('mean is the default and equals the mean weekly gain', () => {
    expect(weeklyVelocity(even)).toBeCloseTo(10, 6);
    expect(weeklyVelocity(bumpy)).toBeCloseTo(10, 6);
    expect(weeklyVelocity(bumpy, 4, 'mean')).toBeCloseTo(10, 6);
  });
  it('linear is the slope of the fitted line: equal on a straight curve, it weighs the late jump on a bumpy one', () => {
    expect(weeklyVelocity(even, 4, 'linear')).toBeCloseTo(10, 6);
    const v = weeklyVelocity(bumpy, 4, 'linear')!;
    expect(v).toBeCloseTo(10.8, 6);
    expect(forecastFull(bumpy, v)).not.toBe(forecastFull(bumpy, 10));
  });
  it('linear needs two points on different dates', () => {
    expect(weeklyVelocity([P('2026-01-01', 10)], 4, 'linear')).toBeNull();
    expect(weeklyVelocity([P('2026-01-01', 10), P('2026-01-01', 12)], 4, 'linear')).toBeNull();
  });
});
