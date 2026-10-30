import { describe, expect, it } from 'vitest';
import { nextRunAt } from '../src/jobs/jobs.service';

/** The schedule of the daily job (owner answer Q84): 02:00 Africa/Tripoli (UTC+2, no daylight saving time since 2013). Pure function, fixed instants. */
describe('nextRunAt', () => {
  const at = (iso: string): string => nextRunAt(new Date(iso)).toISOString();

  it('is 02:00 Tripoli time of the same day when it is earlier than that', () => {
    expect(at('2026-10-29T23:00:00Z')).toBe('2026-10-30T00:00:00.000Z');       // 01:00 on the 30th in Tripoli
  });

  it('is 02:00 of the next day when 02:00 has passed, or is right now', () => {
    expect(at('2026-10-30T00:30:00Z')).toBe('2026-10-31T00:00:00.000Z');       // 02:30 in Tripoli
    expect(at('2026-10-30T00:00:00Z')).toBe('2026-10-31T00:00:00.000Z');       // exactly 02:00: the run of this minute is the one that is happening
    expect(at('2026-10-30T12:00:00Z')).toBe('2026-10-31T00:00:00.000Z');
  });

  it('crosses a month and a year end', () => {
    expect(at('2026-12-31T05:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(at('2026-02-28T22:30:00Z')).toBe('2026-03-01T00:00:00.000Z');       // 00:30 on 1 March in Tripoli, so 02:00 of the same day
  });

  it('follows another zone and hour', () => {
    expect(nextRunAt(new Date('2026-10-30T00:00:00Z'), 'UTC', 2).toISOString()).toBe('2026-10-30T02:00:00.000Z');
    expect(nextRunAt(new Date('2026-06-30T23:00:00Z'), 'Europe/Paris', 2).toISOString()).toBe('2026-07-01T00:00:00.000Z');   // UTC+2 in summer
    expect(nextRunAt(new Date('2025-12-31T23:30:00Z'), 'Europe/Paris', 2).toISOString()).toBe('2026-01-01T01:00:00.000Z');   // UTC+1 in winter
  });
});
