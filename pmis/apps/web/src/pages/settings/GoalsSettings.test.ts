import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { goalId } from './GoalsSettings';

describe('goalId', () => {
  it('makes a short a-z0-9 id from the name and keeps it unique', () => {
    expect(goalId('On-Air push!', [])).toBe('on-air-push');
    expect(goalId('On-Air push!', ['on-air-push'])).toBe('on-air-push-2');
    expect(goalId('الربط', [])).toBe('goal');
    expect(goalId('x', [])).toMatch(/^[a-z0-9-]{3,40}$/);
  });
});

describe('goals i18n', () => {
  it('has the same keys in English and Arabic', () => {
    const k = (o: unknown) => Object.keys((o as Record<string, Record<string, string>>).goals).sort();
    expect(k(ar)).toEqual(k(en));
  });
});
