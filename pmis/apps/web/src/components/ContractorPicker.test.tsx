import { describe, expect, it } from 'vitest';
import { MOCK_COMPANIES } from '@/mocks/handlers.registers';

describe('0.15.88 contractor companies (mock)', () => {
  it('offers active companies with their scopes (null = every scope)', () => {
    expect(MOCK_COMPANIES.length).toBeGreaterThan(1);
    expect(MOCK_COMPANIES.some((c) => c.scopes === null)).toBe(true);
    expect(MOCK_COMPANIES.every((c) => c.id && c.name)).toBe(true);
  });
});
