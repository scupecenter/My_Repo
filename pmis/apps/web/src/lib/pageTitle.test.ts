import { describe, expect, it } from 'vitest';
import { composeTitle, pageLabelKey, titleRoute } from './pageTitle';

describe('page title helpers', () => {
  it('maps a route to its menu label, longest prefix first', () => {
    expect(pageLabelKey('/my-work')).toBe('nav.my_work');
    expect(pageLabelKey('/my-work/daily-plan')).toBe('nav.daily_plan');
    expect(pageLabelKey('/sites/new')).toBe('sites.new_site');
    expect(pageLabelKey('/admin/users/42')).toBe('nav.admin.users');
    expect(pageLabelKey('/admin/logs/mail/')).toBe('nav.logs.mail');
    expect(pageLabelKey('/nowhere')).toBeNull();
  });
  it('tells a register list, a record page, a drawer link and a site apart', () => {
    expect(titleRoute('/registers/procurement', '')).toEqual({ kind: 'register', key: 'procurement' });
    expect(titleRoute('/registers/procurement', '?record=abc')).toEqual({ kind: 'record', key: 'procurement', id: 'abc' });
    expect(titleRoute('/registers/hlc/records/r1', '')).toEqual({ kind: 'record', key: 'hlc', id: 'r1' });
    expect(titleRoute('/sites/s1', '')).toEqual({ kind: 'site', id: 's1' });
    expect(titleRoute('/sites/new', '')).toEqual({ kind: 'none' });
    expect(titleRoute('/dashboard', '')).toEqual({ kind: 'none' });
  });
  it('joins head and product, product alone when there is no head', () => {
    expect(composeTitle('Procurement', 'Product')).toBe('Procurement | Product');
    expect(composeTitle('  ', 'Product')).toBe('Product');
    expect(composeTitle(null, 'Product')).toBe('Product');
  });
});
