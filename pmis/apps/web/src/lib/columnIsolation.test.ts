import { afterEach, describe, expect, it } from 'vitest';
import { columnsApply, COLUMNS_FOR } from '@/components/SavedViews';
import { loadPrefs, moveCol, prefsKey, resizeCol, storePrefs, toggleCol, type ColDef } from './tablePrefs';

// Per-list column isolation (owner request 2026-11-27): hiding, ordering or sizing a column in one list never touches another list,
// per user, even when two lists have a column with the same key.
const DEFS: ColDef[] = [{ id: 'name', w: 160, pinned: true }, { id: 'status', w: 120 }, { id: 'owner', w: 120 }, { id: 'date', w: 100 }];

afterEach(() => localStorage.clear());

describe('column prefs are stored per user and per list', () => {
  it('hiding, moving and resizing "status" in list A leaves list B (same column keys) untouched', () => {
    const a = toggleCol(loadPrefs('list-a', 'u1', DEFS), DEFS, 'status');
    const a2 = resizeCol(moveCol(a, DEFS, 'date', -1), DEFS, 'owner', 300);
    storePrefs('list-a', 'u1', a2);
    const b = loadPrefs('list-b', 'u1', DEFS);
    expect(b.hidden).toEqual([]);
    expect(b.order).toEqual(['name', 'status', 'owner', 'date']);
    expect(b.width).toEqual({});
    // and list A really kept it
    const back = loadPrefs('list-a', 'u1', DEFS);
    expect(back.hidden).toEqual(['status']);
    expect(back.width.owner).toBe(300);
    expect(back.order.indexOf('date')).toBeLessThan(back.order.indexOf('owner'));
  });

  it('another user on the same list is untouched, and each pair has its own storage key', () => {
    storePrefs('list-a', 'u1', toggleCol(loadPrefs('list-a', 'u1', DEFS), DEFS, 'owner'));
    expect(loadPrefs('list-a', 'u2', DEFS).hidden).toEqual([]);
    expect(new Set([prefsKey('list-a', 'u1'), prefsKey('list-a', 'u2'), prefsKey('list-b', 'u1'), prefsKey('register-x', 'u1'), prefsKey('register-y', 'u1')]).size).toBe(5);
  });

  it('a list whose prefs are stored under a longer key is not read by a list with a prefix of that name', () => {
    storePrefs('sites-menu-a', 'u1', toggleCol(loadPrefs('sites-menu-a', 'u1', DEFS), DEFS, 'status'));
    expect(loadPrefs('sites', 'u1', DEFS).hidden).toEqual([]);
    expect(loadPrefs('sites-menu-ab', 'u1', DEFS).hidden).toEqual([]);
  });
});

describe('saved views never carry columns across lists', () => {
  const cols = { order: ['name'], hidden: ['status'], width: {} };
  it('a view stamped by one table applies its columns only to that table', () => {
    const v = { filters: { [COLUMNS_FOR]: 'task-grid' }, columns: cols };
    expect(columnsApply(v, { screen: 'task-grid' }, true)).toBe(true);
    expect(columnsApply(v, { screen: 'task-timeline' }, true)).toBe(false);
  });
  it('a view saved before the stamp existed: skipped on a shared view screen, applied elsewhere (no regression)', () => {
    const v = { filters: {}, columns: cols };
    expect(columnsApply(v, { screen: 'task-timeline' }, true)).toBe(false);
    expect(columnsApply(v, { screen: 'audit-log' }, false)).toBe(true);
  });
  it('a view without columns, or a screen without a column control, applies none', () => {
    expect(columnsApply({ filters: {}, columns: {} }, { screen: 'x' }, false)).toBe(false);
    expect(columnsApply({ filters: {}, columns: cols }, undefined, false)).toBe(false);
  });
});
