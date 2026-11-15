import { describe, expect, it } from 'vitest';
import { groupWarnings, projectedTotal } from './slaWeightModel';

const totals = [
  { group: 'CW', total: 60, tasks: 3, ok: false },
  { group: 'TE', total: 100, tasks: 2, ok: true },
];
const off = { counts: false, value: 0, group: null };

describe('projectedTotal', () => {
  it('adds a new counted task to its group', () => {
    expect(projectedTotal(totals, 'CW', off, { counts: true, value: 40, group: 'CW' })).toBe(100);
  });
  it('replaces what the task already contributes', () => {
    const cur = { counts: true, value: 10, group: 'CW' };
    expect(projectedTotal(totals, 'CW', cur, { counts: true, value: 40, group: 'CW' })).toBe(90);
  });
  it('removes a task that leaves the group', () => {
    const cur = { counts: true, value: 10, group: 'TE' };
    expect(projectedTotal(totals, 'TE', cur, off)).toBe(90);
  });
  it('treats an unknown group as 0 before the change', () => {
    expect(projectedTotal(totals, 'HOTO', off, { counts: true, value: 5, group: 'HOTO' })).toBe(5);
  });
});

describe('groupWarnings', () => {
  it('warns about groups that do not total 100 after the change', () => {
    const w = groupWarnings(totals, off, { counts: true, value: 5, group: 'CW' });
    expect(w).toEqual([{ group: 'CW', total: 65 }]);
  });
  it('is silent when every group totals 100', () => {
    expect(groupWarnings(totals, { counts: true, value: 60, group: 'CW' }, { counts: true, value: 60, group: 'CW' }).filter((x) => x.group === 'TE')).toEqual([]);
  });
});
