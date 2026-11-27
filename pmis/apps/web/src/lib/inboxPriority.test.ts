import { describe, expect, it } from 'vitest';
import { byPriority, isPriority } from './inboxPriority';

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
});
