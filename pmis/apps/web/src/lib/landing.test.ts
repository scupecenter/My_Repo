import { describe, expect, it } from 'vitest';
import { landingPath } from './landing';
import { allowedTabs, clampTab } from '@/pages/dashboardTabs';

describe('landing page (0163)', () => {
  it('opens the Dashboard when it is the only viewable module (Messages and Inbox do not count)', () => {
    expect(landingPath(['dashboard'])).toBe('/dashboard');
    expect(landingPath(['dashboard', 'messages', 'inbox'])).toBe('/dashboard');
  });
  it('keeps My Work for everyone else', () => {
    expect(landingPath(['dashboard', 'sites'])).toBe('/my-work');
    expect(landingPath(['my_work', 'dashboard'])).toBe('/my-work');
    expect(landingPath(['messages'])).toBe('/my-work');
    expect(landingPath(undefined)).toBe('/my-work');
  });
});

describe('dashboard tabs per role (0163)', () => {
  it('missing means all three, in the fixed order', () => {
    expect(allowedTabs(undefined)).toEqual(['pmo', 'cw', 'te']);
    expect(allowedTabs(['te', 'pmo'])).toEqual(['pmo', 'te']);
    expect(allowedTabs([])).toEqual(['pmo', 'cw', 'te']);
  });
  it('a tab outside the allowed list falls to the first allowed one', () => {
    expect(clampTab('pmo', ['cw'])).toBe('cw');
    expect(clampTab('te', ['pmo', 'te'])).toBe('te');
  });
});
