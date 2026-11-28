import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { IntakeForm } from '@/api/intake';
import { viewer } from './db';
import { guard, problem } from './handlers';

/**
 * Contract 0.15.600: public intake forms, as intake_form_save, intake_form_peek and the submit door of migration 0730 decide them. Synthetic: the System Admin (account `pm`)
 * manages the forms; the token is shown once and only its last 4 characters are kept; the public routes need no session and answer one 404 for any link that does not work;
 * the honeypot field `website` writes nothing; the sharing lock is `setIntakeLocked(true)`.
 */
type Stored = IntakeForm & { token: string };
const F: Stored[] = [];
const SUBS: Record<string, { id: string; created_at: string; reporter_name: string | null; reporter_contact: string | null; record_id: string | null; triage_state: string | null }[]> = {};
let locked = false;
let seq = 0;
export const setIntakeLocked = (v: boolean) => { locked = v; };
export const resetIntake = () => { F.length = 0; for (const k of Object.keys(SUBS)) delete SUBS[k]; locked = false; seq = 0; };
export const intakeSubmissions = (id: string) => SUBS[id] ?? [];
const isAdmin = () => viewer()?.key === 'pm';
const strip = ({ token: _t, ...f }: Stored): IntakeForm => f;
const out = (f: Stored, status = 200, withToken = false) => HttpResponse.json(withToken ? { ...strip(f), token: f.token } : strip(f), { status, headers: { ETag: `"${f.version}"`, 'Cache-Control': 'no-store' } });
const invalid = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });
const gone = () => problem(404, 'not_found', 'This form is not available.');
const FIELDS = [
  { code: 'title', label_en: 'Title', label_ar: 'المشكلة', type: 'text', required: true, options: null },
  { code: 'remark', label_en: 'Remark', label_ar: null, type: 'text', required: false, options: null },
] as const;
const byToken = (t: unknown) => F.find((f) => f.token === t && f.is_active && !locked && (!f.expires_at || new Date(f.expires_at) > new Date()));

export const intakeHandlers = [
  http.get(`${B}/intake-forms`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json({ sharing_locked: locked, items: F.map(strip) }, { headers: { 'Cache-Control': 'no-store' } });
  }),
  http.post(`${B}/intake-forms`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    if (locked) return problem(403, 'action_forbidden', 'Public sharing is switched off by a System Admin.', { errors: [{ path: '', code: 'sharing_locked' }] });
    const b = (await request.json()) as Partial<IntakeForm>;
    if (b.register_key !== 'issues' && b.register_key !== 'change_control') return invalid('/register_key', 'no_triage');
    if (!b.name?.trim()) return invalid('/name', 'required');
    if (!b.field_codes?.length) return invalid('/field_codes', 'invalid');
    seq += 1;
    const token = `T${String(seq).padStart(42, '0')}x`;
    const f: Stored = { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, name: b.name.trim(), register_key: b.register_key, register_name_en: b.register_key === 'issues' ? 'Issue Log' : 'Change Control Log', register_name_ar: null,
      site_id: b.site_id ?? '', site_code: 'S001', record_type: b.record_type ?? null, field_codes: b.field_codes, fixed: b.fixed ?? {}, intro_en: b.intro_en ?? null, intro_ar: b.intro_ar ?? null, thanks_en: b.thanks_en ?? null, thanks_ar: b.thanks_ar ?? null,
      owner_id: viewer()?.employee_id ?? '', owner_name: viewer()?.key ?? 'pm', token_hint: token.slice(-4), is_active: true, expires_at: b.expires_at ?? null, max_per_hour: b.max_per_hour ?? 20, ask_contact: b.ask_contact ?? true, version: 1,
      created_at: '2026-11-28T10:00:00Z', updated_at: '2026-11-28T10:00:00Z', submissions_total: 0, submissions_24h: 0, last_submission_at: null, token };
    F.push(f);
    return out(f, 201, true);
  }),
  http.get(`${B}/intake-forms/:id/submissions`, ({ params }) => {
    const g = guard(); if (g) return g;
    return HttpResponse.json({ items: SUBS[String(params.id)] ?? [] });
  }),
  http.patch(`${B}/intake-forms/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const f = F.find((x) => x.id === params.id);
    if (!f) return problem(404, 'not_found', 'The form does not exist or is not visible to you.');
    if (request.headers.get('If-Match') !== `"${f.version}"`) return problem(412, 'precondition_failed', 'Changed meanwhile.');
    const b = (await request.json()) as Partial<IntakeForm>;
    if (b.is_active === true && locked) return problem(403, 'action_forbidden', 'Public sharing is switched off by a System Admin.', { errors: [{ path: '', code: 'sharing_locked' }] });
    Object.assign(f, b, { version: f.version + 1 });
    return out(f);
  }),
  http.post(`${B}/intake-forms/:id/replace-link`, ({ params }) => {
    const g = guard(); if (g) return g;
    const f = F.find((x) => x.id === params.id);
    if (!f) return problem(404, 'not_found', 'The form does not exist or is not visible to you.');
    if (locked) return problem(403, 'action_forbidden', 'Public sharing is switched off by a System Admin.', { errors: [{ path: '', code: 'sharing_locked' }] });
    seq += 1; f.token = `R${String(seq).padStart(42, '0')}x`; f.token_hint = f.token.slice(-4); f.version += 1;
    return out(f, 200, true);
  }),
  http.delete(`${B}/intake-forms/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = F.findIndex((x) => x.id === params.id);
    if (i < 0) return problem(404, 'not_found', 'The form does not exist or is not visible to you.');
    if (F[i]!.is_active) return problem(409, 'invalid_transition', 'Switch the form off before deleting it.');
    F.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  // the public side: no session, no guard
  http.get(`${B}/public/intake/:token`, ({ params }) => {
    const f = byToken(params.token);
    if (!f) return gone();
    const fields = FIELDS.filter((x) => f.field_codes.includes(x.code));
    return HttpResponse.json({ name: f.name, intro_en: f.intro_en, intro_ar: f.intro_ar, ask_contact: f.ask_contact, fields }, { headers: { 'Cache-Control': 'no-store' } });
  }),
  http.post(`${B}/public/intake/:token`, async ({ params, request }) => {
    const f = byToken(params.token);
    if (!f) return gone();
    const b = (await request.json()) as { values: Record<string, unknown>; reporter_name?: string; reporter_contact?: string; website?: string };
    const thanks = { ok: true, thanks_en: f.thanks_en, thanks_ar: f.thanks_ar };
    if (b.website && b.website.trim()) return HttpResponse.json(thanks, { status: 201 });
    for (const x of FIELDS.filter((y) => f.field_codes.includes(y.code))) {
      if (x.required && !String(b.values[x.code] ?? '').trim()) return invalid(`/values/${x.code}`, 'required');
      if (/[<>]/.test(String(b.values[x.code] ?? ''))) return invalid(`/values/${x.code}`, 'markup_not_allowed');
    }
    const list = (SUBS[f.id] ??= []);
    list.unshift({ id: `s${list.length}`, created_at: '2026-11-28T10:30:00Z', reporter_name: b.reporter_name ?? null, reporter_contact: f.ask_contact ? b.reporter_contact ?? null : null, record_id: `r${list.length}`, triage_state: 'pending' });
    f.submissions_total += 1; f.submissions_24h += 1;
    return HttpResponse.json(thanks, { status: 201 });
  }),
];
