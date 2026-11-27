import { afterEach, describe, expect, it } from 'vitest';
import { applyMotion, currentMotion, motionReduced, MOTION_KEY } from './motion';

afterEach(() => { localStorage.removeItem(MOTION_KEY); document.documentElement.removeAttribute('data-motion'); });

describe('motion preference', () => {
  it('defaults to auto and saves the choice on the page', () => {
    expect(currentMotion()).toBe('auto');
    applyMotion('reduced');
    expect(currentMotion()).toBe('reduced');
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
    expect(motionReduced()).toBe(true);
    applyMotion('auto');
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
  });
});
