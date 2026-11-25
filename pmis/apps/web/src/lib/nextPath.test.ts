import { describe, expect, it } from 'vitest';
import { safeNext } from './nextPath';

describe('safeNext (authenticated share link)', () => {
  it('accepts an internal path with its filters', () => {
    expect(safeNext('/dashboard?tab=cw&region=1')).toBe('/dashboard?tab=cw&region=1');
    expect(safeNext('/sites/12#x')).toBe('/sites/12#x');
  });
  it('refuses anything that could leave the app or loop', () => {
    for (const bad of ['', null, undefined, 'dashboard', '//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/login', '/login?next=/x', '/reset-password#token=a', '/a\nb', '/%2F%2Fevil.com/..//x'.replace('%2F%2F', '\\\\')]) {
      expect(safeNext(bad as string | null | undefined)).toBeNull();
    }
  });
});
