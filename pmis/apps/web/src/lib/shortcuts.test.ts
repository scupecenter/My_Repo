import { describe, expect, it } from 'vitest';
import { goTarget, GO_KEYS, isTyping } from './shortcuts';

describe('shortcuts', () => {
  it('g then d opens the dashboard; a lone key does nothing', () => {
    const a = goTarget(null, 'g');
    expect(a).toEqual({ next: 'g', to: null });
    expect(goTarget(a.next, 'd')).toEqual({ next: null, to: '/dashboard' });
    expect(goTarget(null, 'd').to).toBeNull();
  });
  it('an unknown second key cancels the sequence', () => {
    expect(goTarget('g', 'z')).toEqual({ next: null, to: null });
  });
  it('every target is an internal path', () => {
    for (const to of Object.values(GO_KEYS)) expect(to.startsWith('/')).toBe(true);
  });
  it('typing fields are ignored', () => {
    expect(isTyping(document.createElement('input'))).toBe(true);
    expect(isTyping(document.createElement('div'))).toBe(false);
  });
});
