import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';

const login = async (id?: string) => {
  const r = await fetch(`${API_BASE}/auth/login${id ? `?identifier=${encodeURIComponent(id)}` : ''}`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('Location')!, 'http://x');
  return { status: r.status, keys: [...loc.searchParams.keys()].sort(), path: loc.pathname, hint: loc.searchParams.get('login_hint'), href: loc.href };
};

describe('mock login rule', () => {
  it('behaves identically for found and not found identifiers', async () => {
    const found = await login('1103'), missing = await login('9999'), phoneFound = await login('+218 94 214 1226');
    expect(found.status).toBe(302);
    for (const x of [missing, phoneFound]) { expect(x.status).toBe(found.status); expect(x.keys).toEqual(found.keys); expect(x.path).toBe(found.path); }
  });
  it('never derives an email from an ID or phone', async () => {
    const r = await login('1103');
    expect(r.hint).toBeNull();
    expect(r.href).not.toContain('ali.barka');
    expect((await login('+218 94 214 1226')).href).not.toContain('ali.barka');
  });
  it('passes login_hint only as typed, matched or not', async () => {
    expect((await login('ali.barka@example.com')).hint).toBe('ali.barka@example.com');
    expect((await login('nobody@example.com')).hint).toBe('nobody@example.com');
  });
});
