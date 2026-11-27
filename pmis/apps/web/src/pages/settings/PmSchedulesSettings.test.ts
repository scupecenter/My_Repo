import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { dueSchedules, scheduleId, type PmSchedules } from '@/api/pmSchedules';

describe('scheduleId', () => {
  it('makes a short a-z0-9 id from the name and keeps it unique', () => {
    expect(scheduleId('Monthly check!', [])).toBe('monthly-check');
    expect(scheduleId('Monthly check!', ['monthly-check'])).toBe('monthly-check-2');
    expect(scheduleId('فحص', [])).toBe('schedule');
  });
});

describe('dueSchedules', () => {
  const s = { today: '2026-11-27', schedules: [
    { id: 'a-a', register_key: 'x', next_due: '2026-11-27', active: true },
    { id: 'b-b', register_key: 'x', next_due: '2026-11-28' },
    { id: 'c-c', register_key: 'y', next_due: '2026-01-01' },
    { id: 'd-d', register_key: 'x', next_due: '2026-01-01', active: false },
  ] } as unknown as PmSchedules;
  it('keeps the active schedules due today or earlier, of the register asked', () => {
    expect(dueSchedules(s).map((x) => x.id)).toEqual(['a-a', 'c-c']);
    expect(dueSchedules(s, 'x').map((x) => x.id)).toEqual(['a-a']);
    expect(dueSchedules(undefined)).toEqual([]);
  });
});

describe('pm i18n', () => {
  it('has the same keys in English and Arabic', () => {
    const k = (o: unknown) => Object.keys((o as Record<string, Record<string, string>>).pm).sort();
    expect(k(ar)).toEqual(k(en));
  });
});
