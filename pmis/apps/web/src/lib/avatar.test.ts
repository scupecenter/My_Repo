import { describe, expect, it } from 'vitest';
import { avatarLook, hashOf, initialsOf } from './avatar';
import { daysBetween, isNew } from './newFeatures';

describe('generated avatars', () => {
  it('takes the first letter of the first two words, Latin and Arabic', () => {
    expect(initialsOf('Demo Person A')).toBe('DP');
    expect(initialsOf('  demo   person b ')).toBe('DP');
    expect(initialsOf('سالم المصراتي')).toBe('سا');
    expect(initialsOf('Demo City')).toBe('DC');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf('--- ...')).toBe('?');
  });
  it('is stable for one name and uses the accent for the brand palette', () => {
    expect(hashOf('Demo Person A')).toBe(hashOf('Demo Person A'));
    expect(avatarLook('Demo Person A', 'gradient', 'varied')).toEqual(avatarLook('Demo Person A', 'gradient', 'varied'));
    expect(avatarLook('Demo Person A', 'gradient', 'brand').background).toBe('var(--accent)');
    expect(avatarLook('Demo Person A', 'gradient', 'varied').background).toContain('linear-gradient');
    expect(avatarLook('Demo Person A', 'geometric', 'varied').background).toMatch(/^hsl\(/);
  });
  it('spreads different names over several colours', () => {
    const hues = new Set(['Ali', 'Omar', 'Nadia', 'Khaled', 'Salem', 'Huda', 'Yahya', 'Mona', 'Tarek', 'Sara'].map((n) => avatarLook(n, 'initials', 'varied').hue));
    expect(hues.size).toBeGreaterThan(4);
  });
});

describe('New badge window', () => {
  it('counts whole days and shows for the set number of days from the release date', () => {
    expect(daysBetween('2026-11-27', '2026-11-30')).toBe(3);
    const cfg = { enabled: true, days: 14 };
    expect(isNew('2026-11-27', '2026-11-27', cfg)).toBe(true);
    expect(isNew('2026-11-27', '2026-12-10', cfg)).toBe(true);
    expect(isNew('2026-11-27', '2026-12-11', cfg)).toBe(false);
    expect(isNew('2026-11-27', '2026-11-26', cfg)).toBe(false);
    expect(isNew('2026-11-27', '2026-11-28', { enabled: false, days: 14 })).toBe(false);
    expect(isNew(undefined, '2026-11-28', cfg)).toBe(false);
  });
});
