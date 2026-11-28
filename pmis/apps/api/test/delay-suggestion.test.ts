import { describe, expect, it } from 'vitest';
import { suggestDelay } from '../src/dashboard/delay-periods.service';

const base = { planned: '2026-11-10', code: 'C1', today: '2026-11-20', state: 'entry', colour: 'green' as string | null };

describe('A6 delay-period suggestion (computed on read)', () => {
  it('starts the day after the planned date, ends today, guesses the party from the task group', () => {
    expect(suggestDelay(base, [])).toEqual({ from_date: '2026-11-11', to_date: '2026-11-20', party: 'gecol', basis: 'planned_date' });
    expect(suggestDelay({ ...base, code: 'C4' }, [])).toMatchObject({ party: 'hlc' });
    expect(suggestDelay({ ...base, code: 'B2' }, [])).toMatchObject({ party: null });
  });
  it('suggests from today when only the SLA is red', () => {
    expect(suggestDelay({ ...base, planned: '2026-12-01', colour: 'red' }, [])).toEqual({ from_date: '2026-11-20', to_date: '2026-11-20', party: 'gecol', basis: 'sla' });
    expect(suggestDelay({ ...base, colour: 'red' }, [])).toMatchObject({ basis: 'planned_date_and_sla' });
  });
  it('suggests nothing for an on-time, approved or suspended task', () => {
    expect(suggestDelay({ ...base, planned: '2026-12-01' }, [])).toBeNull();
    expect(suggestDelay({ ...base, state: 'approved' }, [])).toBeNull();
    expect(suggestDelay({ ...base, state: 'suspended' }, [])).toBeNull();
  });
  it('one open suggestion: a proposed or approved period that covers today hides it, a voided or rejected one does not', () => {
    expect(suggestDelay(base, [{ from_date: '2026-11-11', to_date: '2026-11-25', status: 'proposed', voided: false }])).toBeNull();
    expect(suggestDelay(base, [{ from_date: '2026-11-11', to_date: '2026-11-14', status: 'approved', voided: false }])).toMatchObject({ from_date: '2026-11-15' });
    expect(suggestDelay(base, [{ from_date: '2026-11-11', to_date: '2026-11-25', status: 'rejected', voided: false }])).toMatchObject({ from_date: '2026-11-11' });
    expect(suggestDelay(base, [{ from_date: '2026-11-11', to_date: '2026-11-25', status: 'approved', voided: true }])).toMatchObject({ from_date: '2026-11-11' });
  });
});
