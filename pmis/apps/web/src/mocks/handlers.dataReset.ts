// Mock of the project data reset in Settings (contract 0.15.62, migration 0146), synthetic data only. The mock `pm` account is the only System Admin a
// test signs in as; a second, synthetic System Admin ("Second Admin") exists so a request can be made. A test that needs the approver's view makes the
// request with `POST /__mock/data-reset/request-by-other`. A run completes at once.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DataResetRequest, DataResetState } from '@/api/dataReset';
import { db, stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { uid } from './ids';
import { isSystemAdmin } from './waiverData';

const B = API_BASE;
const PHRASE = 'RESET pmis';
const OTHER = { id: uid('9002'), display_name: 'Second Admin (synthetic)', employee_id: '9002' };
const me = () => ({ id: uid(viewer()?.employee_id ?? '1001'), display_name: viewer()?.name ?? 'Ahmed Salem', employee_id: viewer()?.employee_id ?? '1001' });
const now = () => new Date().toISOString();

interface St { request: DataResetRequest | null; last: DataResetRequest | null; settings: { request_expiry_minutes: number; backup_max_age_hours: number; version: number }; backupOk: boolean }
const states = new WeakMap<object, St>();
function st(): St {
  const k = db() as unknown as object;
  let s = states.get(k);
  if (!s) { s = { request: null, last: null, settings: { request_expiry_minutes: 30, backup_max_age_hours: 24, version: 1 }, backupOk: true }; states.set(k, s); }
  if (s.request && ['requested', 'approved'].includes(s.request.status) && new Date(s.request.expires_at).getTime() <= Date.now()) {
    s.last = { ...s.request, status: 'expired', expired: true, version: s.request.version + 1 };
    s.request = null;
  }
  return s;
}

const TABLES: DataResetState['plan']['tables'] = [
  { table: 'sites', action: 'delete', rows: 12, delete: 12, keep: 0 },
  { table: 'task_instances', action: 'delete', rows: 540, delete: 540, keep: 0 },
  { table: 'notifications', action: 'delete', rows: 87, delete: 87, keep: 0 },
  { table: 'register_records', action: 'mixed', rows: 64, delete: 58, keep: 6 },
  { table: 'document_files', action: 'mixed', rows: 33, delete: 31, keep: 2 },
  { table: 'users', action: 'keep', rows: 25, delete: 0, keep: 25 },
  { table: 'settings', action: 'keep', rows: 40, delete: 0, keep: 40 },
  { table: 'audit_log', action: 'log', rows: 5120, delete: 0, keep: 5120 },
];

function view(): DataResetState {
  const s = st(), r = s.request, mine = r?.requested_by.id === me().id;
  return {
    database: 'pmis', confirmation_phrase: PHRASE, settings: s.settings, system_admins_active: 2, single_admin: false, script_running: false, maintenance: false,
    backup: { ok: s.backupOk, max_age_hours: s.settings.backup_max_age_hours,
      last_success: { system_log_id: 1, at: new Date(Date.now() - (s.backupOk ? 3 : 30) * 3_600_000).toISOString(), type: 'full', mode: 'full', repository: '1', stanza: 'gsdn-pmis' }, last_problem: null },
    plan: { tables: r && r.status === 'completed' ? [] : TABLES, delete_rows: 728, keep_rows: 5193, files: 31 },
    request: r, last_request: s.last,
    can: { request: !r, approve: r?.status === 'requested' && !mine, start: r?.status === 'approved' && (mine || r.approved_by?.id === me().id), cancel: !!r && ['requested', 'approved'].includes(r.status), retry_files: false },
    storage: { driver: 'local', supported: true },
  };
}

function admin() {
  const g = guard(); if (g) return g;
  if (!isSystemAdmin()) return problem(403, 'action_forbidden', 'Action not allowed', { detail: 'Only a System Admin may use the project data reset.' });
  return null;
}
const fresh = (by: DataResetRequest['requested_by'], reason: string, minutes: number): DataResetRequest => ({
  id: crypto.randomUUID(), status: 'requested', version: 1, database_name: 'pmis', requested_by: by, requested_at: now(), request_reason: reason,
  expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), expired: false, approved_by: null, approved_at: null, approve_reason: null, cancelled_by: null,
  cancelled_at: null, cancel_reason: null, run_by: null, run_started_at: null, db_committed_at: null, finished_at: null, stalled: false, backup: null,
  plan_at_request: { delete_rows: 728, files: 31, sites: 12 }, result: null, quarantine_dir: null, error: null,
  files: { total: 0, moved: 0, missing: 0, refused: 0, pending: 0, problems: [] },
});
const json = (r: DataResetRequest, status = 200) => HttpResponse.json(r, { status, headers: { ETag: `"${r.version}"` } });
const version = (req: Request, r: DataResetRequest) => {
  const h = req.headers.get('If-Match');
  if (!h || h.trim() === '*') return problem(428, 'precondition_required', 'If-Match is required');
  if (h.replace(/"/g, '') !== String(r.version)) return problem(412, 'precondition_failed', 'The resource changed');
  return null;
};
const reason = (b: { reason?: string }, min: number) =>
  ((b.reason ?? '').trim().length < min ? problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] as never }) : null);

