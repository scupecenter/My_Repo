// MSW handlers of the personal record templates (contract 0.15.621). Like the real API: only the caller's own, names unique per register among the active ones,
// at most 30 per register, plain values only, hidden and never deleted. The state is per mock database and per viewer.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { RecordTemplate } from '@/api/recordTemplates';
import { db, viewer, type Db } from './db';
import { guard, problem } from './handlers';

const B = API_BASE;
type Row = RecordTemplate & { owner: string; is_active: boolean };
const states = new WeakMap<Db, Row[]>();
const S = (): Row[] => { const d = db(); let s = states.get(d); if (!s) { s = []; states.set(d, s); } return s; };
let seq = 0;
const owner = () => viewer()?.key ?? 'anon';
const dto = (r: Row): RecordTemplate => ({ id: r.id, register_key: r.register_key, name: r.name, record_type: r.record_type, data: r.data, created_at: r.created_at });
const bad = (path: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code: 'invalid', message: 'invalid' }] });
const plain = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

export const recordTemplateHandlers = [
  http.get(`${B}/record-templates`, ({ request }) => {
    const g = guard(); if (g) return g;
    const key = new URL(request.url).searchParams.get('register_key') ?? '';
    if (!/^[a-z][a-z0-9_-]{0,80}$/.test(key)) return bad('/register_key');
    return HttpResponse.json({ items: S().filter((r) => r.owner === owner() && r.is_active && r.register_key === key).sort((a, b) => a.name.localeCompare(b.name)).map(dto) });
  }),
  http.post(`${B}/record-templates`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { register_key?: string; name?: string; record_type?: string | null; data?: Record<string, unknown> };
    const name = (b.name ?? '').trim();
    if (!b.register_key || !/^[a-z][a-z0-9_-]{0,80}$/.test(b.register_key)) return bad('/register_key');
    if (!name || name.length > 60) return bad('/name');
    if (!b.data || typeof b.data !== 'object' || !Object.values(b.data).every(plain)) return bad('/data');
    const mine = S().filter((r) => r.owner === owner() && r.is_active && r.register_key === b.register_key);
    if (mine.length >= 30) return bad('/name');
    if (mine.some((r) => r.name.toLowerCase() === name.toLowerCase())) return problem(409, 'duplicate', 'Duplicate');
    const r: Row = { id: `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`, register_key: b.register_key, name, record_type: b.record_type ?? null, data: b.data as RecordTemplate['data'], created_at: new Date().toISOString(), owner: owner(), is_active: true };
    S().push(r);
    return HttpResponse.json(dto(r), { status: 201 });
  }),
  http.post(`${B}/record-templates/:id/archive`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = S().find((x) => x.id === String(params.id) && x.owner === owner() && x.is_active);
    if (!r) return problem(404, 'not_found', 'Not found');
    r.is_active = false;
    return HttpResponse.json(dto(r));
  }),
];
