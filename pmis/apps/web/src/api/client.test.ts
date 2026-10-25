import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { api, ApiError, API_BASE, setCsrfToken, setStepUpHandler } from './client';
import type { Problem } from './types';
import { signIn } from '@/test/utils';

describe('api client', () => {
  it('sends credentials, CSRF and If-Match', async () => {
    let seen: Request | undefined;
    server.use(http.post(`${API_BASE}/x`, ({ request }) => { seen = request; return HttpResponse.json({ ok: true }); }));
    setCsrfToken('tok');
    const spy = vi.spyOn(globalThis, 'fetch');
    await api.post('/x', { version: 7, body: { a: 1 }, idempotencyKey: 'k1' });
    expect(spy.mock.calls[0][1]?.credentials).toBe('include');
    spy.mockRestore();
    expect(seen!.headers.get('If-Match')).toBe('"7"');
    expect(seen!.headers.get('X-CSRF-Token')).toBe('tok');
    expect(seen!.headers.get('Idempotency-Key')).toBe('k1');
  });

  it('turns problem+json into ApiError with code and errors[]', async () => {
    await signIn('pm');
    const e = await api.post('/tasks/10000000-0000-4000-8000-000000000006/reject', { version: 1, body: { note: '' } }).then(() => { throw new Error('should fail'); }, (x: ApiError) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(422);
    expect(e.code).toBe('note_required');
    expect(e.problem.errors?.[0].path).toBe('/note');
  });

  it('maps stale If-Match to 412 and missing to 428', async () => {
    await signIn('pm');
    const id = '10000000-0000-4000-8000-000000000006';
    expect((await api.post(`/tasks/${id}/review`, { version: 99, body: {} }).then(() => { throw new Error('should fail'); }, (x: ApiError) => x)).code).toBe('precondition_failed');
    expect((await api.post(`/tasks/${id}/review`, { body: {} }).then(() => { throw new Error('should fail'); }, (x: ApiError) => x)).code).toBe('precondition_required');
  });

  it('handles a non-JSON error body', async () => {
    server.use(http.get(`${API_BASE}/boom`, () => new HttpResponse('nope', { status: 502 })));
    const e = await api.get('/boom').then(() => { throw new Error('should fail'); }, (x: ApiError) => x);
    expect(e.status).toBe(502);
    expect(e.code).toBe('unknown');
  });

  it('retries once after a successful step-up', async () => {
    await signIn('pm');
    const handler = vi.fn(async (_p: Problem) => { await api.post('/__mock/step-up'); return true; });
    setStepUpHandler(handler);
    const id = '10000000-0000-4000-8000-000000000001';
    const r = await api.post<{ task: { state: string } }>(`/tasks/${id}/approve`, { version: 1, body: {} });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].code).toBe('step_up_required');
    expect(r.task.state).toBe('approved');
    setStepUpHandler(null);
  });

  it('does not retry when the user cancels step-up', async () => {
    await signIn('pm');
    setStepUpHandler(async () => false);
    const e = await api.post('/tasks/10000000-0000-4000-8000-000000000001/approve', { version: 1, body: {} }).then(() => { throw new Error('should fail'); }, (x: ApiError) => x);
    expect(e.code).toBe('step_up_required');
    expect(e.problem.step_up_url).toContain('step-up');
    setStepUpHandler(null);
  });

  it('one step-up covers concurrent requests', async () => {
    await signIn('pm');
    const handler = vi.fn(async (_p: Problem) => { await api.post('/__mock/step-up'); return true; });
    setStepUpHandler(handler);
    const bulk = (ids: string[]) => api.post('/approvals/bulk', { body: { action: 'approve', items: ids.map((id) => ({ id, version: 1 })) } });
    await Promise.all([bulk(['10000000-0000-4000-8000-000000000001']), bulk(['10000000-0000-4000-8000-000000000002'])]);
    expect(handler).toHaveBeenCalledOnce();
    setStepUpHandler(null);
  });
});

describe('assertSafePath', () => {
  it('accepts normal API paths and rejects traversal from interpolated IDs', async () => {
    const { assertSafePath } = await import('./client');
    expect(() => assertSafePath('/tasks/3f2b-11/approve')).not.toThrow();
    for (const bad of ['/tasks/../users', '/tasks/a%2F..%2Fx', '/tasks/a?x=1', '/tasks/', '/tasks/.']) expect(() => assertSafePath(bad)).toThrow();
  });
});