export const dataResetHandlers = [
  http.post(`${B}/__mock/data-reset/request-by-other`, () => { st().request = fresh(OTHER, 'Owner decision: start the real data load', 30); return HttpResponse.json(st().request); }),
  http.post(`${B}/__mock/data-reset/backup`, async ({ request }) => { st().backupOk = ((await request.json()) as { ok: boolean }).ok; return HttpResponse.json({}); }),
  http.get(`${B}/settings/data-reset`, () => admin() ?? HttpResponse.json(view())),
  http.get(`${B}/settings/data-reset/requests/:id`, ({ params }) => {
    const g = admin(); if (g) return g;
    const r = [st().request, st().last].find((x) => x?.id === params.id);
    return r ? json(r) : problem(404, 'not_found', 'Not found');
  }),
  http.post(`${B}/settings/data-reset/requests`, async ({ request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await request.json() as { reason?: string; confirm_text?: string };
    const bad = reason(b, 10); if (bad) return bad;
    if (b.confirm_text !== PHRASE) return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match', { detail: `Type ${PHRASE} to confirm.` });
    const s = st();
    if (s.request) return problem(409, 'invalid_transition', 'Not possible now', { detail: 'Another data reset request is open.' });
    s.request = fresh(me(), b.reason!.trim(), s.settings.request_expiry_minutes);
    return json(s.request, 201);
  }),
  http.post(`${B}/settings/data-reset/requests/:id/approve`, async ({ params, request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const r = st().request;
    if (!r || r.id !== params.id) return problem(404, 'not_found', 'Not found');
    const v = version(request, r); if (v) return v;
    const bad = reason(await request.json() as { reason?: string }, 10); if (bad) return bad;
    if (r.requested_by.id === me().id) return problem(403, 'self_approval_forbidden', 'You may not approve this yourself', { detail: 'A different System Admin must approve the reset.' });
    if (r.status !== 'requested') return problem(409, 'invalid_transition', 'Not possible now');
    Object.assign(r, { status: 'approved', version: r.version + 1, approved_by: me(), approved_at: now(), approve_reason: 'approved' });
    return json(r);
  }),
  http.post(`${B}/settings/data-reset/requests/:id/cancel`, async ({ params, request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const s = st(), r = s.request;
    if (!r || r.id !== params.id) return problem(404, 'not_found', 'Not found');
    const v = version(request, r); if (v) return v;
    const b = await request.json() as { reason?: string };
    const bad = reason(b, 3); if (bad) return bad;
    s.last = { ...r, status: 'cancelled', version: r.version + 1, cancelled_by: me(), cancelled_at: now(), cancel_reason: b.reason!.trim(), finished_at: now() };
    s.request = null;
    return json(s.last);
  }),
  http.post(`${B}/settings/data-reset/requests/:id/run`, async ({ params, request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const s = st(), r = s.request;
    if (!r || r.id !== params.id) return problem(404, 'not_found', 'Not found');
    const v = version(request, r); if (v) return v;
    if ((await request.json() as { confirm_text?: string }).confirm_text !== PHRASE) return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match');
    if (r.status !== 'approved') return problem(409, 'invalid_transition', 'Not possible now');
    if (!s.backupOk) return problem(409, 'backup_missing', 'No recent successful database backup', { detail: 'No successful database backup in the last 24 hours.' });
    const t0 = now();
    s.last = { ...r, status: 'completed', version: r.version + 3, run_by: me(), run_started_at: t0, db_committed_at: t0, finished_at: t0,
      quarantine_dir: '/var/lib/gsdn-pmis/files/.pre-reset-20261124-101500', result: { audit_id: 9001, sessions_ended: 7, deleted: { sites: 12 } },
      files: { total: 31, moved: 30, missing: 1, refused: 0, pending: 0, problems: [{ storage_key: 'docs/2026/11/synthetic-missing', outcome: 'missing', detail: null }] } };
    s.request = null;
    return json({ ...r, status: 'running', version: r.version + 1, run_by: me(), run_started_at: t0 }, 202);
  }),
  http.post(`${B}/settings/data-reset/requests/:id/retry-files`, () => admin() ?? problem(409, 'invalid_transition', 'Not possible now')),
  http.put(`${B}/settings/data-reset/settings`, async ({ request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const s = st();
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (h.replace(/"/g, '') !== String(s.settings.version)) return problem(412, 'precondition_failed', 'The resource changed');
    const b = await request.json() as { reason?: string; request_expiry_minutes?: number; backup_max_age_hours?: number };
    const errs: { path: string; code: string }[] = [];
    if (!Number.isInteger(b.request_expiry_minutes) || b.request_expiry_minutes! < 5 || b.request_expiry_minutes! > 240) errs.push({ path: '/request_expiry_minutes', code: 'out_of_range' });
    if (!Number.isInteger(b.backup_max_age_hours) || b.backup_max_age_hours! < 1 || b.backup_max_age_hours! > 72) errs.push({ path: '/backup_max_age_hours', code: 'out_of_range' });
    if (errs.length) return problem(422, 'validation_failed', 'Validation failed', { errors: errs as never });
    s.settings = { request_expiry_minutes: b.request_expiry_minutes!, backup_max_age_hours: b.backup_max_age_hours!, version: s.settings.version + 1 };
    return HttpResponse.json(s.settings, { headers: { ETag: `"${s.settings.version}"` } });
  }),
];
