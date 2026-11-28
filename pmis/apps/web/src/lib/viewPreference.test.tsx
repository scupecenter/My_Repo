import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { signIn } from '@/test/utils';
import { useRememberedView } from './viewPreference';

/** The remembered layout is read once per screen, also under StrictMode (effect, cleanup, effect). */
describe('useRememberedView', () => {
  const stored = () => http.get(`${API_BASE}/me/drafts/:key`, () => HttpResponse.json({ key: 'form.viewpref.t', payload: { layout: 'list' }, version: 1, saved_at: new Date().toISOString() }));
  it('applies the remembered layout once under StrictMode', async () => {
    await signIn('pm');
    server.use(stored());
    const seen: string[] = [];
    const wrap = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useRememberedView('t', false, (l) => l === 'list', (l) => seen.push(l)), { wrapper: wrap });
    await waitFor(() => expect(seen).toEqual(['list']));
  });
  it('applies nothing when the address already names a layout', async () => {
    await signIn('pm');
    server.use(stored());
    const seen: string[] = [];
    renderHook(() => useRememberedView('t', true, () => true, (l) => seen.push(l)));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]);
  });
});
