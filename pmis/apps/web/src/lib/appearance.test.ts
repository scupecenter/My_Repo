// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { APPEARANCE_DEFAULTS, APPEARANCE_PRESETS, applyAppearance, paint, sanitizeAppearance, savedAppearance } from './appearance';

describe('appearance profiles (0241)', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const a of ['data-ui-density', 'data-ui-font-scale', 'data-ui-radius', 'data-ui-motion', 'data-ui-icon-style', 'data-ui-menu-style', 'data-ui-accent']) document.documentElement.removeAttribute(a);
  });

  it('sanitize keeps only known keys with allowed values', () => {
    expect(sanitizeAppearance({ density: 'compact', sparkle: 'lots', accent: 'violet', motion: 'fast', radius: 3 })).toEqual({ density: 'compact', accent: 'violet' });
    expect(sanitizeAppearance(null)).toEqual({});
    expect(sanitizeAppearance(['compact'])).toEqual({});
  });

  it('paint sets an attribute per non-standard dimension and none for the standard', () => {
    paint({ density: 'compact', accent: 'violet', radius: 'standard' });
    const el = document.documentElement;
    expect(el.getAttribute('data-ui-density')).toBe('compact');
    expect(el.getAttribute('data-ui-accent')).toBe('violet');
    expect(el.hasAttribute('data-ui-radius')).toBe(false);
    expect(el.hasAttribute('data-ui-motion')).toBe(false);
  });

  it('apply remembers the set and savedAppearance returns it; the standard set removes every attribute', () => {
    applyAppearance({ font_scale: 'large', icon_style: 'bold' });
    expect(savedAppearance()).toEqual({ font_scale: 'large', icon_style: 'bold' });
    applyAppearance({});
    expect(savedAppearance()).toEqual({});
    expect(document.documentElement.hasAttribute('data-ui-font-scale')).toBe(false);
  });

  it('every preset fills all seven dimensions', () => {
    for (const p of Object.values(APPEARANCE_PRESETS)) {
      // the look dimensions only: where the notification panel sits (inbox_*) is a working choice, not part of a look
      for (const k of Object.keys(APPEARANCE_DEFAULTS).filter((x) => !x.startsWith('inbox_') && x !== 'more_menu' && x !== 'followup_checklist')) expect(p.prefs).toHaveProperty(k);
    }
    expect(APPEARANCE_PRESETS.night.theme).toBe('dark');
  });
});
