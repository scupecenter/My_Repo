import { describe, expect, it } from 'vitest';
import { awayOn, today } from '@/lib/availability';

const a = (id: string, from: string, to: string, kind = 'sick') => ({ user: { employee_id: id }, kind, from_date: from, to_date: to });

describe('availability', () => {
  it('lists people whose absence covers the day, ends included', () => {
    const m = awayOn([a('1001', '2026-11-20', '2026-11-28'), a('1002', '2026-11-29', '2026-12-01'), a('1003', '2026-11-28', '2026-11-28', 'annual')], '2026-11-28');
    expect([...m.keys()].sort()).toEqual(['1001', '1003']);
    expect(m.get('1003')).toBe('annual');
  });
  it('knows nothing without a list, and skips people with no id', () => {
    expect(awayOn(undefined, '2026-11-28').size).toBe(0);
    expect(awayOn([{ user: {}, kind: 'sick', from_date: '2026-11-01', to_date: '2026-12-01' }], '2026-11-28').size).toBe(0);
  });
  it('today is a local calendar date', () => {
    expect(today(new Date(2026, 10, 5))).toBe('2026-11-05');
  });
});
