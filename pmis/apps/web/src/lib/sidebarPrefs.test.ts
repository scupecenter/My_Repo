import { describe, expect, it } from 'vitest';
import type { Layout } from './navLayout';
import { applySidebarOverlay, isHideable, sanitizeUiNav, withoutHidden } from './sidebarPrefs';

/** 0242 (owner approval 2026-11-27, the improvement proposal item 4): the personal sidebar overlay. */

const layout = (): Layout => ({
  headings: [
    { id: 'work', name_en: 'Work', name_ar: 'العمل', icon: null, children: ['my_work', 'inbox', { id: 'sub', name_en: 'S', name_ar: 'س', icon: null, children: ['messages', 'approvals'] }] },
    { id: 'home', name_en: 'Home', name_ar: 'الرئيسية', icon: null, children: ['dashboard'] },
  ],
});

describe('sanitizeUiNav', () => {
  it('keeps the known keys with allowed values; anything else drops out', () => {
    expect(sanitizeUiNav(null)).toEqual({});
    expect(sanitizeUiNav('x')).toEqual({});
    expect(sanitizeUiNav([])).toEqual({});
    expect(sanitizeUiNav({ badge_style: 'huge', hidden: 'no', unknown: [1] })).toEqual({});
    expect(sanitizeUiNav({ badge_style: 'dot', pins: ['a', 'a', 'b'] })).toEqual({ badge_style: 'dot', pins: ['a', 'b'] });
    expect(sanitizeUiNav({ hidden: ['Bad Key', 'ok.key', 7] })).toEqual({ hidden: ['ok.key'] });
  });

  it('caps the lists (pins at 20, hidden and order at 200)', () => {
    expect(sanitizeUiNav({ pins: Array.from({ length: 25 }, (_, i) => `k${i}`) }).pins).toHaveLength(20);
    expect(sanitizeUiNav({ hidden: Array.from({ length: 250 }, (_, i) => `k${i}`) }).hidden).toHaveLength(200);
  });
});

describe('applySidebarOverlay', () => {
  it('hides the screens of a heading and of a sub-heading', () => {
    const l = applySidebarOverlay(layout(), { hidden: ['inbox', 'approvals'] });
    expect(l.headings[0]!.children[0]).toBe('my_work');
    const sub = l.headings[0]!.children[1] as { children: string[] };
    expect(sub.children).toEqual(['messages']);
    expect(l.headings[1]!.children).toEqual(['dashboard']);
  });

  it('orders the named screens first inside their heading; the rest keep the organization order; sub-headings stay in place', () => {
    const l = applySidebarOverlay(layout(), { order: ['approvals', 'dashboard', 'inbox'] });
    const work = l.headings[0]!;
    expect(work.children[0]).toBe('inbox');
    expect(work.children[1]).toBe('my_work');
    expect(work.children[2]).toMatchObject({ id: 'sub', children: ['approvals', 'messages'] });
    expect(l.headings[1]!.children).toEqual(['dashboard']);
  });

  it('ignores keys the menu does not have', () => {
    expect(applySidebarOverlay(layout(), { order: ['nope'], hidden: ['nope'] })).toEqual(layout());
  });

  it('no prefs: the organization layout as it is', () => {
    expect(applySidebarOverlay(layout(), null)).toEqual(layout());
    expect(applySidebarOverlay(layout(), {})).toEqual(layout());
  });
});

describe('Dashboard is never hideable, and the search follows the personal hide', () => {
  it('drops dashboard from a stored hidden list', () => {
    expect(isHideable('dashboard')).toBe(false);
    expect(sanitizeUiNav({ hidden: ['dashboard', 'warehouse'] }).hidden).toEqual(['warehouse']);
  });
  it('withoutHidden leaves out the hidden screens', () => {
    const items = [{ key: 'dashboard' }, { key: 'warehouse' }];
    expect(withoutHidden(items, { hidden: ['warehouse', 'dashboard'] }).map((i) => i.key)).toEqual(['dashboard']);
    expect(withoutHidden(items, null)).toHaveLength(2);
  });
});
