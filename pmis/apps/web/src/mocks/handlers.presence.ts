// MSW handlers of the soft "… is editing this record" notice (contract 0.15.246, migration 0345, item 17). Like the API: the heartbeat keeps
// the caller's row fresh (2 minutes), stop removes it, the list shows the other current editors. The state is per mock database.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { viewer } from './db';
import { guard, problem } from './handlers';

const B = API_BASE;
type Row = { user: string; name: string; employee_id: string | null; kind: string; entity: string; started: number; seen: number };
// localStorage-backed, so the state survives the full page loads of the dev-server visual check (each vitest file has its own storage).
const LS = 'pmis.mock.presence';
const S = (): Row[] => {
  try { return JSON.parse(globalThis.localStorage?.getItem(LS) ?? '[]') as Row[]; } catch { return []; }
};
const put = (rows: Row[]) => { try { globalThis.localStorage?.setItem(LS, JSON.stringify(rows)); } catch { /* blocked storage */ } };
const FRESH = 2 * 60_000;
const invalid = (path: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code: 'invalid', message: 'invalid' }] });

export const presenceHandlers = [
  http.post(`${B}/presence/editing`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { kind?: string; entity_id?: string };
    if ((b.kind !== 'record' && b.kind !== 'task') || !b.entity_id) return invalid(b.kind !== 'record' && b.kind !== 'task' ? '/kind' : '/entity_id');
    const v = viewer()!;
    const now = Date.now();
    const rows = S().filter((r) => now - r.seen < FRESH);
    const hit = rows.find((r) => r.user === v.key && r.kind === b.kind && r.entity === b.entity_id);
    if (hit) hit.seen = now; else rows.push({ user: v.key, name: v.name, employee_id: v.employee_id ?? null, kind: b.kind, entity: b.entity_id, started: now, seen: now });
    put(rows);
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${B}/presence/editing/stop`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { kind?: string; entity_id?: string };
    const v = viewer()!;
    put(S().filter((r) => !(r.user === v.key && r.kind === b.kind && r.entity === b.entity_id)));
    return HttpResponse.json({ ok: true });
  }),
  // Test-only: plant another editor's row (the dev-server visual check cannot hold two sessions in one browser).
  http.post(`${B}/__mock/presence-seed`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { kind?: string; entity_id?: string; name?: string };
    const rows = S();
    rows.push({ user: '__other', name: b.name ?? 'Demo User 02', employee_id: '1102', kind: b.kind ?? 'record', entity: String(b.entity_id), started: Date.now(), seen: Date.now() });
    put(rows);
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${B}/presence/editing`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url);
    const kind = u.searchParams.get('kind'), entity = u.searchParams.get('entity_id');
    const now = Date.now(), v = viewer()!;
    const editors = S().filter((r) => r.kind === kind && r.entity === entity && r.user !== v.key && now - r.seen < FRESH)
      .map((r) => ({ id: r.user, display_name: r.name, employee_id: r.employee_id, since: new Date(r.started).toISOString() }));
    return HttpResponse.json({ editors });
  }),
];
