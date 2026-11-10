// MSW handlers for site creation (contract 0.14.0, Q460): POST /sites creates a draft, /site-drafts/* is its life (edit, send to L2, L2 decides, discard).
// The rules follow the database: the Site ID is unique for ever (also against the drafts that wait), the region may be an id or a name or alias, the
// delivery scenario is one of the list, flags are Yes / No / blank, a landlord or contact field is refused (Q469), a Cancelled row creates a cancelled site.
// L1 (the entry holder) is the PM (a System Admin holds both levels), the engineer and the reviewer; L2 is the reviewer and the PM; a person who holds both approves their own
// submission at once, with step-up (B5).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { SiteDraft } from '@/api/types';
import { db, save, stepUpValid, viewer } from './db';
import { guard, page, problem, stepUp } from './handlers';
import { uid } from './ids';
import { SITE_COUNT, siteMeta } from './sites';

const B = API_BASE;
const REGIONS: Record<string, number> = { tripoli: 1, 'tripoli area': 1, middle: 2, 'middle area': 2, wm: 3, zawia: 4, 'zawia area': 4, benghazi: 5, 'benghazi area': 5, gm: 6, sebha: 7, 'sebha area': 7, 'سبها': 7, 'طرابلس': 1 };
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const ALLOWED = new Set(['site_code', 'region', 'region_id', 'name', 'name_ar', 'owner_site_id', 'cluster_code', 'delivery_scenario', 'site_scenario', 'site_type', 'project_phase', 'delivery_batch',
  'cw_delivery_model', 'scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full', 'scope_te_ip_router_only', 'overall_status', 'sub_region', 'latitude', 'longitude', 'address', 'rf_survey_date', 'workflow_locks']);
const FLAGS = ['scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full', 'scope_te_ip_router_only'];
type Stored = SiteDraft & { by: string };
type Err = { path: string; code: string; message: string };

const L1 = (k?: string) => k === 'pm' || k === 'engineer' || k === 'reviewer';
const L2 = (k?: string) => k === 'pm' || k === 'reviewer';
const drafts = () => db().siteDrafts as Stored[];
const code = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const existing = (c: string, self?: string) => Array.from({ length: SITE_COUNT }, (_, i) => siteMeta(i).code.toUpperCase()).includes(c) || drafts().some((d) => d.site_code === c && ['entry', 'in_approval'].includes(d.status) && d.id !== self);

