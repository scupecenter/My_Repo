import { describe, expect, it } from 'vitest';
import { byPriority, INBOX_TABS, inTab, isPriority } from './inboxPriority';

describe('inbox priority', () => {
  it('what needs action is priority, information is not', () => {
    expect(isPriority('mention')).toBe(true);
    expect(isPriority('approval_due')).toBe(true);
    expect(isPriority('followed_change')).toBe(false);
    expect(isPriority('system')).toBe(false);
  });
  it('priority first and the order inside each group is kept', () => {
    const l = [{ kind: 'system', n: 1 }, { kind: 'mention', n: 2 }, { kind: 'followed_change', n: 3 }, { kind: 'approval_due', n: 4 }];
    expect(byPriority(l).map((x) => x.n)).toEqual([2, 4, 1, 3]);
  });
  it('the priority list can come from the setting', () => {
    expect(isPriority('system', ['system'])).toBe(true);
    expect(isPriority('mention', ['system'])).toBe(false);
    expect(byPriority([{ kind: 'mention', n: 1 }, { kind: 'system', n: 2 }], ['system']).map((x) => x.n)).toEqual([2, 1]);
  });
  it('every kind lands in a tab and all and priority follow the setting', () => {
    const kinds = ['mention', 'followed_change', 'task_assigned', 'task_returned', 'task_rejected', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'system'];
    for (const k of kinds) expect(INBOX_TABS.filter((x) => x !== 'all' && x !== 'priority' && inTab(x, k, [])).length, k).toBe(1);
    expect(inTab('all', 'anything', [])).toBe(true);
    expect(inTab('priority', 'system', ['system'])).toBe(true);
    expect(inTab('priority', 'mention', ['system'])).toBe(false);
    expect(INBOX_TABS[0]).toBe('all');
  });
});
