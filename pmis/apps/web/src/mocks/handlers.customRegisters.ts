import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { CustomRegister } from '@/api/customRegisters';
import { viewer } from './db';
import { guard, problem } from './handlers';

/**
 * Contract 0.15.533: custom registers, as admin_register_create, admin_register_update and admin_register_enable of migration 0531 decide them. Synthetic: only the System
 * Admin (account `pm`) writes; a reason is needed; the key is `custom_` and letters from the English name; the limit is 20; enable needs a column and a required column
 * (the mock counts the columns the test sets with `setCustomRegisterColumns`).
 */
const R: CustomRegister[] = [];
const PLAN: Record<string, [number, number]> = {};
const MAX = 20;
const isAdmin = () => viewer()?.key === 'pm';
const reasonOk = (b: { reason?: string }) => (b.reason ?? '').trim().length >= 3;
const invalid = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });
const out = (r: CustomRegister, status = 200) => HttpResponse.json(r, { status, headers: { ETag: `"${r.version}"` } });
const slug = (name: string) => 'custom_' + (name.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'register');
const find = (key: unknown) => R.find((r) => r.register_key === key);

export const customRegisterHandlers = [
  http.get(`${B}/custom-registers`, () => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    return HttpResponse.json({ items: R, limit: { max: MAX, active: R.filter((r) => r.is_active).length } });
  }),
  http.post(`${B}/custom-registers`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const b = (await request.json()) as { name_en?: string; name_ar?: string | null; site_scoped?: boolean; multiple_per_site?: boolean; reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    if (!b.name_en || b.name_en.trim().length < 2) return invalid('/name_en', 'required');
    if (R.filter((r) => r.is_active).length >= MAX) return problem(409, 'limit_reached', 'The limit of custom registers is reached.');
    let key = slug(b.name_en);
    while (find(key)) key += '_aa';
    const r: CustomRegister = {
      register_key: key, module_key: key, name_en: b.name_en.trim(), name_ar: b.name_ar ?? null, site_scoped: !!b.site_scoped, multiple_per_site: b.multiple_per_site ?? true,
      enabled: false, is_active: true, version: 1, created_at: '2026-11-28T08:00:00Z', field_count: 0, required_count: 0, record_count: 0, template_id: null,
    };
    const plan = PLAN[key]; if (plan) { r.field_count = plan[0]; r.required_count = plan[1]; }
    R.push(r);
    return out(r, 201);
  }),
  http.get(`${B}/custom-registers/:key`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = find(params.key);
    return r ? out(r) : problem(404, 'not_found', 'This is not a custom register.');
  }),
  http.patch(`${B}/custom-registers/:key`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const r = find(params.key);
    if (!r) return problem(404, 'not_found', 'This is not a custom register.');
    const b = (await request.json()) as { name_en?: string; name_ar?: string | null; is_active?: boolean; reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    if (b.name_en) r.name_en = b.name_en.trim();
    if ('name_ar' in b) r.name_ar = b.name_ar ?? null;
    if (b.is_active !== undefined) r.is_active = b.is_active;
    r.version += 1;
    return out(r);
  }),
  http.post(`${B}/custom-registers/:key/enable`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const r = find(params.key);
    if (!r) return problem(404, 'not_found', 'This is not a custom register.');
    const b = (await request.json()) as { reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    if (r.field_count === 0 || r.required_count === 0) return invalid('/key', 'needs_required_column');
    r.enabled = true; r.template_id = `TPL-${r.register_key.toUpperCase()}`; r.version += 1;
    return out(r);
  }),
];
/** Test helpers. */
export const resetCustomRegisters = () => { R.length = 0; for (const k of Object.keys(PLAN)) delete PLAN[k]; };
export const setCustomRegisterColumns = (key: string, fields: number, required: number) => { PLAN[key] = [fields, required]; const r = find(key); if (r) { r.field_count = fields; r.required_count = required; } };
