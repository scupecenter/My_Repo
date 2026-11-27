import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import { viewer } from './db';
import { guard, problem } from './handlers';
import { REGISTER_DEFS } from './registersData';

/**
 * Contract 0.15.138: the enabled and locked state of every register, as reg_state_json and admin_register_state of migration 0381 decide them. Synthetic: the
 * state starts as enabled and unlocked for every mock register, a change needs a reason (3 characters) and the System Admin viewer, a stale version answers 412.
 */
type S = { enabled: boolean; locked: boolean; reason: string | null; changed_at: string | null; version: number };
const STATE: Record<string, S> = {};
const st = (key: string): S => (STATE[key] ??= { enabled: true, locked: false, reason: null, changed_at: null, version: 1 });
const isAdmin = () => viewer()?.key === 'pm';
const forbidden = () => problem(403, 'action_forbidden', 'You are not allowed to do this.');

export const registerStateHandlers = [
  http.get(`${B}/settings/register-state`, () => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    return HttpResponse.json({
      items: REGISTER_DEFS.map((d) => ({ register_key: d.register_key, name_en: d.name_en, name_ar: d.name_ar ?? null, module_key: d.module_key, records: 3, ...st(d.register_key) })),
    });
  }),
  http.put(`${B}/settings/register-state/:key`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return forbidden();
    const key = String(params.key);
    if (!REGISTER_DEFS.some((d) => d.register_key === key)) return problem(404, 'not_found', 'The register does not exist.');
    const b = (await request.json()) as { enabled?: boolean; locked?: boolean; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    const s = st(key);
    const m = /"(\d+)"/.exec(request.headers.get('if-match') ?? '');
    if (m && Number(m[1]) !== s.version) return problem(412, 'precondition_failed', 'Precondition failed');
    if (b.enabled !== undefined) s.enabled = b.enabled;
    if (b.locked !== undefined) s.locked = b.locked;
    s.reason = (b.reason ?? '').trim();
    s.changed_at = new Date().toISOString();
    s.version += 1;
    return HttpResponse.json({ register_key: key, enabled: s.enabled, locked: s.locked, reason: s.reason, changed_at: s.changed_at, version: s.version }, { headers: { ETag: `"${s.version}"` } });
  }),
];
