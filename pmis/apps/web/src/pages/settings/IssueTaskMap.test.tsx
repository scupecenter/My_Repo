import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';

describe('issueMap i18n', () => {
  it('has the same keys in English and Arabic', () => {
    expect(Object.keys((ar as unknown as Record<string, Record<string, string>>).issueMap).sort()).toEqual(Object.keys((en as unknown as Record<string, Record<string, string>>).issueMap).sort());
  });
});