/** What the database would answer for one proposal: the clean values, or the field errors. */
function clean(raw: Record<string, unknown>, self?: string): { data: Record<string, unknown>; errors: Err[]; warnings: SiteDraft['warnings'] } {
  const errors: Err[] = [], warnings: NonNullable<SiteDraft['warnings']> = [], data: Record<string, unknown> = {};
  const err = (f: string, c: string, m: string) => errors.push({ path: `/${f}`, code: c, message: m });
  for (const k of Object.keys(raw)) if (!ALLOWED.has(k)) err(k, 'unknown_field', 'This field is not accepted: landlord and contact data are not loaded.');
  if (errors.length) return { data, errors, warnings };
  const sc = code(raw.site_code);
  if (!sc) err('site_code', 'required', 'The Site ID is required.');
  else if (!/^[A-Z0-9]([A-Z0-9 ._/-]{0,38}[A-Z0-9])?$/.test(sc)) err('site_code', 'invalid', 'A Site ID uses Latin letters and digits.');
  else if (existing(sc, self)) err('site_code', 'duplicate', 'This Site ID exists already. A Site ID is never reused.');
  else data.site_code = sc;
  const rt = String(raw.region ?? '').trim().toLowerCase();
  const rid = raw.region_id !== undefined && raw.region_id !== null && raw.region_id !== '' ? Number(raw.region_id) : rt ? REGIONS[rt] : undefined;
  if (rt && !REGIONS[rt]) err('region', 'unknown_region', 'Unknown region. Use a region name, its code or a known alias.');
  else if (!rid || rid < 1 || rid > 7) err('region', rid === undefined ? 'required' : 'unknown_region', rid === undefined ? 'The region is required.' : 'Unknown region.');
  else data.region_id = rid;
  if (!String(raw.name ?? '').trim()) err('name', 'required', 'The English site name is required.'); else data.name = String(raw.name).trim();
  if (String(raw.name_ar ?? '').trim()) data.name_ar = String(raw.name_ar).trim();
  const ds = String(raw.delivery_scenario ?? '').trim().toLowerCase().replace(/ /g, '_');
  if (!ds) err('delivery_scenario', 'required', 'The delivery scenario is required.');
  else if (!SCENARIOS.includes(ds)) err('delivery_scenario', 'not_in_list', 'Not a delivery scenario.');
  else data.delivery_scenario = ds;
  for (const k of ['owner_site_id', 'project_phase', 'delivery_batch', 'cw_delivery_model', 'sub_region', 'address', 'site_type']) if (String(raw[k] ?? '').trim()) data[k] = String(raw[k]).trim();
  if (String(raw.site_scenario ?? '').trim()) {
    const v = ['Indoor', 'Outdoor'].find((x) => x.toLowerCase() === String(raw.site_scenario).trim().toLowerCase());
    if (v) data.site_scenario = v; else err('site_scenario', 'not_in_list', 'Not a value of the list.');
  }
  if (String(raw.cluster_code ?? '').trim()) {
    data.cluster_code = String(raw.cluster_code).trim().toUpperCase();
    warnings.push({ field: 'cluster_code', code: 'cluster_will_be_created', message: 'This cluster does not exist yet: it is created in the region of the site when L2 approves.' });
  }
  for (const k of FLAGS) {
    const v = String(raw[k] ?? '').trim().toLowerCase();
    if (!v) continue;
    if (['yes', 'y', 'true'].includes(v)) data[k] = 'yes'; else if (['no', 'n/a', 'na', 'false'].includes(v)) data[k] = 'na'; else err(k, 'invalid', 'Yes, No or blank.');
  }
  if (data.delivery_scenario && ['hot_swap', 'cold_swap'].includes(String(data.delivery_scenario)) && FLAGS.some((k) => data[k] === 'yes')) err('delivery_scenario', 'scope_scenario_conflict', 'The scenario and the scope flags disagree.');
  const os = String(raw.overall_status ?? '').trim().toLowerCase().replace(/ /g, '_');
  if (os) { if (['not_started', 'cancelled'].includes(os)) data.overall_status = os; else err('overall_status', 'invalid', 'A new site is Not Started, or Cancelled.'); }
  const lat = raw.latitude, lon = raw.longitude, has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  if (has(lat) !== has(lon)) err(has(lat) ? 'longitude' : 'latitude', 'pair_required', 'Latitude and longitude go together.');
  else if (has(lat)) {
    if (!(Math.abs(Number(lat)) <= 90)) err('latitude', 'invalid', 'A latitude is a number from -90 to 90.');
    if (!(Math.abs(Number(lon)) <= 180)) err('longitude', 'invalid', 'A longitude is a number from -180 to 180.');
    if (!errors.some((e) => e.path === '/latitude' || e.path === '/longitude')) { data.latitude = Number(lat); data.longitude = Number(lon); }
  }
  if (has(raw.rf_survey_date)) {
    const d = String(raw.rf_survey_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) err('rf_survey_date', 'invalid', 'A date as yyyy-mm-dd.');
    else if (d > new Date().toISOString().slice(0, 10)) err('rf_survey_date', 'future_date', 'An actual date cannot be in the future.');
    else data.rf_survey_date = d;
  }
  // 0.15.4 (migration 0085): Workflow locks, Locked (default) or Open
  if (has(raw.workflow_locks)) {
    const w = String(raw.workflow_locks).trim().toLowerCase();
    if (w === 'locked' || w === 'open') data.workflow_locks = w; else err('workflow_locks', 'invalid', 'Workflow locks is Locked or Open.');
  }
  return { data, errors, warnings };
}

const actionsOf = (d: Stored): SiteDraft['allowed_actions'] => {
  const v = viewer();
  if (!v || d.batch_id) return [];
  if (d.status === 'entry' && L1(v.key)) return d.by === (v.employee_id ?? '') || v.key === 'pm' ? ['edit', 'submit', 'discard'] : ['edit', 'submit'];
  if (d.status === 'in_approval' && L2(v.key)) return ['approve', 'reject'];
  return [];
};
const view = (d: Stored): SiteDraft => { const { by: _by, ...rest } = d; void _by; return { ...rest, allowed_actions: actionsOf(d) }; };
const tagged = (d: Stored, status = 200) => HttpResponse.json(view(d), { status, headers: { ETag: `"${d.version}"` } });
/** If-Match on a draft: its version, as on every versioned resource. */
const ifMatch = (req: Request, d: Stored) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === d.version ? null : problem(412, 'precondition_failed', 'The draft changed; reload and retry');
};
const find = (id: unknown) => drafts().find((d) => d.id === id);
const touch = (d: Stored) => { d.version += 1; save(); };
const user = () => { const v = viewer()!; return { id: uid(v.employee_id ?? '9999'), display_name: v.name }; };
const mine = (d: Stored) => d.by === (viewer()?.employee_id ?? '');

