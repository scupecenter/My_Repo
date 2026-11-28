import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { db } from '@/mocks/db';
import { signIn } from '@/test/utils';

/** 0765: lessons learned that may apply to a new Issue (read only; two shared words; approved lessons only). */
type Item = { title: string; matches: number; same_site: boolean };
const ask = (q: string) => api.get<{ items: Item[] }>('/registers/issues/lesson-suggestions', { query: { q } }).then((r) => r.items);

describe('lesson suggestions', () => {
  it('lists approved lessons that share two words, best first, and nothing for a vague text', async () => {
    await signIn('pm');
    const rows = db().reg.records;
    const base = rows.find((r) => r.register_key === 'issues')!;
    const mk = (n: number, state: 'approved' | 'entry', data: Record<string, unknown>) => ({ ...base, id: `b0000000-0000-4000-8000-00000000090${n}`, entity_id: `b0000000-0000-4000-8000-00000000090${n}`, register_key: 'lessons_learned' as const, state, data });
    rows.push(mk(1, 'approved', { title: 'Cable theft at tower sites', recommendation: 'Fit clamps' }), mk(2, 'entry', { title: 'Cable theft draft' }), mk(3, 'approved', { title: 'Late concrete delivery' }));
    expect((await ask('Cable theft reported at the new site')).map((i) => [i.title, i.matches])).toEqual([['Cable theft at tower sites', 2]]);
    expect(await ask('theft pour')).toEqual([]);   // one shared word of two is not enough
    expect((await ask('theft')).length).toBe(1);   // a one-word text needs one
    expect((await ask('cable theft draft')).map((i) => i.title)).toEqual(['Cable theft at tower sites']);   // a draft never counts
    expect(await ask('the and for')).toEqual([]);
  });
});
