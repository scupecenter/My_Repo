// Mock of the project data reset in Settings (contract 0.15.62, migration 0146), synthetic data only. The mock `pm` account is the only System Admin a
// test signs in as; a second, synthetic System Admin ("Second Admin") exists so a request can be made. A test that needs the approver's view makes the
// request with `POST /__mock/data-reset/request-by-other` (body `{parts}` for a scoped one). A run completes at once. Contract 0.15.71: the catalogue of
// parts with a synthetic dependency map (the database's closure rule: a part is added when one of its depends_on is chosen), the dry run of a scope, the scope
// and its hash on the request, and the approval bound to that hash (409 scope_changed otherwise). Contract 0.15.72: the backup choice of a request
// (`require_backup`, `NO BACKUP` typed when false, bound into the hash; a run without a backup skips only the backup check). `request-by-other` takes
// `{require_backup}` too.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { closureOf, type DataResetPart, type DataResetPlan, type DataResetRequest, type DataResetScope, type DataResetState } from '@/api/dataReset';
import { db, stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { uid } from './ids';
import { isSystemAdmin } from './waiverData';

const B = API_BASE;
const PHRASE = 'RESET pmis';
const NO_BACKUP = 'NO BACKUP';
const OTHER = { id: uid('9002'), display_name: 'Second Admin (synthetic)', employee_id: '9002' };
const me = () => ({ id: uid(viewer()?.employee_id ?? '1001'), display_name: viewer()?.name ?? 'Demo User 01', employee_id: viewer()?.employee_id ?? '1001' });
const now = () => new Date().toISOString();

interface St { request: DataResetRequest | null; last: DataResetRequest | null; settings: { request_expiry_minutes: number; backup_max_age_hours: number; cooloff_minutes: number; version: number }; backupOk: boolean }
const states = new WeakMap<object, St>();
function st(): St {
  const k = db() as unknown as object;
  let s = states.get(k);
  if (!s) { s = { request: null, last: null, settings: { request_expiry_minutes: 30, backup_max_age_hours: 24, cooloff_minutes: 0, version: 1 }, backupOk: true }; states.set(k, s); }
  if (s.request && ['requested', 'approved'].includes(s.request.status) && new Date(s.request.expires_at).getTime() <= Date.now()) {
    s.last = { ...s.request, status: 'expired', expired: true, version: s.request.version + 1 };
    s.request = null;
  }
  return s;
}

const TABLES: DataResetState['plan']['tables'] = [
  { table: 'sites', action: 'delete', part: 'sites', rows: 12, delete: 12, keep: 0 },
  { table: 'task_instances', action: 'delete', part: 'sites', rows: 540, delete: 540, keep: 0 },
  { table: 'notifications', action: 'delete', part: 'notifications', rows: 87, delete: 87, keep: 0 },
  { table: 'issues', action: 'delete', part: 'issues', rows: 5, delete: 5, keep: 0 },
  { table: 'register_records', action: 'mixed', part: '*', rows: 64, delete: 58, keep: 6 },
  { table: 'document_files', action: 'mixed', part: '*', rows: 33, delete: 31, keep: 2 },
  { table: 'users', action: 'optional', part: 'users', rows: 25, delete: 23, keep: 2 },
  { table: 'settings', action: 'keep', part: null, rows: 40, delete: 0, keep: 40 },
  { table: 'audit_log', action: 'log', part: null, rows: 5120, delete: 0, keep: 5120 },
];

type P = [code: string, group: DataResetPart['group'], en: string, ar: string, deps: string[], rows: number];
const CATALOGUE: P[] = [
  ['sites', 'project', 'Sites, tasks, milestones, gates and baselines', 'المواقع ومهامها ومعالمها وبواباتها والخطط الأساسية', [], 560],
  ['documents', 'project', 'Documents and generated forms (Library)', 'المستندات والنماذج المولّدة (المكتبة)', ['sites'], 33],
  ['imports', 'project', 'Imports, upload batches and exports', 'الاستيرادات ودفعات الرفع والتصديرات', ['sites'], 9],
  ['notifications', 'project', 'Notifications, inbox and follows', 'الإشعارات وصندوق الوارد والمتابعات', [], 87],
  ['daily_plan', 'project', 'Daily Plan', 'الخطة اليومية', ['sites'], 4],
  ['kpi', 'project', 'Project Status and KPI snapshots', 'حالة المشروع ولقطات مؤشرات الأداء', ['sites'], 6],
  ['procurement', 'registers', 'Procurement (PR / PO / WO, assignments)', 'المشتريات (PR / PO / WO والتكليفات)', ['sites'], 14],
  ['issues', 'registers', 'Issue Log', 'سجل المشاكل', ['sites'], 5],
  ['risks', 'registers', 'Risk Register', 'سجل المخاطر', ['sites'], 3],
  ['car_dispatcher', 'registers', 'Car Dispatcher bookings (the vehicles stay)', 'حجوزات السيارات (تبقى المركبات)', ['sites', 'procurement'], 2],
  ['financial_advances', 'registers', 'Financial Advances', 'العهد المالية', ['sites', 'procurement'], 2],
  ['users', 'identity', 'Users: deactivate every account except the System Admins', 'المستخدمون: تعطيل كل الحسابات عدا مديري النظام', [], 23],
  ['roles', 'identity', 'Roles, groups and delegations (role definitions and profiles stay)', 'الأدوار والمجموعات والتفويضات (تبقى تعريفات الأدوار والملفات)', [], 31],
  ['staff', 'identity', 'Staff registry and absences', 'سجل الموظفين والغيابات', [], 40],
];
const IDENT = ['users', 'roles', 'staff'];
// Contract 0.15.265: the parts a filter can follow (the database's data_reset_narrowable())
const NARROWABLE = ['procurement', 'issues', 'risks', 'car_dispatcher', 'financial_advances'];
type Narrow = NonNullable<DataResetScope['narrow']>;
const narrowOf = (q: URLSearchParams): Narrow | null => {
  const n: Narrow = {}; const r = q.get('regions'), b = q.get('batches');
  if (r) n.regions = r.split(',').map(Number);
  if (b) n.batches = b.split(',');
  if (q.get('from')) n.from = q.get('from')!;
  if (q.get('to')) n.to = q.get('to')!;
  return Object.keys(n).length ? n : null;
};
const EVERYTHING = CATALOGUE.filter((c) => c[1] !== 'identity').map((c) => c[0]).sort();
const hashOf = (parts: string[]) => [...parts].sort().join(',').split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').repeat(8);
function scopeOf(requested: string[] | null, narrow: Narrow | null = null): DataResetScope {
  const parts = requested ? closureOf(requested, CATALOGUE.map(([code, , , , deps]) => ({ code, depends_on: deps }))) : EVERYTHING;
  const req = requested ? [...new Set(requested)].sort() : parts;
  return { version: 1, requested: req, parts, added: parts.filter((p) => !req.includes(p)), everything: EVERYTHING.every((p) => parts.includes(p)),
    identity: parts.filter((p) => IDENT.includes(p)), hash: hashOf(narrow ? [...parts, JSON.stringify(narrow)] : parts), ...(narrow ? { narrow } : {}) };
}
function planOf(requested: string[] | null, narrow: Narrow | null = null): DataResetPlan {
  const scope = scopeOf(requested, narrow), sel = new Set(scope.parts ?? []), req = new Set(scope.requested ?? []);
  const tables = TABLES.map((t) => (sel.has(t.part ?? '') || (t.part === '*' && sel.has('sites')) ? t : { ...t, delete: 0, keep: t.rows }));
  return {
    scope, tables, files: sel.has('documents') ? 31 : 0,
    delete_rows: tables.reduce((n, t) => n + (t.table === 'users' ? 0 : t.delete), 0), keep_rows: tables.reduce((n, t) => n + t.keep, 0),
    accounts_to_deactivate: sel.has('users') ? 23 : 0, error: null,
    dangling_links: sel.has('procurement') && !sel.has('issues')
      ? [{ source_part: 'issues', target_part: 'procurement', links: 2, source_label_en: 'Issue Log', source_label_ar: 'سجل المشاكل', target_label_en: 'Procurement (PR / PO / WO, assignments)', target_label_ar: 'المشتريات (PR / PO / WO والتكليفات)' }]
      : [],
    parts: CATALOGUE.map(([code, group, label_en, label_ar, deps, rows]) => ({
      code, group, narrowable: NARROWABLE.includes(code), kind: group === 'identity' ? 'identity' : 'project', label_en, label_ar, depends_on: deps,
      dependents: CATALOGUE.filter((c) => c[4].includes(code)).map((c) => c[0]), rows, tables: {}, requested: req.has(code), selected: sel.has(code),
      added: sel.has(code) && !req.has(code) })),
  };
}

function view(): DataResetState {
  const s = st(), r = s.request, mine = r?.requested_by.id === me().id;
  return {
    database: 'pmis', confirmation_phrase: PHRASE, no_backup_phrase: NO_BACKUP, settings: s.settings, system_admins_active: 2, single_admin: false, script_running: false, maintenance: false,
    backup: { ok: s.backupOk, max_age_hours: s.settings.backup_max_age_hours,
      last_success: { system_log_id: 1, at: new Date(Date.now() - (s.backupOk ? 3 : 30) * 3_600_000).toISOString(), type: 'full', mode: 'full', repository: '1', stanza: 'gsdn-pmis' }, last_problem: null },
    plan: r && r.status === 'completed' ? { ...planOf(null), tables: [] } : planOf(null), everything: EVERYTHING,
    request: r, last_request: s.last,
    can: { request: !r, approve: r?.status === 'requested' && !mine, start: r?.status === 'approved' && (mine || r.approved_by?.id === me().id), cancel: !!r && ['requested', 'approved'].includes(r.status), retry_files: false },
    storage: { driver: 'local', supported: true },
  };
}

/** The run waits for a ready archive (mode download: and downloaded once), as the database does. */
const archiveOk = (r: DataResetRequest) => {
  const m = r.archive?.mode ?? 'none', a = r.archive?.archive;
  return m === 'none' || (a?.status === 'ready' && (m === 'keep_90' || (a.downloads ?? 0) > 0));
};
function admin() {
  const g = guard(); if (g) return g;
  if (!isSystemAdmin()) return problem(403, 'action_forbidden', 'Action not allowed', { detail: 'Only a System Admin may use the project data reset.' });
  return null;
}
/** The mock's binding hash: the scope's hash, or another one when the request runs without a backup (as the database does). */
const bound = (parts: string[] | null, requireBackup: boolean) => (requireBackup ? scopeOf(parts).hash ?? null : hashOf([...(scopeOf(parts).parts ?? []), 'no-backup']));
const fresh = (by: DataResetRequest['requested_by'], reason: string, minutes: number, parts: string[] | null = null, requireBackup = true, archive: 'none' | 'download' | 'keep_90' = 'none', cooloff = 0): DataResetRequest => ({
  id: crypto.randomUUID(), status: 'requested', version: 1, database_name: 'pmis', requested_by: by, requested_at: now(), request_reason: reason,
  expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), expired: false, approved_by: null, approved_at: null, approve_reason: null, cancelled_by: null,
  cancelled_at: null, cancel_reason: null, run_by: null, run_started_at: null, db_committed_at: null, finished_at: null, stalled: false, backup: null,
  plan_at_request: { delete_rows: planOf(parts).delete_rows, files: planOf(parts).files, sites: 12,
    parts: Object.fromEntries(CATALOGUE.filter((c) => (scopeOf(parts).parts ?? []).includes(c[0])).map((c) => [c[0], c[5]])) },
  scope: scopeOf(parts), scope_hash: bound(parts, requireBackup), approved_scope_hash: null, require_backup: requireBackup, archive: { mode: archive, archive: null },
  result: null, quarantine_dir: null, error: null, cooloff: { minutes: cooloff, run_after: null, active: false, remaining_seconds: null },
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
  http.post(`${B}/__mock/data-reset/request-by-other`, async ({ request }) => {
    const b = (await request.json().catch(() => ({}))) as { parts?: string[]; require_backup?: boolean; archive?: 'none' | 'download' | 'keep_90' } | null;
    st().request = fresh(OTHER, 'Owner decision: start the real data load', 30, b?.parts ?? null, b?.require_backup ?? true, b?.archive ?? 'none', st().settings.cooloff_minutes);
    return HttpResponse.json(st().request);
  }),
  http.get(`${B}/settings/data-reset/plan`, ({ request }) => {
    const g = admin(); if (g) return g;
    const raw = new URL(request.url).searchParams.get('parts');
    const parts = raw ? raw.split(',') : null;
    if (parts?.some((p) => !CATALOGUE.some((c) => c[0] === p))) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/parts', code: 'unknown_part' }] as never });
    if (parts && narrowOf(new URL(request.url).searchParams) && parts.some((p) => !NARROWABLE.includes(p))) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/narrow', code: 'not_narrowable' }] as never });
    return HttpResponse.json(planOf(parts, narrowOf(new URL(request.url).searchParams)));
  }),
  http.get(`${B}/settings/data-reset/narrow-options`, () => admin() ?? HttpResponse.json({
    regions: [{ id: 1, name_en: 'Tripoli', name_ar: 'طرابلس' }, { id: 2, name_en: 'Benghazi', name_ar: 'بنغازي' }],
    batches: [{ id: 'b0000000-0000-4000-8000-000000000001', file_name: 'procurement-2026-11.xlsx', rows_total: 14, created_at: '2026-11-20T08:00:00Z' }] })),
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
    const b = await request.json() as { reason?: string; confirm_text?: string; parts?: string[]; require_backup?: boolean; no_backup_confirm?: string; narrow?: Narrow; archive?: 'none' | 'download' | 'keep_90' };
    const bad = reason(b, 10); if (bad) return bad;
    if (b.parts && (b.parts.length === 0 || b.parts.some((p) => !CATALOGUE.some((c) => c[0] === p)))) {
      return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/parts', code: b.parts.length ? 'unknown_part' : 'required' }] as never });
    }
    if (b.confirm_text !== PHRASE) return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match', { detail: `Type ${PHRASE} to confirm.` });
    const need = b.require_backup ?? true;
    if (!need && b.no_backup_confirm !== NO_BACKUP) {
      return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match', { detail: `Type ${NO_BACKUP} to request the reset without a backup.`, errors: [{ path: '/no_backup_confirm', code: 'confirmation_mismatch' }] as never });
    }
    const s = st();
    if (s.request) return problem(409, 'invalid_transition', 'Not possible now', { detail: 'Another data reset request is open.' });
    s.request = fresh(me(), b.reason!.trim(), s.settings.request_expiry_minutes, b.parts ?? null, need, b.archive ?? 'none', s.settings.cooloff_minutes);
    if (b.narrow) { s.request.scope = scopeOf(b.parts ?? null, b.narrow); s.request.scope_hash = s.request.scope.hash ?? null; }
    return json(s.request, 201);
  }),
  http.post(`${B}/settings/data-reset/requests/:id/approve`, async ({ params, request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const s = st(), r = s.request;
    if (!r || r.id !== params.id) return problem(404, 'not_found', 'Not found');
    const v = version(request, r); if (v) return v;
    const body = await request.json() as { reason?: string; scope_hash?: string };
    const bad = reason(body, 10); if (bad) return bad;
    if (body.scope_hash && body.scope_hash !== r.scope_hash) return problem(409, 'scope_changed', 'Not possible now', { detail: 'The scope you approve is not the scope of this request.' });
    if (r.requested_by.id === me().id) return problem(403, 'self_approval_forbidden', 'You may not approve this yourself', { detail: 'A different System Admin must approve the reset.' });
    if (r.status !== 'requested') return problem(409, 'invalid_transition', 'Not possible now');
    Object.assign(r, { status: 'approved', version: r.version + 1, approved_by: me(), approved_at: now(), approve_reason: 'approved', approved_scope_hash: r.scope_hash });
    const cool = r.cooloff;
    if (cool && cool.minutes > 0) {
      const at = Date.now() + cool.minutes * 60_000;
      r.cooloff = { minutes: cool.minutes, run_after: new Date(at).toISOString(), active: true, remaining_seconds: cool.minutes * 60 };
      r.expires_at = new Date(at + s.settings.request_expiry_minutes * 60_000).toISOString();
    }
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
    if (r.cooloff?.run_after && new Date(r.cooloff.run_after).getTime() > Date.now()) return problem(409, 'cooloff_active', 'The waiting period is not over');
    if (!archiveOk(r)) return problem(409, 'archive_required', 'The archive of this reset is not ready', { detail: 'Make the archive first (mode download: and download it once).' });
    if ((r.require_backup ?? true) && !s.backupOk) return problem(409, 'backup_missing', 'No recent successful database backup', { detail: 'No successful database backup in the last 24 hours.' });
    const t0 = now();
    s.last = { ...r, status: 'completed', version: r.version + 3, run_by: me(), run_started_at: t0, db_committed_at: t0, finished_at: t0,
      backup: s.backupOk ? { system_log_id: 1, type: 'full' } : null,
      quarantine_dir: '/var/lib/gsdn-pmis/files/.pre-reset-20261124-101500', result: { audit_id: 9001, sessions_ended: 7, deleted: { sites: 12 }, require_backup: r.require_backup ?? true },
      files: { total: 31, moved: 30, missing: 1, refused: 0, pending: 0, problems: [{ storage_key: 'docs/2026/11/synthetic-missing', outcome: 'missing', detail: null }] } };
    s.request = null;
    return json({ ...r, status: 'running', version: r.version + 1, run_by: me(), run_started_at: t0 }, 202);
  }),
  http.post(`${B}/settings/data-reset/requests/:id/archive`, ({ params }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const r = st().request;
    if (!r || r.id !== params.id) return problem(404, 'not_found', 'Not found');
    if (r.status !== 'approved' || (r.archive?.mode ?? 'none') === 'none') return problem(409, 'invalid_transition', 'Not possible now');
    const t0 = now(), keep = r.archive?.mode === 'keep_90' ? 90 : 7;
    r.archive = { mode: r.archive?.mode ?? 'none', archive: { id: crypto.randomUUID(), status: 'ready', bytes: 482_113, sha256: 'a'.repeat(64), error: null, created_at: t0, ready_at: t0,
      keep_until: new Date(Date.now() + keep * 86_400_000).toISOString(), downloads: 0, first_downloaded_at: null, entries: { records: 128, files: 31, files_bytes: 3_204_551, registers: [{ register: 'procurement', rows: 96 }, { register: 'issue_log', rows: 32 }] } } };
    return json(r, 202);
  }),
  http.get(`${B}/settings/data-reset/requests/:id/archive/download`, ({ params }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const r = st().request, a = r?.archive?.archive;
    if (!r || r.id !== params.id || !a || a.status !== 'ready') return problem(404, 'not_found', 'Not found');
    a.downloads = (a.downloads ?? 0) + 1; a.first_downloaded_at ??= now();
    return new HttpResponse('PK-synthetic-archive', { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="GSDN_DataReset_Archive_20261127.zip"' } });
  }),
  http.post(`${B}/settings/data-reset/requests/:id/retry-files`, () => admin() ?? problem(409, 'invalid_transition', 'Not possible now')),
  http.put(`${B}/settings/data-reset/settings`, async ({ request }) => {
    const g = admin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const s = st();
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (h.replace(/"/g, '') !== String(s.settings.version)) return problem(412, 'precondition_failed', 'The resource changed');
    const b = await request.json() as { reason?: string; request_expiry_minutes?: number; backup_max_age_hours?: number; cooloff_minutes?: number };
    const errs: { path: string; code: string }[] = [];
    if (!Number.isInteger(b.request_expiry_minutes) || b.request_expiry_minutes! < 5 || b.request_expiry_minutes! > 240) errs.push({ path: '/request_expiry_minutes', code: 'out_of_range' });
    if (!Number.isInteger(b.backup_max_age_hours) || b.backup_max_age_hours! < 1 || b.backup_max_age_hours! > 72) errs.push({ path: '/backup_max_age_hours', code: 'out_of_range' });
    if (b.cooloff_minutes !== undefined && (!Number.isInteger(b.cooloff_minutes) || b.cooloff_minutes < 0 || b.cooloff_minutes > 43200)) errs.push({ path: '/cooloff_minutes', code: 'out_of_range' });
    if (errs.length) return problem(422, 'validation_failed', 'Validation failed', { errors: errs as never });
    s.settings = { request_expiry_minutes: b.request_expiry_minutes!, backup_max_age_hours: b.backup_max_age_hours!, cooloff_minutes: b.cooloff_minutes ?? s.settings.cooloff_minutes, version: s.settings.version + 1 };
    return HttpResponse.json(s.settings, { headers: { ETag: `"${s.settings.version}"` } });
  }),
];