export const siteCreationHandlers = [
  http.post(`${B}/sites`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!L1(viewer()?.key)) return problem(403, 'action_forbidden', 'You need create on sites to propose a new site.');
    const body = (await request.json()) as Record<string, unknown>;
    const r = clean(body);
    if (r.errors.length) return problem(422, 'validation_failed', 'The new site is not valid.', { errors: r.errors } as never);
    const now = new Date().toISOString(), v = viewer()!;
    const d: Stored = { id: crypto.randomUUID(), site_code: String(r.data.site_code), region_id: Number(r.data.region_id), status: 'entry', data: r.data, version: 1, created_by: user(), created_at: now,
      submitted_at: null, decided_by: null, decided_at: null, decision_note: null, return_count: 0, last_return_note: null, self_approval: false, site_id: null, batch_id: null,
      warnings: r.warnings, allowed_actions: [], by: v.employee_id ?? '' };
    drafts().unshift(d); save();
    return tagged(d, 201);
  }),
  http.get(`${B}/site-drafts`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, status = u.get('status'), q = (u.get('q') ?? '').toLowerCase();
    const items = drafts().filter((d) => (!status || d.status === status) && (u.get('mine') !== 'true' || mine(d)) && (u.get('waiting_for_me') !== 'true' || actionsOf(d).includes('approve'))
      && (!q || `${d.site_code} ${String(d.data.name ?? '')}`.toLowerCase().includes(q))).map(view);
    return page(items);
  }),
  http.get(`${B}/site-drafts/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const d = find(params.id);
    return d ? tagged(d) : problem(404, 'not_found', 'The draft does not exist or is not visible to you.');
  }),
  http.patch(`${B}/site-drafts/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const d = find(params.id);
    if (!d) return problem(404, 'not_found', 'The draft does not exist or is not visible to you.');
    const bad = ifMatch(request, d); if (bad) return bad;
    if (d.status !== 'entry' || !L1(viewer()?.key)) return problem(d.status !== 'entry' ? 409 : 403, d.status !== 'entry' ? 'invalid_transition' : 'not_eligible_holder', 'Only a draft in entry can be changed, by an L1 holder.');
    const r = clean((await request.json()) as Record<string, unknown>, d.id);
    if (r.errors.length) return problem(422, 'validation_failed', 'The new site is not valid.', { errors: r.errors } as never);
    Object.assign(d, { site_code: String(r.data.site_code), region_id: Number(r.data.region_id), data: r.data, warnings: r.warnings }); touch(d);
    return tagged(d);
  }),
  http.delete(`${B}/site-drafts/:id`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const d = find(params.id);
    if (!d) return problem(404, 'not_found', 'The draft does not exist or is not visible to you.');
    const bad = ifMatch(request, d); if (bad) return bad;
    if (d.status !== 'entry') return problem(409, 'invalid_transition', 'Only a draft in entry can be discarded.');
    if (!mine(d) && viewer()?.key !== 'pm') return problem(403, 'not_eligible_holder', 'Only the person who entered the draft (or a System Admin) can discard it.');
    d.status = 'discarded'; touch(d);
    return tagged(d);
  }),
  http.post(`${B}/site-drafts/:id/submit`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const d = find(params.id);
    if (!d) return problem(404, 'not_found', 'The draft does not exist or is not visible to you.');
    const bad = ifMatch(request, d); if (bad) return bad;
    if (d.status !== 'entry') return problem(409, 'invalid_transition', `The draft is ${d.status}: it cannot be submitted.`);
    if (!L1(viewer()?.key)) return problem(403, 'not_eligible_holder', 'You are not a Data Entry holder (L1) of the Site creation row.');
    const self = L2(viewer()?.key);
    if (self && !stepUpValid()) return stepUp();     // B5: the same person holds both levels, so the submission is the final approval
    d.status = self ? 'approved' : 'in_approval'; d.submitted_at = new Date().toISOString(); d.self_approval = self;
    if (self) { d.site_id = siteMeta(0).id; d.decided_by = user(); d.decided_at = d.submitted_at; }
    touch(d);
    return tagged(d);
  }),
  http.post(`${B}/site-drafts/:id/decide`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const d = find(params.id);
    if (!d) return problem(404, 'not_found', 'The draft does not exist or is not visible to you.');
    const bad = ifMatch(request, d); if (bad) return bad;
    const body = (await request.json()) as { action?: string; note?: string };
    if (d.status !== 'in_approval') return problem(409, 'invalid_transition', `The draft is ${d.status}: it is not waiting for a decision.`);
    if (!L2(viewer()?.key)) return problem(403, 'not_eligible_holder', 'You are not a Review and Approve holder (L2) of the Site creation row.');
    if (body.action === 'reject') {
      if (!body.note?.trim()) return problem(422, 'note_required', 'A note is required', { errors: [{ path: '/note', code: 'required' }] } as never);
      Object.assign(d, { status: 'entry', return_count: (d.return_count ?? 0) + 1, last_return_note: body.note.trim(), decision_note: body.note.trim(), decided_by: user(), decided_at: new Date().toISOString() });
    } else {
      if (!stepUpValid()) return stepUp();
      // 0.15.4: a site created Open needs a System Admin (or the delegated right to unlock) at the approval
      if (d.data?.workflow_locks === 'open' && viewer()?.key !== 'pm') return problem(403, 'action_forbidden', 'A site with its workflow locks off is approved only by a System Admin or a holder of the delegated right to unlock.');
      Object.assign(d, { status: 'approved', site_id: siteMeta(0).id, decided_by: user(), decided_at: new Date().toISOString(), self_approval: mine(d) });
    }
    touch(d);
    return tagged(d);
  }),
];
