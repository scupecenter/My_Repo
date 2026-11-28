import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { signIn } from '@/test/utils';

const code = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('personal record templates (mock API)', () => {
  it('save, list, unique name, plain values only, hide; another person sees none', async () => {
    await signIn('pm');
    const made = await api.post<{ id: string }>('/record-templates', { body: { register_key: 'procurement', name: 'Weekly', record_type: 'pr', data: { remark: 'x', qty: 2 } } });
    expect((await api.get<{ items: { id: string }[] }>('/record-templates', { query: { register_key: 'procurement' } })).items.map((x) => x.id)).toEqual([made.id]);
    expect(await code(api.post('/record-templates', { body: { register_key: 'procurement', name: 'weekly', data: {} } }))).toBe('409:duplicate');
    expect(await code(api.post('/record-templates', { body: { register_key: 'procurement', name: 'n', data: { a: { b: 1 } } } }))).toBe('422:validation_failed');
    await signIn('engineer');
    expect((await api.get<{ items: unknown[] }>('/record-templates', { query: { register_key: 'procurement' } })).items).toEqual([]);
    expect(await code(api.post(`/record-templates/${made.id}/archive`))).toBe('404:not_found');
    await signIn('pm');
    await api.post(`/record-templates/${made.id}/archive`);
    expect((await api.get<{ items: unknown[] }>('/record-templates', { query: { register_key: 'procurement' } })).items).toEqual([]);
  });
});
