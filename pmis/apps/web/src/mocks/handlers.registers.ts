// MSW handlers for the generic register endpoints and template import, following contracts/openapi.yaml (/registers, /import-batches).
// The record shapes are the ones the real API answers (contract 0.4.5/0.4.6): entity_id, version_no, is_current, task (Q43), allowed_actions with claim,
// release and new_version, history steps, and the versions of a logical record. Template entry (/templates, /import-batches, contract 0.7.0) follows the API:
// staged at upload, sent into the flow by the uploader, decided row by row or all at once by L2, held rows listed.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { BallInCourt, ImportBatch, ImportRow, RegisterDefinition, RegisterKey, RegisterRecord, RegisterRecordStep, UploadWarning } from '@/api/types';
import { DATE_MAX, DATE_MIN, hasExpiry, validateRecord, visibleData } from '@/lib/registerForms';
import { db, save, stepUpValid, viewer, accountStatus } from './db';
import { guard, page, problem, stepUp } from './handlers';
import { uid } from './ids';
import { holdersOf, rowOf } from './matrixData';
import { REGISTER_DEFS, REGISTER_TEMPLATES, STREAM_TEMPLATES, recId, type MockBatch, type MockBatchRow, type MockRecord, type MockRun } from './registersData';
import { SITE_COUNT, siteIdOf, siteIndex, siteMeta, TODAY } from './sites';
import { isSystemAdmin, waiver } from './waiverData';
import { deriveDismantle, gecolCfg, hlcPrView, p4cWarnings } from './p4cData';

const B = API_BASE;
const R = () => db().reg;
const defOf = (key: string): RegisterDefinition | undefined => REGISTER_DEFS.find((d) => d.register_key === key);
const levelsOf = (key: string) => rowOf(db().matrix, key)?.approval_levels ?? 2;
const tag = (r: MockRecord) => HttpResponse.json(toRecord(r), { headers: { ETag: `"${r.version}"` } });
const ref = () => { const v = viewer()!; return { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined }; };
/** Position `level` (1 = entry) of a path of `n` levels: the last position is always matrix cell 3 (approve), so a 2-level path uses cells 1 and 3. */
const userHolds = (key: string, level: number, emp?: string | null, n?: number) => holdersOf(db().matrix, key, level, n ?? levelsOf(key)).some((a) => a.kind === 'user' && a.employee_id === emp);
/** The admin account acts at every level (as in the task mock); anyone else only where the matrix row names them. */
const canAt = (key: string, level: number, n?: number) => { const v = viewer(); return !!v && (v.key === 'pm' || userHolds(key, level, v.employee_id, n)); };
/** Migration 0042: a Procurement record of scope HLC is decided by the Matrix row of its scope (the HLC Fiber Team's), every other record by its register's row. */
const SCOPE_ROWS: Record<string, Record<string, string>> = { procurement: { HLC: 'procurement_hlc' } };
/** Migration 0054 (Q220, D220b): the stream of a permit type (fixed) or the streams a purpose-based type may be entered on (chosen per permit). */
export const PERMIT_STREAM: Record<string, string | string[]> = {
  'City Council Permit': 'ACQ', 'Civil Aviation Authority Permit': 'ACQ', 'Security Clearance': ['CW', 'TE', 'ACQ', 'OM'], 'Other Permit': ['CW', 'TE', 'ACQ', 'OM'],
  'Access - Survey': ['ACQ', 'CW'], 'Access - CW': 'CW', 'Access - TE': 'TE', 'Access - Dismantle': ['CW', 'TE'], 'Access - QC / Maintenance': ['CW', 'TE', 'OM'],
  'PTW - CW': 'CW', 'PTW - TE': 'TE', 'PTW - Dismantle': ['CW', 'TE'],
};
const STREAM_ROWS: Record<string, string> = { CW: 'permits_hse', TE: 'permits_hse_te', ACQ: 'permits_hse_acq', OM: 'permits_hse_om' };
const permitStream = (d: Record<string, unknown>): string | null => {
  const t = PERMIT_STREAM[String(d.permit_type ?? '')];
  if (typeof t === 'string') return t;
  return t && typeof d.permit_stream === 'string' && t.includes(d.permit_stream) ? d.permit_stream : null;
};
/** The stream refusals of the database trigger (0054), same path and codes. */
function permitIssues(d: Record<string, unknown>): { path: string; code: string }[] {
  const t = PERMIT_STREAM[String(d.permit_type ?? '')], s = typeof d.permit_stream === 'string' && d.permit_stream ? d.permit_stream : null;
  if (!t) return [];
  if (Array.isArray(t)) return !s ? [{ path: '/data/permit_stream', code: 'stream_required' }] : t.includes(s) ? [] : [{ path: '/data/permit_stream', code: 'stream_not_allowed' }];
  return s && s !== t ? [{ path: '/data/permit_stream', code: 'stream_fixed' }] : [];
}
const rowKey = (key: string, data: Record<string, unknown>) =>
  key === 'permits_hse' ? STREAM_ROWS[permitStream(data) ?? 'CW']! : (typeof data.scope === 'string' && SCOPE_ROWS[key]?.[data.scope]) || key;
/** Q222: the permit types the viewer may enter, with the streams they may choose (RegisterDefinition.entry_permit_types). */
function entryPermitTypes() {
  const held = Object.keys(STREAM_ROWS).filter((s) => canAt(STREAM_ROWS[s]!, 1));
  return Object.entries(PERMIT_STREAM).flatMap(([code, t]) => {
    const streams = (Array.isArray(t) ? t : [t]).filter((s) => held.includes(s));
    return streams.length ? [{ code, stream: Array.isArray(t) ? null : t, choose_stream: Array.isArray(t), streams }] : [];
  });
}
const rk = (r: MockRecord) => rowKey(r.register_key, r.data);
/** The scopes the viewer may enter (RegisterDefinition.entry_scopes): the scopes of the register row when they hold its L1, plus each scope whose row they hold. */
function entryScopes(def: RegisterDefinition): string[] | undefined {
  const rows = SCOPE_ROWS[def.register_key];
  if (!rows) return undefined;
  const all = def.fields.find((f) => f.code === 'scope')?.options?.map((o) => o.value) ?? [];
  if (viewer()?.key === 'pm') return all;
  return all.filter((s) => canAt(rows[s] ?? def.register_key, 1));
}
/** The approved scope-HLC order of a site, which an HLC record is linked to (derived fields, filled by the server). */
const hlcPrOf = (site: number | null) => R().records.find((x) => x.register_key === 'procurement' && x.site_index === site && x.state === 'approved' && x.data.scope === 'HLC');
function linkHlc(r: MockRecord) {
  if (r.register_key !== 'hlc' || r.state !== 'entry') return;
  const pr = hlcPrOf(r.site_index);
  delete r.data.pr_no; delete r.data.hlc_approval_date; delete r.data.procurement_record_id;
  if (pr) Object.assign(r.data, { procurement_record_id: pr.id, pr_no: pr.data.pr_no, ...(pr.data.hlc_approval_date ? { hlc_approval_date: pr.data.hlc_approval_date } : {}) });
}
/** Ordering issues that only warn the reviewer (Q96), as the server's reg_warnings. */
function warningsOf(r: MockRecord): { path: string; code: string }[] {
  const d = r.data as Record<string, string | undefined>, w: { path: string; code: string }[] = [];
  if (r.register_key === 'hlc') {
    const pr = hlcPrOf(r.site_index), ap = pr?.data.hlc_approval_date as string | undefined;
    if (!pr) w.push({ path: '/data/pr_no', code: 'no_approved_hlc_pr' });
    else if (!ap) w.push({ path: '/data/hlc_approval_date', code: 'hlc_not_approved' });
    else {
      if (d.link_received_date && d.link_received_date < ap) w.push({ path: '/data/link_received_date', code: 'before_hlc_approval' });
      if (d.installation_date && d.installation_date < ap) w.push({ path: '/data/installation_date', code: 'before_hlc_approval' });
    }
    if (d.link_received_date && d.installation_date && d.installation_date < d.link_received_date) w.push({ path: '/data/installation_date', code: 'before_link_received' });
    if (d.tx_link_tested_date && !d.installation_date) w.push({ path: '/data/installation_date', code: 'test_without_installation' });
    if (d.in_service_date && !d.tx_link_tested_date) w.push({ path: '/data/tx_link_tested_date', code: 'in_service_without_test' });
  } else if (r.register_key === 'procurement' && d.scope === 'HLC' && d.hlc_approval_date && d.pr_date && d.hlc_approval_date < d.pr_date) {
    w.push({ path: '/data/hlc_approval_date', code: 'approval_before_pr' });
  }
  return w;
}

function ball(r: MockRecord): BallInCourt {
  const L = r.levels_required ?? levelsOf(r.register_key), level = r.state === 'entry' ? 1 : r.current_level;
  const holders = holdersOf(db().matrix, rk(r), level, L).map((h) => (h.employee_id ? { ...h, account_status: accountStatus(h.employee_id) } : h));
  return { level, level_kind: level === 1 ? 'entry' : level >= L ? 'approve' : 'review', holders, rule: 'any_one', ...(r.claimed_by ? { claimed_by: r.claimed_by } : {}) };
}

function actions(r: MockRecord): RegisterRecord['allowed_actions'] {
  const out: NonNullable<RegisterRecord['allowed_actions']> = [];
  const L = r.levels_required ?? levelsOf(r.register_key), row = rk(r);
  if (r.state === 'entry' && canAt(row, 1, L)) out.push('edit', 'submit');
  if (r.state === 'in_review' && canAt(row, r.current_level, L)) out.push('review', 'reject');
  if (r.state === 'in_approval' && canAt(row, L, L)) out.push('approve', 'reject');
  if (r.state === 'approved' && isCurrent(r) && !hasOpenVersion(r) && canAt(row, 1, L)) out.push('new_version');
  if (r.state !== 'voided' && viewer()?.key === 'pm') out.push('void');
  // contract 0.13.2 (Q267): a System Admin (the `pm` account in the mock) cancels an approved Quality snag record entered by mistake
  if (viewer()?.key === 'pm' && r.register_key === 'quality' && r.record_type === 'snag' && isCurrent(r) && !hasOpenVersion(r)) out.push('cancel_snag');
  // Q221: a permit draft whose holder no longer holds L1 of its stream row is handed over (contract 0.12.2)
  if (r.register_key === 'permits_hse' && r.state === 'entry' && !r.transferred && !canAt(row, 1, L) && r.created_by === viewer()?.employee_id) out.push('transfer');
  return out;
}

const versionsOf = (r: MockRecord) => R().records.filter((x) => x.entity_id === r.entity_id).sort((a, b) => b.version_no - a.version_no);
const isLatest = (r: MockRecord) => versionsOf(r)[0]!.id === r.id;
/** The approved version in force: the newest approved one. */
const isCurrent = (r: MockRecord) => r.state === 'approved' && versionsOf(r).find((x) => x.state === 'approved')!.id === r.id;
const hasOpenVersion = (r: MockRecord) => versionsOf(r).some((x) => ['entry', 'in_review', 'in_approval'].includes(x.state));

export function toRecord(r: MockRecord): RegisterRecord {
  const m = r.site_index !== null ? siteMeta(r.site_index) : null;
  return {
    id: r.id, register_key: r.register_key, record_type: r.record_type, site_id: m?.id ?? null, site_code: m?.code ?? null, region_id: (m?.region_id ?? null) as never, state: r.state,
    current_level: r.state === 'entry' ? 1 : r.current_level, levels_required: r.levels_required ?? levelsOf(r.register_key), ball_in_court: ball(r), data: r.data, return_count: r.return_count, last_return_note: r.last_return_note,
    allowed_actions: actions(r), created_by: { id: uid(r.created_by), display_name: r.created_by }, created_at: r.created_at, updated_at: r.updated_at, version: r.version,
    entity_id: r.entity_id, version_no: r.version_no, supersedes_id: r.supersedes_id ?? null, is_current: isCurrent(r), source: r.source ?? 'manual', ...(r.task ? { task: r.task } : {}),
    warnings: [...warningsOf(r), ...p4cWarnings(r, R().records, gecolCfg())],
    // 0063 (Q150, Q114): the HLC purchase requests of an HLC record; the contractor of a record (derived from the order for an outsourced Dismantle part)
    ...(r.register_key === 'hlc' && r.site_index !== null ? { purchase_requests: hlcPrView(r, R().records) } : {}),
    ...(r.external_party ? { external_party: r.external_party } : {}),
  };
}

const noMatch = (req: Request, r: MockRecord) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === r.version ? null : problem(412, 'precondition_failed', 'The record changed; reload and retry');
};
const step = (r: MockRecord, action: RegisterRecordStep['action'], level: number, note?: string, self = false, batchRow?: string) => {
  r.steps.push({ id: crypto.randomUUID(), level, action, acted_by: ref(), note: note ?? null, created_at: new Date().toISOString(), self_approval: self, ...(batchRow ? { batch_row_id: batchRow } : {}) });
};
const touch = (r: MockRecord) => { r.version += 1; r.updated_at = new Date().toISOString(); };

/** Field problems as the server answers them (`errors[].path` = `/data/<code>`), plus the checks only the server can make (V1, duplicate). */
function check(def: RegisterDefinition, data: Record<string, unknown>, site: number | null) {
  const issues = validateRecord(def, data, site === null ? null : siteIdOf(site), TODAY);
  return Object.entries(issues).map(([code, i]) => ({ path: code === 'site_id' ? '/site_id' : `/data/${code}`, code: i.code }));
}
/** The Dismantle rules of the database trigger (0021): same paths and codes. The mock answers them as a 422 `validation_failed`, like the API. */
function dismantleErrors(d: Record<string, unknown>) {
  const out: { path: string; code: string; message: string }[] = [];
  if (!d.rfd_date) for (const k of Object.keys(d)) if (k !== 'rfd_document_ref') out.push({ path: `/data/${k}`, code: 'rfd_required', message: 'The RFD date must be entered before any later step.' });
  if (d.work_start_date && d.work_end_date && String(d.work_end_date) < String(d.work_start_date)) out.push({ path: '/data/work_end_date', code: 'end_before_start', message: 'The work end is before the work start.' });
  if (d.closed === true && !String(d.closing_rn_ref ?? '').trim()) out.push({ path: '/data/closing_rn_ref', code: 'rn_required', message: 'A part closes only with the reference of its signed RN.' });
  return out;
}
/** 0.12.5: every child-list row keeps a stable id given by the server (so a row is never entered twice). */
function withRowIds(def: RegisterDefinition, data: Record<string, unknown>): Record<string, unknown> {
  for (const f of def.fields) {
    const v = data[f.code];
    if (f.type === 'child_list' && Array.isArray(v)) data[f.code] = (v as Record<string, unknown>[]).map((row) => (row.id ? row : { ...row, id: crypto.randomUUID() }));
  }
  return data;
}
const invalid = (errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });

/** 0.15.3: an upload staged in the background (a TPL-MASTER test file named with `bigmaster<rows>`). */
interface MockUpload { id: string; file_name: string; parts: ReturnType<typeof makeStreamBatch>[]; rows_total: number; rows_done: number; created_at: string; warnings: UploadWarning[] }
const UPLOADS = new Map<string, MockUpload>();
function uploadDto(u: MockUpload): ImportBatch {
  const pct = u.rows_total ? Math.floor((100 * u.rows_done) / u.rows_total) : 0, parts = u.parts.length;
  return {
    id: u.id, upload_id: u.id, template_id: 'TPL-MASTER', template_version: 3, source: 'master_template', file_name: u.file_name, status: 'parsing', current_level: 1, levels_required: 2,
    counts: { create: 0, update: 0, unchanged: 0, error: 0, pending: 0, approved: 0, rejected: 0, held: 0, saved: 0 }, mode: 'submit', file_template_version: null, historical_load: null,
    job_id: null, register_key: null, entity: null, stream: null, group_id: u.id, part_sheet: null, note: null, task_id: null, site_id: null, uploaded_at: u.created_at, version: 0,
    progress: { kind: 'upload', state: 'running', rows_total: u.rows_total, rows_done: u.rows_done, percent: pct, parts_total: parts, parts_done: Math.min(parts - 1, Math.floor((pct * parts) / 100)),
      started_at: u.created_at, updated_at: new Date().toISOString(), finished_at: null, error: null },
    upload: { id: u.id, kind: 'master', state: 'running', batch_ids: [], error: null }, warnings: u.warnings,
  } as ImportBatch;
}

export const registerHandlers = [
  http.get(`${B}/registers`, () => {
    const g = guard(); if (g) return g;
    const nav = viewer()!.nav;
    return HttpResponse.json({ items: REGISTER_DEFS.filter((d) => nav.includes(d.module_key)).map((d) => {
      const scopes = entryScopes(d);
      return { ...d, approval_levels: levelsOf(d.register_key), record_count: R().records.filter((r) => r.register_key === d.register_key).length, ...(scopes ? { entry_scopes: scopes } : {}),
        ...(d.register_key === 'permits_hse' ? { entry_permit_types: entryPermitTypes() } : {}) };
    }) });
  }),

  http.get(`${B}/registers/:key/records`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const def = defOf(params.key as string);
    if (!def || !viewer()!.nav.includes(def.module_key)) return problem(404, 'not_found', 'Register not found');
    const u = new URL(request.url).searchParams;
    const q = (u.get('q') ?? '').toLowerCase(), region = u.get('region_id'), state = u.get('state'), type = u.get('record_type'), site = u.get('site_id');
    const limit = Math.min(Number(u.get('limit') ?? 50), 200), start = Number(u.get('cursor') ?? 0);
    const entity = u.get('entity_id'), allVersions = u.get('all_versions') === 'true';
    const all = R().records.filter((r) => r.register_key === def.register_key && (!entity || r.entity_id === entity) && (allVersions || entity || isLatest(r))).map(toRecord).filter((r) =>
      (!state || r.state === state) && (!type || r.record_type === type) && (!site || r.site_id === site) && (!region || String(r.region_id) === region)
      && (!q || `${r.site_code ?? ''} ${Object.values(r.data).filter((x) => typeof x === 'string').join(' ')}`.toLowerCase().includes(q)));
    const items = all.slice(start, start + limit);
    return HttpResponse.json({ items, page: { limit, next_cursor: start + limit < all.length ? String(start + limit) : null, total: all.length } });
  }),
  http.post(`${B}/registers/:key/records`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const def = defOf(params.key as string);
    if (!def) return problem(404, 'not_found', 'Register not found');
    const b = (await request.json()) as { site_id?: string; record_type?: string; data?: Record<string, unknown> };
    const si = b.site_id ? siteIndex(b.site_id) : null;
    if (def.site_scoped && (si === null || si < 0 || si >= SITE_COUNT)) return invalid([{ path: '/site_id', code: b.site_id ? 'site_not_found' : 'site_required' }]);
    if (def.register_key === 'permits_hse') { const pe = permitIssues(b.data ?? {}); if (pe.length) return invalid(pe); }
    // the entry holders of the record's row: the row of its scope (0042), as the database decides
    if (!viewer() || !(viewer()!.key === 'pm' || userHolds(rowKey(def.register_key, b.data ?? {}), 1, viewer()!.employee_id))) return problem(403, 'not_eligible_holder', 'You are not an entry holder (L1) of this row of the Matrix');
    if (def.register_key === 'procurement' && b.data?.scope === 'GECOL') return invalid([{ path: '/data/scope', code: 'wrong_register' }]);
    if (def.register_key === 'dismantle') {
      if (!b.record_type) return invalid([{ path: '/record_type', code: 'required' }]);
      const errs = dismantleErrors(visibleData(def, b.data ?? {})); if (errs.length) return invalid(errs);
      if (R().records.some((r) => r.register_key === 'dismantle' && r.site_index === si && r.record_type === b.record_type && r.state !== 'voided' && r.version_no === 1))
        return problem(409, 'duplicate', `This site already has a ${b.record_type.toUpperCase()} Dismantle record: create a new version of it.`);
    }
    if (!def.multiple_per_site && R().records.some((r) => r.register_key === def.register_key && r.site_index === si && r.state !== 'voided' && r.version_no === 1))
      return problem(409, 'duplicate', 'This site already has a row; a new request is a new version of it (Q55)');
    const data = withRowIds(def, visibleData(def, b.data ?? {}));
    const bad = Object.entries(data).filter(([c, v]) => def.fields.find((f) => f.code === c)?.type === 'date' && typeof v === 'string' && (v < DATE_MIN || v > DATE_MAX));
    if (bad.length) return invalid(bad.map(([c]) => ({ path: `/data/${c}`, code: 'date_range' })));
    const now = new Date().toISOString();
    const id = recId(++R().seq);
    const r: MockRecord = { id, entity_id: id, version_no: 1, register_key: def.register_key, record_type: b.record_type ?? null, site_index: si, state: 'entry', current_level: 1, levels_required: levelsOf(def.register_key), data, version: 1, return_count: 0, last_return_note: null, created_by: viewer()!.employee_id ?? '9999', created_at: now, updated_at: now, steps: [] };
    step(r, 'create', 1);
    linkHlc(r);
    deriveDismantle(r, R().records);
    R().records.unshift(r); save();
    return HttpResponse.json(toRecord(r), { status: 201, headers: { ETag: `"${r.version}"` } });
  }),
  http.get(`${B}/registers/:key/records/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key);
    return r ? tag(r) : problem(404, 'not_found', 'Record not found');
  }),
  http.patch(`${B}/registers/:key/records/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key), def = defOf(params.key as string);
    if (!r || !def) return problem(404, 'not_found', 'Record not found');
    const bad = noMatch(request, r); if (bad) return bad;
    if (r.state !== 'entry') return problem(409, 'invalid_transition', 'Only a record in entry can be edited');
    if (!actions(r)!.includes('edit')) return problem(403, 'not_eligible_holder', 'You do not hold this level');
    const b = (await request.json()) as { data?: Record<string, unknown> };
    // a key that is sent applies, an explicit null clears it (as the API does); read-only fields cannot be typed (Q45)
    const merged: Record<string, unknown> = { ...r.data };
    for (const [c, v] of Object.entries(b.data ?? {})) { if (v === null) delete merged[c]; else merged[c] = v; }
    const next = withRowIds(def, visibleData(def, merged));
    // 0.12.5: read-only values (the old text of a meeting, the values the approval fills) stay as they are
    for (const f of def.fields) if (f.read_only && r.data[f.code] !== undefined) next[f.code] = r.data[f.code];
    if (def.register_key === 'dismantle') { const errs = dismantleErrors(next); if (errs.length) return invalid(errs); }
    if (def.register_key === 'permits_hse') { const pe = permitIssues(next); if (pe.length) return invalid(pe); }
    if (rowKey(def.register_key, next) !== rk(r) && viewer()?.key !== 'pm' && !userHolds(rowKey(def.register_key, next), 1, viewer()?.employee_id)) {
      return problem(403, 'not_eligible_holder', 'This scope is entered by another team (its own row of the Matrix)');
    }
    // the legacy request fields of an HLC record entered before 0042 are kept as they are (readable, never typed)
    for (const k of ['request_no', 'request_date']) if (r.data[k] !== undefined && !(k in next)) next[k] = r.data[k];
    r.data = next;
    linkHlc(r);
    deriveDismantle(r, R().records);
    if (b.data && !hasExpiry(r.data)) delete r.data.valid_to;
    step(r, 'edit', 1);
    touch(r); save();
    return tag(r);
  }),

  http.post(`${B}/registers/quality/records/:id/cancel-snag`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === 'quality');
    if (!r) return problem(404, 'not_found', 'Record not found');
    const bad = noMatch(request, r); if (bad) return bad;
    if (viewer()?.key !== 'pm') return problem(403, 'action_forbidden', 'Only a System Admin cancels an approved Quality snag record.');
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    if ((body.reason ?? '').trim().length < 3) return invalid([{ path: '/reason', code: 'required' }]);
    if (r.record_type !== 'snag' || !isCurrent(r) || hasOpenVersion(r)) return problem(409, 'invalid_transition', 'Only the approved version in force of a Quality snag record can be cancelled.');
    if (!stepUpValid()) return stepUp();
    r.state = 'voided'; step(r, 'void', r.current_level, body.reason!.trim()); touch(r); save();
    return tag(r);
  }),

  ...(['submit', 'review', 'approve', 'reject', 'void'] as const).map((op) =>
    http.post(`${B}/registers/:key/records/:id/${op}`, async ({ params, request }) => {
      const g = guard(); if (g) return g;
      const r = R().records.find((x) => x.id === params.id && x.register_key === params.key), def = defOf(params.key as string);
      if (!r || !def) return problem(404, 'not_found', 'Record not found');
      const bad = noMatch(request, r); if (bad) return bad;
      const body = (await request.json().catch(() => ({}))) as { note?: string; reason?: string };
      const key = r.register_key, L = r.levels_required ?? levelsOf(key), v = viewer()!;
      const finish = (self: boolean) => { if (!stepUpValid() && self) return stepUp(); r.state = 'approved'; r.current_level = L; return null; };
      // Holding every level of the row makes the submission a self-approval (B5): step-up, and the approval is flagged.
      const holdsAll = Array.from({ length: L }, (_, i) => userHolds(key, i + 1, v.employee_id, L)).every(Boolean);
      const claimed = r.claimed_by && r.claimed_by.id !== uid(v.employee_id ?? '9999');
      if (op === 'void') {
        if (v.key !== 'pm') return problem(403, 'forbidden', 'Not allowed');
        if (!body.reason?.trim()) return invalid([{ path: '/reason', code: 'required' }]);
        if (r.state === 'voided') return problem(409, 'invalid_transition', 'Already voided');
        if (!stepUpValid()) return stepUp();
        r.state = 'voided'; touch(r); save();
        return tag(r);
      }
      if (op === 'reject' && !body.note?.trim()) return problem(422, 'note_required', 'A rejection needs a note', { errors: [{ path: '/note', code: 'required' }] });
      const want = op === 'submit' ? 'entry' : op === 'review' ? 'in_review' : op === 'approve' ? 'in_approval' : null;
      if (want ? r.state !== want : r.state !== 'in_review' && r.state !== 'in_approval') return problem(409, 'invalid_transition', 'The record is not waiting for this step');
      if (!actions(r)!.includes(op)) return problem(403, 'not_eligible_holder', 'You do not hold this level');
      if (claimed) return problem(409, 'already_claimed', 'Another holder has claimed this level', { claimed_by: r.claimed_by } as never);
      if (op === 'submit') {
        const errs = check(def, r.data, r.site_index);
        if (errs.length) return invalid(errs);
        r.levels_required = L; // B7: the level path is snapshotted at first submission
        let next = 2;
        while (next <= L && userHolds(key, next, v.employee_id, L)) next += 1;
        const skipped = Array.from({ length: next - 2 }, (_, i) => i + 2);
        if (next > L) { const e = finish(true); if (e) return e; } // the submitter holds every level they would reach: a self-approval (B5)
        else { r.state = next >= L ? 'in_approval' : 'in_review'; r.current_level = next; }  // the last position is L2 (approve)
        step(r, 'submit', 1, undefined, next > L);
        skipped.forEach((l) => step(r, 'auto_skip', l, `Level ${l} skipped: same person`));
        r.last_return_note = null;
      } else if (op === 'review') {
        if (L <= 2) { const e = finish(holdsAll); if (e) return e; step(r, 'approve', r.current_level, undefined, holdsAll); }
        else { step(r, 'review', r.current_level); r.state = 'in_approval'; r.current_level = L; }
      } else if (op === 'approve') {
        const e = finish(holdsAll); if (e) return e;
        step(r, 'approve', L, undefined, holdsAll);
      } else {
        step(r, 'reject', r.current_level, body.note);
        r.return_count += 1; r.last_return_note = body.note!.trim();
        if (r.state === 'in_approval' && L > 2) { r.state = 'in_review'; r.current_level = 2; } else { r.state = 'entry'; r.current_level = 1; }
      }
      r.claimed_by = undefined; touch(r); save();
      return tag(r);
    })),
  // claim and release of a group level (contract 0.4.5)
  ...(['claim', 'release'] as const).map((op) =>
    http.post(`${B}/registers/:key/records/:id/${op}`, ({ params, request }) => {
      const g = guard(); if (g) return g;
      const r = R().records.find((x) => x.id === params.id && x.register_key === params.key);
      if (!r) return problem(404, 'not_found', 'Record not found');
      const bad = noMatch(request, r); if (bad) return bad;
      const me = ref();
      if (op === 'claim') { if (r.claimed_by && r.claimed_by.id !== me.id) return problem(409, 'already_claimed', 'Another holder has claimed this level', { claimed_by: r.claimed_by } as never); r.claimed_by = me; }
      else if (r.claimed_by?.id === me.id) r.claimed_by = undefined;
      else return problem(409, 'invalid_transition', 'You have not claimed this level');
      touch(r); save();
      return tag(r);
    })),
  // Q221 (contract 0.12.2): the draft goes to the entry holders of its stream row (one holder: pinned to them)
  http.post(`${B}/registers/:key/records/:id/transfer`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key);
    if (!r) return problem(404, 'not_found', 'Record not found');
    const bad = noMatch(request, r); if (bad) return bad;
    if (!actions(r)!.includes('transfer')) return problem(403, 'not_eligible_holder', 'Only the person who holds this draft, or an entry holder (L1) of its row, can transfer it.');
    const body = (await request.json().catch(() => ({}))) as { note?: string };
    const holders = holdersOf(db().matrix, rk(r), 1, r.levels_required ?? levelsOf(r.register_key)).filter((h) => h.kind === 'user');
    step(r, 'transfer', 1, body.note);
    r.transferred = true;
    if (holders.length === 1) r.claimed_by = { id: uid(holders[0]!.employee_id ?? '9999'), display_name: holders[0]!.label, employee_id: holders[0]!.employee_id ?? undefined };
    touch(r); save();
    return tag(r);
  }),
  http.get(`${B}/registers/:key/records/:id/history`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key);
    return r ? page(r.steps) : problem(404, 'not_found', 'Record not found');
  }),
  // every version of the logical record, newest first; and a new version of the approved one (R9, Q55)
  http.get(`${B}/registers/:key/records/:id/versions`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key);
    return r ? HttpResponse.json({ items: versionsOf(r).map(toRecord) }) : problem(404, 'not_found', 'Record not found');
  }),
  http.post(`${B}/registers/:key/records/:id/versions`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key), def = defOf(params.key as string);
    if (!r || !def) return problem(404, 'not_found', 'Record not found');
    const bad = noMatch(request, r); if (bad) return bad;
    if (!canAt(rk(r), 1, r.levels_required ?? levelsOf(r.register_key))) return problem(403, 'not_eligible_holder', 'You do not hold this level');
    if (r.state !== 'approved' || !isCurrent(r) || hasOpenVersion(r)) return problem(409, 'invalid_transition', 'Only an approved record without an open version can get a new version');
    const now = new Date().toISOString(), id = recId(++R().seq);
    const ro = new Set(def.fields.filter((f) => f.read_only).map((f) => f.code));
    const v: MockRecord = { ...r, id, version_no: r.version_no + 1, supersedes_id: r.id, state: 'entry', current_level: 1, levels_required: levelsOf(r.register_key), version: 1, return_count: 0, last_return_note: null, task: null,
      data: Object.fromEntries(Object.entries(r.data).filter(([c]) => !ro.has(c))), created_at: now, updated_at: now, created_by: viewer()!.employee_id ?? '9999', steps: [], claimed_by: undefined };
    step(v, 'new_version', 1);
    linkHlc(v);
    R().records.unshift(v); save();
    return HttpResponse.json(toRecord(v), { status: 201, headers: { ETag: `"${v.version}"` } });
  }),


  // ---- template entry (contract 0.7.0). The upload is staged at once (status `validated`); the uploader sends it into the flow (the rows become records
  // waiting for L2); L2 approves rows, returns them with a note, or approves all; a row whose record has an open version is held.
  http.get(`${B}/import-batches`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const status = u.get('status'), tpl = u.get('template_id'), reg = u.get('register_key'), stream = u.get('stream'), group = u.get('group_id');
    if (group && !/^[0-9a-f-]{36}$/i.test(group)) return problem(422, 'validation_failed', 'group_id is a uuid.', { errors: [{ path: '/group_id', code: 'invalid' }] });
    const items = R().batches.filter((b) => (!status || statusOf(b) === status) && (!tpl || b.template_id === tpl) && (!reg || b.register_key === reg)
      && (!stream || b.stream === stream) && (!group || b.group_id === group)).map((b) => toBatch(b));
    return page(items);
  }),
  http.post(`${B}/import-batches`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const fd = await request.formData();
    const tpl = String(fd.get('template_id') ?? ''), f = fd.get('file');
    const key = REGISTER_TEMPLATES[tpl];
    const reject = (reason: string, title: string) => problem(422, 'template_rejected', title, { reason, detail: title } as never);
    const stream = STREAM_TEMPLATES[tpl];
    if (tpl === 'TPL-SITE-NEW') {
      // contract 0.14.0 (Q460): a New sites file is one batch of site rows; the task_id of a task upload is refused
      if (!['pm', 'reviewer'].includes(viewer()?.key ?? '')) return problem(403, 'action_forbidden', 'You need create on sites and import on templates to import new sites.');
      if (fd.get('task_id')) return reject('wrong_template', 'The New sites template is not used from a task.');
      if (!f || typeof f === 'string' || f.size === 0) return problem(422, 'validation_failed', 'The file is empty', { errors: [{ path: '/file', code: 'required' }] });
      if (f.name !== 'blob' && !f.name.toLowerCase().endsWith('.xlsx')) return reject(f.name.toLowerCase().endsWith('.xlsm') ? 'macros_not_allowed' : 'not_xlsx', 'Only plain .xlsx workbooks are accepted.');
      const text = await f.text();
      if (text.includes('notpl')) return reject('tpl_missing', 'This file is not an approved PMIS template: the hidden _tpl sheet is missing.');
      if (text.includes('retired')) return reject('outdated_version', `This file was made from version 1 of ${tpl}; the current version is 2. Download the template again.`);
      if (text.includes('tampered')) return reject('checksum_mismatch', 'The header row of the file was changed.');
      const big = /bigsites(\d+)/.exec(text); // a test file of many new sites: `bigsites469`
      const b = makeSiteBatch(f.name, big ? Number(big[1]) : undefined);
      R().batches.unshift(b); save();
      return HttpResponse.json(toBatch(b), { status: 202, headers: { ETag: `"${b.version}"` } });
    }
    if ((stream || tpl === 'TPL-MASTER') && !fd.get('task_id')) {
      // contract 0.11.5: a stream file is one batch of task rows; a TPL-MASTER file is split into one batch per part, with warnings
      if (!f || typeof f === 'string' || f.size === 0) return problem(422, 'validation_failed', 'The file is empty', { errors: [{ path: '/file', code: 'required' }] });
      if (f.name !== 'blob' && !f.name.toLowerCase().endsWith('.xlsx')) return reject(f.name.toLowerCase().endsWith('.xlsm') ? 'macros_not_allowed' : 'not_xlsx', 'Only plain .xlsx workbooks are accepted.');
      const text = await f.text();
      if (text.includes('notpl')) return reject('tpl_missing', 'This file is not an approved PMIS template: the hidden _tpl sheet is missing.');
      if (text.includes('retired')) return reject('outdated_version', `This file was made from version 1 of ${tpl}; the current version is 2. Download the template again.`);
      if (text.includes('tampered')) return reject('checksum_mismatch', 'The header row of the file was changed.');
      if (text.includes('otherstream')) return reject('wrong_template', `This file is the template ${tpl === 'TPL-SITE-CW' ? 'TPL-SITE-TE' : 'TPL-SITE-CW'}, but ${tpl} was selected.`);
      if (stream) {
        const b = makeStreamBatch(stream, tpl, f.name);
        const hl = fd.get('historical_load_reason');
        if (hl !== null) {
          // Q462 (0.14.3): a System Admin only, with a step-up, while the waiver is open, in submit mode; the rows before the cutoff are not refused for missing documents
          const w = waiver();
          if (!isSystemAdmin()) return problem(403, 'action_forbidden', 'Action not allowed', { detail: 'Only a System Admin can accept a batch without documents (historical load).' });
          if (!stepUpValid()) return stepUp();
          if (String(hl).trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/historical_load_reason', code: 'required', message: 'A reason is required.' }] });
          if (fd.get('mode') === 'draft') return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/mode', code: 'invalid', message: 'The historical load is for Submit for Review.' }] });
          if (!w.open) return problem(409, 'invalid_transition', 'Not possible now', { detail: 'The historical-load waiver is closed: a batch cannot be accepted without documents.' });
          b.historical = { cutoff_date: w.cutoff_date!, reason: String(hl).trim(), marked_at: new Date().toISOString() };
          const first = b.rows.find((r) => r.action === 'update');
          if (first) first.warnings = [...(first.warnings ?? []), { column: `${first.task_code} Actual Date`, code: 'historical_no_documents', message: 'Missing document(s). Accepted without documents under the historical-load waiver; the task will be flagged.' }];
        }
        R().batches.unshift(b); save();
        return HttpResponse.json(toBatch(b), { status: 202, headers: { ETag: `"${b.version}"` } });
      }
      const gid = crypto.randomUUID(), parts = [makeStreamBatch('CW', 'TPL-SITE-CW', f.name, gid), makeStreamBatch('TE', 'TPL-SITE-TE', f.name, gid), makeBatch('gecol', 'TPL-GECOL', f.name)];
      Object.assign(parts[2]!, { group_id: gid, part_sheet: 'GECOL' });
      const bigRows = /bigmaster(\d+)/.exec(text);
      if (bigRows) {
        // 0.15.3: a big file is staged in the background: 202 `parsing` with the progress; each read of the upload stages 100 more rows, then it answers its parts
        const up: MockUpload = { id: gid, file_name: f.name, parts, rows_total: Number(bigRows[1]), rows_done: 0, created_at: new Date().toISOString(), warnings: [
          { code: 'column_not_owned', sheet: 'Master', column: 'Milestone / PRE-CW Completion Date', count: 3, message: 'The column "Milestone / PRE-CW Completion Date" is calculated by GSDN Workspace: 3 value(s) ignored.' }] };
        UPLOADS.set(gid, up);
        return HttpResponse.json(uploadDto(up), { status: 202, headers: { ETag: '"0"' } });
      }
      for (const p of [...parts].reverse()) R().batches.unshift(p);
      save();
      const warnings = [
        { code: 'column_not_owned', sheet: 'Master', column: 'Milestone / PRE-CW Completion Date', count: 3, message: 'The column "Milestone / PRE-CW Completion Date" is calculated by GSDN Workspace: 3 value(s) ignored.' },
        { code: 'extra_column', sheet: 'Master', column: 'My own notes', message: 'The column "My own notes" is not owned by GSDN Workspace: it is ignored.' },
        ...(text.includes('skipgecol') ? [] : []),
      ];
      return HttpResponse.json({ ...toBatch(parts[0]!), parts: parts.map(toBatch), warnings }, { status: 202, headers: { ETag: `"${parts[0]!.version}"` } });
    }
    if (!key || fd.get('task_id')) { // per-task upload (task grid): the earlier answer
      if (!f || typeof f === 'string' || f.size === 0) return reject('tpl_missing', 'The file has no template ID.');
      return HttpResponse.json({ id: crypto.randomUUID(), template_id: tpl || 'TPL-SITE', template_version: 1, status: 'validated', counts: {}, version: 1, file_name: f.name }, { status: 202 });
    }
    if (!f || typeof f === 'string' || f.size === 0) return problem(422, 'validation_failed', 'The file is empty', { errors: [{ path: '/file', code: 'required' }] });
    // (jsdom and undici have different File classes: a file that crossed the boundary may come back named "blob")
    if (f.name !== 'blob' && !f.name.toLowerCase().endsWith('.xlsx')) return reject(f.name.toLowerCase().endsWith('.xlsm') ? 'macros_not_allowed' : 'not_xlsx', 'Only plain .xlsx workbooks are accepted.');
    const text = await f.text();
    if (text.includes('notpl')) return reject('tpl_missing', 'This file is not an approved PMIS template: the hidden _tpl sheet is missing.');
    if (text.includes('retired')) return reject('outdated_version', `This file was made from version 1 of ${tpl}; the current version is 2. Download the template again.`);
    if (text.includes('tampered')) return reject('checksum_mismatch', 'The header row of the file was changed.');
    const b = makeBatch(key, tpl, f.name);
    R().batches.unshift(b); save();
    return HttpResponse.json(toBatch(b), { status: 202, headers: { ETag: `"${b.version}"` } });
  }),
  http.get(`${B}/import-batches/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const up = UPLOADS.get(String(params.id));
    if (up) {
      // 0.15.3: the upload moves by 100 rows per read; once staged, the same id answers the first part with the parts and the warnings
      if (up.rows_done < up.rows_total) {
        up.rows_done = Math.min(up.rows_total, up.rows_done + 100);
        if (up.rows_done >= up.rows_total) { for (const p of [...up.parts].reverse()) R().batches.unshift(p); save(); }
        if (up.rows_done < up.rows_total) return HttpResponse.json(uploadDto(up), { headers: { ETag: '"0"' } });
      }
      return HttpResponse.json({ ...toBatch(up.parts[0]!), upload_id: up.id, group_id: up.id, parts: up.parts.map(toBatch), warnings: up.warnings }, { headers: { ETag: `"${up.parts[0]!.version}"` } });
    }
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    if (b.run?.state === 'running') { advanceRun(b); save(); }   // 0.14.4: the background run moves by one chunk per read
    return HttpResponse.json(toBatch(b), { headers: { ETag: `"${b.version}"` } });
  }),
  http.get(`${B}/import-batches/:id/rows`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    const u = new URL(request.url).searchParams, action = u.get('action'), decision = u.get('decision');
    const all = b.rows.filter((r) => (!action || r.action === action) && (!decision || (r.action !== 'error' && r.action !== 'unchanged' && decisionOf(r) === decision)));
    // keyset paging like the API: `limit` (default 200, at most 200) and an opaque `next_cursor` (here the offset), null on the last page
    const limit = Math.min(Math.max(Number(u.get('limit')) || 200, 1), 200), start = Math.max(Number(u.get('cursor')) || 0, 0);
    return HttpResponse.json({ items: all.slice(start, start + limit).map(toRow), page: { limit, next_cursor: start + limit < all.length ? String(start + limit) : null, total: all.length } });
  }),
  http.post(`${B}/import-batches/:id/submit`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    if (b.run?.state === 'running') return processing(b);
    const bad = batchMatch(request, b); if (bad) return bad;
    const v = viewer()!;
    if (b.uploaded_by !== (v.employee_id ?? '9999')) return problem(403, 'not_eligible_holder', 'Only the person who uploaded the file can send it into the flow.');
    if (!['validated', 'sent'].includes(b.status) || ['discarded'].includes(statusOf(b))) return problem(409, 'invalid_transition', 'The batch is not waiting to be sent');
    if (!b.rows.some((r) => r.action === 'create' || r.action === 'update')) return problem(422, 'validation_failed', 'No valid rows', { errors: [{ path: '/rows', code: 'no_valid_rows' }] });
    if (b.entity === 'site') {
      // each valid row becomes a site draft waiting for L2; a person who holds both levels (the PM) approves at once, with step-up (B5)
      const self = viewer()?.key === 'pm';
      if (self && !stepUpValid()) return stepUp();
      const sent = b.rows.filter((r) => r.action === 'create' && r.decision === 'pending');
      if (sent.length > ASYNC_ROWS) return startRun(b, 'submit', sent, self);   // 0.14.4: 202, processing in the background
      for (const r of sent) if (self) { r.decision = 'approved'; r.site_id = siteMeta(20).id; }
      b.status = 'sent'; b.version += 1; save();
      return HttpResponse.json({ ...toBatch(b), outcome: { submitted: sent.length, held: [], failed: [] } }, { headers: { ETag: `"${b.version}"` } });
    }
    if (b.stream) {
      // 0.14.6: a big stream batch is sent in the background (the PM holds both levels in the mock: a self-approval, with step-up)
      const toSend = b.rows.filter((r) => r.action === 'update' && r.decision === 'pending');
      if (toSend.length > ASYNC_ROWS) {
        const self = viewer()?.key === 'pm';
        if (self && !stepUpValid()) return stepUp();
        return startRun(b, 'submit', toSend, self, 'stream');
      }
      // each task row starts the task, saves the entry and submits it as L1; a row that waits for a predecessor or a review stays held
      const out: Outcome = { submitted: 0, held: [], failed: [] };
      for (const row of b.rows) {
        if (row.action !== 'update' || row.decision === 'approved' || row.decision === 'rejected') continue;
        if (row.decision === 'pending_previous_approval') { out.held.push({ row_id: row.id, row_no: row.row_no, key: row.key, reason: row.hold_reason ?? 'predecessor_open', record_id: null }); continue; }
        out.submitted! += 1;
      }
      b.status = 'sent'; b.version += 1; save();
      return HttpResponse.json({ ...toBatch(b), outcome: out }, { headers: { ETag: `"${b.version}"` } });
    }
    const key = b.register_key as RegisterKey, selfApproval = userHolds(key, 1, v.employee_id, 2) && userHolds(key, 2, v.employee_id, 2);
    if (selfApproval && !stepUpValid() && b.rows.some((r) => (r.action === 'create' || r.action === 'update') && r.decision === 'pending' && !r.record_id && !openVersionOf(r))) return stepUp();
    // 0.14.6: a big register batch is sent in the background (the step-up of a self-approval is asked now, above)
    const toSend = b.rows.filter((r) => (r.action === 'create' || r.action === 'update') && !r.record_id && r.decision !== 'approved' && r.decision !== 'rejected');
    if (toSend.length > ASYNC_ROWS) return startRun(b, 'submit', toSend, selfApproval, 'register');
    const outcome: Outcome = { submitted: 0, held: [], failed: [] };
    for (const row of b.rows) {
      if ((row.action !== 'create' && row.action !== 'update') || row.record_id || row.decision === 'approved' || row.decision === 'rejected') continue;
      const open = openVersionOf(row);
      if (open) { row.decision = 'pending_previous_approval'; row.hold_reason = 'open_version'; row.hold_record_id = open.id; outcome.held.push({ row_id: row.id, row_no: row.row_no, key: row.key, reason: 'open_version', record_id: open.id }); continue; }
      const rec = createRecordFor(b, row, selfApproval);
      row.record_id = rec.id; row.decision = rec.state === 'approved' ? 'approved' : 'pending'; row.hold_reason = undefined; row.hold_record_id = undefined;
      outcome.submitted! += 1;
    }
    b.status = 'sent'; b.version += 1; save();
    return HttpResponse.json({ ...toBatch(b), outcome }, { headers: { ETag: `"${b.version}"` } });
  }),
  http.post(`${B}/import-batches/:id/decisions`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    if (b.run?.state === 'running') return processing(b);
    const bad = batchMatch(request, b); if (bad) return bad;
    const body = (await request.json()) as { action: 'review' | 'approve' | 'reject' | 'discard'; scope: 'all' | 'rows'; rows?: { row_id: string; decision: 'approved' | 'rejected'; note?: string }[]; note?: string };
    const v = viewer()!, me = v.employee_id ?? '9999';
    if (body.action === 'discard') {
      if (b.uploaded_by !== me && v.key !== 'pm') return problem(403, 'not_eligible_holder', 'Only the person who uploaded the file can discard it.');
      if (b.status !== 'validated') return problem(409, 'invalid_transition', 'Only a batch that has not been sent can be discarded. Return the rows with a note instead.');
      b.rows.forEach((r) => { r.decision = 'rejected'; r.note = body.note ?? 'discarded'; });
      b.status = 'discarded'; b.note = body.note ?? null; b.version += 1; save();
      return HttpResponse.json({ ...toBatch(b), outcome: { decided: 0, approved: 0, rejected: 0, held: [], failed: [] } }, { headers: { ETag: `"${b.version}"` } });
    }
    if (b.status !== 'sent') return problem(409, 'invalid_transition', b.status === 'validated' ? 'The batch has not been sent into the flow yet.' : `The batch is ${statusOf(b)}.`);
    if (body.action === 'reject' && body.scope === 'all' && !body.note?.trim()) return problem(422, 'note_required', 'A return needs a note', { errors: [{ path: '/note', code: 'required' }] });
    if (b.entity === 'site') {
      // L2 approves a row (a site is created; step-up) or returns it with a note
      if (!['pm', 'reviewer'].includes(viewer()?.key ?? '')) return problem(403, 'not_eligible_holder', 'You are not a Review and Approve holder (L2) of the Site creation row.');
      const rows = b.rows.filter((r) => r.action === 'create' && r.decision === 'pending' && (body.scope === 'all' || (body.rows ?? []).some((x) => x.row_id === r.id)));
      if (body.scope === 'rows' && !rows.length) return problem(422, 'validation_failed', 'Unknown or decided row', { errors: [{ path: '/rows', code: 'invalid_row' }] });
      const wantsApprove = rows.some((r) => body.action === 'approve' && (body.scope === 'all' || body.rows!.find((x) => x.row_id === r.id)?.decision !== 'rejected'));
      if (wantsApprove && !stepUpValid()) return stepUp();
      if (body.action === 'approve' && rows.length > ASYNC_ROWS && rows.every((r) => body.scope === 'all' || body.rows!.find((x) => x.row_id === r.id)?.decision !== 'rejected')) {
        return startRun(b, 'decide', rows, true);   // 0.14.4: 202, the sites are created in the background
      }
      const res: Outcome = { decided: 0, approved: 0, rejected: 0, held: [], failed: [] };
      for (const r of rows) {
        const one = body.scope === 'rows' ? body.rows!.find((x) => x.row_id === r.id)! : null;
        const act = body.action === 'reject' || one?.decision === 'rejected' ? 'reject' : 'approve', note = (one?.note ?? body.note ?? '').trim();
        if (act === 'reject') {
          if (!note) return problem(422, 'note_required', 'A return needs a note', { errors: [{ path: '/note', code: 'required' }] });
          r.decision = 'rejected'; r.note = note; res.rejected! += 1; res.decided! += 1;
        } else { r.decision = 'approved'; r.site_id = siteMeta(20).id; res.approved! += 1; res.decided! += 1; }
      }
      b.version += 1; if (body.action === 'reject' && body.note) b.note = body.note.trim(); save();
      return HttpResponse.json({ ...toBatch(b), outcome: res }, { headers: { ETag: `"${b.version}"` } });
    }
    if (b.stream) {
      // the same transitions as on the task: L2 decides each row (a final approval needs the step-up), a return sends the task back to L1 with the note
      if (!(viewer()?.key === 'pm' || viewer()?.key === 'reviewer')) return problem(403, 'not_eligible_holder', 'You do not hold this level');
      const rows = b.rows.filter((r) => r.action === 'update' && ['pending', 'pending_previous_approval'].includes(r.decision) && (body.scope === 'all' || (body.rows ?? []).some((x) => x.row_id === r.id)));
      if (body.scope === 'rows' && !rows.length) return problem(422, 'validation_failed', 'Unknown or decided row', { errors: [{ path: '/rows', code: 'invalid_row' }] });
      if (body.action === 'approve' && rows.some((r) => r.decision === 'pending') && !stepUpValid()) return stepUp();
      if (rows.length > ASYNC_ROWS) { const bad = notesMissing(body, rows); if (bad) return bad; return startRun(b, 'decide', rows, false, 'stream', body); }   // 0.14.6
      const res: Outcome = { decided: 0, approved: 0, rejected: 0, held: [], failed: [] };
      for (const r of rows) {
        const one = body.scope === 'rows' ? body.rows!.find((x) => x.row_id === r.id)! : null;
        const act = body.action === 'reject' || one?.decision === 'rejected' ? 'reject' : 'approve', note = (one?.note ?? body.note ?? '').trim();
        if (act === 'reject') {
          if (!note) return problem(422, 'note_required', 'A return needs a note', { errors: [{ path: '/note', code: 'required' }] });
          r.decision = 'rejected'; r.note = note; r.hold_reason = undefined; res.rejected! += 1; res.decided! += 1;
        } else if (r.decision === 'pending_previous_approval') res.held.push({ row_id: r.id, row_no: r.row_no, key: r.key, reason: r.hold_reason ?? 'predecessor_open', record_id: null });
        else { r.decision = 'approved'; res.approved! += 1; res.decided! += 1; }
      }
      b.version += 1; if (body.action === 'reject' && body.note) b.note = body.note.trim(); save();
      return HttpResponse.json({ ...toBatch(b), outcome: res }, { headers: { ETag: `"${b.version}"` } });
    }
    if (!canAt(b.register_key as RegisterKey, 2, 2)) return problem(403, 'not_eligible_holder', 'You do not hold this level');
    const targets = b.rows.filter((r) => (r.action === 'create' || r.action === 'update') && ['pending', 'pending_previous_approval'].includes(decisionOf(r))
      && (body.scope === 'all' || (body.rows ?? []).some((x) => x.row_id === r.id)));
    if (body.scope === 'rows' && !targets.length) return problem(422, 'validation_failed', 'Unknown or decided row', { errors: [{ path: '/rows', code: 'invalid_row' }] });
    if (body.action === 'approve' && targets.some((r) => r.record_id) && !stepUpValid()) return stepUp();
    if (targets.length > ASYNC_ROWS) { const bad = notesMissing(body, targets); if (bad) return bad; return startRun(b, 'decide', targets, false, 'register', body); }   // 0.14.6
    const out: Outcome = { decided: 0, approved: 0, rejected: 0, held: [], failed: [] };
    for (const r of targets) {
      const one = body.scope === 'rows' ? body.rows!.find((x) => x.row_id === r.id)! : null;
      const act = body.action === 'reject' || one?.decision === 'rejected' ? 'reject' : 'approve';
      const note = (one?.note ?? body.note ?? '').trim();
      if (!r.record_id) { // held: no record yet; "approve all" lists it, a return takes it back
        if (act === 'reject') { if (!note) return problem(422, 'note_required', 'A return needs a note', { errors: [{ path: '/note', code: 'required' }] }); r.decision = 'rejected'; r.note = note; r.hold_reason = undefined; out.decided! += 1; out.rejected! += 1; }
        else out.held.push({ row_id: r.id, row_no: r.row_no, key: r.key, reason: 'open_version', record_id: r.hold_record_id ?? null });
        continue;
      }
      const rec = R().records.find((x) => x.id === r.record_id)!;
      if (act === 'reject') {
        if (!note) return problem(422, 'note_required', 'A return needs a note', { errors: [{ path: '/note', code: 'required' }] });
        step(rec, 'reject', 2, note, false, r.id); rec.state = 'entry'; rec.current_level = 1; rec.return_count += 1; rec.last_return_note = note; touch(rec);
        r.decision = 'rejected'; r.note = note; out.rejected! += 1;
      } else {
        step(rec, 'approve', 2, undefined, false, r.id); rec.state = 'approved'; rec.current_level = 2; touch(rec);
        r.decision = 'approved'; out.approved! += 1;
      }
      out.decided! += 1;
    }
    b.version += 1; if (body.action === 'reject' && body.note) b.note = body.note.trim(); save();
    return HttpResponse.json({ ...toBatch(b), outcome: out }, { headers: { ETag: `"${b.version}"` } });
  }),
];

// ---- batch helpers
/**
 * Contract 0.14.4: a New sites batch with more rows than imports.async_rows (50) is sent or approved in the background, 25 rows per chunk. Contract 0.14.6: register
 * batches (50 rows per chunk) and stream batches (25) too, for a send and for an approve, review or return.
 */
export const ASYNC_ROWS = 50;
const CHUNK = 25;
const CHUNK_OF: Record<string, number> = { site: 25, register: 50, stream: 25 };
type DecideBody = { action: 'review' | 'approve' | 'reject' | 'discard'; scope: 'all' | 'rows'; rows?: { row_id: string; decision: 'approved' | 'rejected'; note?: string }[]; note?: string };
/** A return needs a note on every row it returns (as the request of the API, which refuses it all before anything is queued). */
const notesMissing = (body: DecideBody, rows: MockBatchRow[]) => rows.some((r) => {
  const one = body.scope === 'rows' ? body.rows?.find((x) => x.row_id === r.id) : undefined;
  return (body.action === 'reject' || one?.decision === 'rejected') && !(one?.note ?? body.note ?? '').trim();
}) ? problem(422, 'note_required', 'A return needs a note', { errors: [{ path: '/note', code: 'required' }] }) : null;
function startRun(b: MockBatch, kind: MockRun['kind'], rows: MockBatchRow[], self: boolean, batchKind: 'site' | 'register' | 'stream' = 'site', body?: DecideBody) {
  const now = new Date().toISOString();
  const choices = body?.scope === 'rows' ? Object.fromEntries((body.rows ?? []).map((x) => [x.row_id, { decision: x.decision, note: x.note }])) : undefined;
  b.run = { id: crypto.randomUUID(), kind, state: 'running', rows: rows.map((r) => r.id), done: 0, self, submitted: 0, approved: 0, failed: 0, started_at: now, updated_at: now, finished_at: null,
    batchKind, action: kind === 'decide' ? (body?.action === 'discard' ? null : body?.action ?? 'approve') : null, note: body?.note ?? null, choices, decided: 0, rejected: 0, held: 0 };
  b.version += 1; save();
  return HttpResponse.json(toBatch(b), { status: 202, headers: { ETag: `"${b.version}"` } });
}
/** One row of a register or a stream run (0.14.6), by the same rules as the synchronous mock paths. */
function runRow(b: MockBatch, run: MockRun, r: MockBatchRow) {
  if (run.kind === 'submit') {
    if (run.batchKind === 'register') {
      const open = openVersionOf(r);
      if (open) { r.decision = 'pending_previous_approval'; r.hold_reason = 'open_version'; r.hold_record_id = open.id; run.held = (run.held ?? 0) + 1; return; }
      const rec = createRecordFor(b, r, run.self);
      r.record_id = rec.id; r.decision = rec.state === 'approved' ? 'approved' : 'pending';
    } else if (run.self) r.decision = 'approved';
    run.submitted += 1;
    if (r.decision === 'approved') run.approved += 1;
    return;
  }
  const one = run.choices?.[r.id];
  const act = run.action === 'reject' || one?.decision === 'rejected' ? 'reject' : run.action === 'review' ? 'review' : 'approve';
  const note = (one?.note ?? run.note ?? '').trim();
  const rec = r.record_id ? R().records.find((x) => x.id === r.record_id) : undefined;
  if (run.batchKind === 'register' && !rec && act !== 'reject') { run.held = (run.held ?? 0) + 1; return; }
  if (act === 'reject') {
    if (rec) { step(rec, 'reject', 2, note, false, r.id); rec.state = 'entry'; rec.current_level = 1; rec.return_count += 1; rec.last_return_note = note; touch(rec); }
    r.decision = 'rejected'; r.note = note; r.hold_reason = undefined; run.rejected = (run.rejected ?? 0) + 1;
  } else if (act === 'approve') {
    if (rec) { step(rec, 'approve', 2, undefined, false, r.id); rec.state = 'approved'; rec.current_level = 2; touch(rec); }
    r.decision = 'approved'; run.approved += 1;
  }
  run.decided = (run.decided ?? 0) + 1;
}
function advanceRun(b: MockBatch) {
  const run = b.run!;
  const size = CHUNK_OF[run.batchKind ?? 'site'] ?? CHUNK;
  for (const id of run.rows.slice(run.done, run.done + size)) {
    const r = b.rows.find((x) => x.id === id)!;
    if (run.batchKind && run.batchKind !== 'site') { runRow(b, run, r); continue; }
    if (run.kind === 'submit') { run.submitted += 1; if (run.self) { r.decision = 'approved'; r.site_id = siteMeta(20).id; run.approved += 1; } }
    else { r.decision = 'approved'; r.site_id = siteMeta(20).id; run.approved += 1; }
  }
  run.done = Math.min(run.rows.length, run.done + size);
  run.updated_at = new Date().toISOString();
  if (run.done >= run.rows.length) { run.state = 'done'; run.finished_at = run.updated_at; b.status = 'sent'; b.version += 1; }
}
const processing = (b: MockBatch) => problem(409, 'batch_processing', 'The batch is being processed', { detail: `The batch is being processed (${b.run!.done} of ${b.run!.rows.length} rows). Wait until it ends.` } as never);
const progressOf = (run: MockRun | undefined): ImportBatch['progress'] => run ? {
  job_id: run.id, kind: run.kind, action: run.action ?? null, batch_kind: run.batchKind ?? 'site', state: run.state, rows_total: run.rows.length, rows_done: run.done,
  percent: run.rows.length ? Math.floor((100 * run.done) / run.rows.length) : 100, submitted: run.submitted, approved: run.approved, rejected: run.rejected ?? 0,
  decided: run.decided ?? 0, held: run.held ?? 0, saved: 0, failed: run.failed, started_at: run.started_at, updated_at: run.updated_at, finished_at: run.finished_at, error: null,
} : null;
type Outcome = { submitted?: number; decided?: number; approved?: number; rejected?: number; held: { row_id: string; row_no: number; key: string | null; reason: 'open_version' | 'open_submission' | 'predecessor_open'; record_id?: string | null }[]; failed: { row_id: string; row_no: number; key: string | null; code: string; message?: string }[] };
const batchMatch = (req: Request, b: MockBatch) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === b.version ? null : problem(412, 'precondition_failed', 'The batch changed; reload');
};
/** The decision of a row follows its record (an approval made in the register screen counts too), as the API does. */
function decisionOf(r: MockBatchRow): MockBatchRow['decision'] {
  const rec = r.record_id ? R().records.find((x) => x.id === r.record_id) : undefined;
  if (r.decision === 'pending' && rec) { if (rec.state === 'approved') return 'approved'; if (rec.state === 'voided' || (rec.state === 'entry' && rec.steps.some((s) => s.action === 'submit'))) return 'rejected'; }
  return r.decision;
}
function statusOf(b: MockBatch): ImportBatch['status'] {
  if (b.run?.state === 'running') return 'processing';
  if (b.status !== 'sent') return b.status;
  const valid = b.rows.filter((r) => r.action === 'create' || r.action === 'update'), d = (x: string) => valid.filter((r) => decisionOf(r) === x).length;
  const open = d('pending') + d('pending_previous_approval');
  return open > 0 ? (d('approved') + d('rejected') > 0 ? 'partially_approved' : 'in_approval') : d('approved') > 0 ? 'approved' : 'rejected';
}
/** The open (not yet approved) version of the record a row would change: it holds the row. */
function openVersionOf(row: MockBatchRow): MockRecord | undefined {
  const base = row.base_id ? R().records.find((x) => x.id === row.base_id) : undefined;
  return base ? R().records.find((x) => x.entity_id === base.entity_id && ['entry', 'in_review', 'in_approval'].includes(x.state)) : row.hold_record_id ? R().records.find((x) => x.id === row.hold_record_id && ['entry', 'in_review', 'in_approval'].includes(x.state)) : undefined;
}
/** The row becomes a record in the flow (L1 done by the uploader); a person who holds L1 and L2 makes it a self-approval (B5). */
function createRecordFor(b: MockBatch, row: MockBatchRow, self: boolean): MockRecord {
  const now = new Date().toISOString(), id = recId(++R().seq);
  const base = row.base_id ? R().records.find((x) => x.id === row.base_id) : undefined;
  const rec: MockRecord = {
    id, entity_id: base?.entity_id ?? id, version_no: base ? base.version_no + 1 : 1, supersedes_id: base?.id ?? null, register_key: b.register_key as RegisterKey, record_type: base?.record_type ?? (b.register_key === 'procurement' ? 'pr' : null),
    site_index: row.site_index, state: self ? 'approved' : 'in_approval', current_level: 2, levels_required: 2, data: { ...(base?.data ?? {}), ...row.payload }, version: 1, return_count: 0, last_return_note: null,
    created_by: b.uploaded_by, created_at: now, updated_at: now, steps: [], source: 'template', batch_row_id: row.id,
  };
  step(rec, base ? 'new_version' : 'create', 1, undefined, false, row.id);
  step(rec, 'edit', 1, undefined, false, row.id);
  step(rec, 'submit', 1, undefined, self, row.id);
  R().records.unshift(rec);
  return rec;
}
function makeBatch(key: MockRecord['register_key'], template_id: string, file_name: string): MockBatch {
  const def = defOf(key)!;
  const sample = (i: number): Record<string, unknown> => key === 'procurement' ? { scope: 'CW', delivery: 'Outsourced', pr_no: `PR-2026-1${i}`, pr_date: '2026-09-1' + i, order_status: 'Open' }
    : key === 'gecol' ? { pr_no: `GPR-2026-1${i}`, request_date: '2026-09-0' + i, survey_date: `2026-09-0${i + 1}`, meter_no: `M-9${i}00` } : key === 'hlc' ? { request_no: `HLC-2026-1${i}`, request_date: '2026-09-1' + i, fiber_status: 'Planned' }
      : { permit_type: 'Access - CW', status: 'Approved', valid_from: `2026-09-0${i + 1}`, has_expiry: true, valid_to: '2027-01-01' };
  const change: Record<string, unknown> = key === 'procurement' ? { order_status: 'Issued' } : key === 'gecol' ? { meter_no: 'M-99999' } : key === 'hlc' ? { fiber_status: 'Installed' } : { valid_to: '2027-06-30' };
  const taken = new Set(R().records.filter((r) => r.register_key === key && !def.multiple_per_site).map((r) => r.site_index));
  const sites = [10, 11, 12, 13].map((s) => { let x = s; while (taken.has(x)) x += 7; return x; });
  const rows: MockBatchRow[] = sites.slice(0, 2).map((s, i) => ({ id: crypto.randomUUID(), row_no: i + 2, key: siteMeta(s).code, action: 'create' as const, decision: 'pending' as const, payload: sample(i + 1), site_index: s, errors: [], diff: Object.fromEntries(Object.entries(sample(i + 1)).slice(0, 4).map(([k, v]) => [k, { old: null, new: v }])) }));
  // an update of the newest approved record of the register (a new version, once approved), and a row held because its record has an open version
  const approved = R().records.find((r) => r.register_key === key && r.state === 'approved' && isCurrent(r) && !hasOpenVersion(r));
  if (approved) rows.push({ id: crypto.randomUUID(), row_no: 4, key: siteMeta(approved.site_index ?? 0).code, action: 'update', decision: 'pending', payload: change, site_index: approved.site_index, errors: [], base_id: approved.id,
    diff: Object.fromEntries(Object.entries(change).map(([k, v]) => [k, { old: approved.data[k] ?? null, new: v }])) });
  const open = R().records.find((r) => r.register_key === key && ['entry', 'in_review', 'in_approval'].includes(r.state) && r.site_index !== null && R().records.some((x) => x.entity_id === r.entity_id && x.state === 'approved'));
  if (open) rows.push({ id: crypto.randomUUID(), row_no: 5, key: siteMeta(open.site_index!).code, action: 'update', decision: 'pending_previous_approval', hold_reason: 'open_version', hold_record_id: open.id, payload: change, site_index: open.site_index, errors: [],
    base_id: R().records.find((x) => x.entity_id === open.entity_id && x.state === 'approved')!.id, diff: Object.fromEntries(Object.entries(change).map(([k, v]) => [k, { old: null, new: v }])) });
  rows.push({ id: crypto.randomUUID(), row_no: 6, key: siteMeta(sites[3]).code, action: 'unchanged', decision: 'pending', payload: sample(4), site_index: sites[3], errors: [], diff: {} });
  rows.push({ id: crypto.randomUUID(), row_no: 7, key: 'XX999', action: 'error', decision: 'pending', payload: {}, site_index: null, errors: [{ column: 'Site ID', field: 'site_code', code: 'site_not_in_scope', message: 'Unknown site, or a site outside your regions.' }], diff: {} });
  const dateField = def.fields.find((f) => f.type === 'date');
  rows.push({ id: crypto.randomUUID(), row_no: 8, key: siteMeta(14).code, action: 'error', decision: 'pending', payload: {}, site_index: 14, errors: [{ column: dateField?.label_en ?? 'Date', field: dateField?.code ?? 'date', code: 'invalid_date', message: 'The date must be between 2020-01-01 and 2035-12-31.' }], diff: {} });
  return { id: crypto.randomUUID(), register_key: key, template_id, file_name, status: 'validated', version: 1, created: Date.now(), uploaded_by: viewer()!.employee_id ?? '9999', uploaded_at: new Date().toISOString(), rows };
}
/** A New sites batch (contract 0.14.0): two valid rows (one Cancelled, with a cluster that will be created), a Site ID that exists already and an unknown region. */
function makeSiteBatch(file_name: string, many?: number): MockBatch {
  const row = (n: number, key: string, data: Record<string, unknown>, extra: Partial<MockBatchRow> = {}): MockBatchRow => ({
    id: crypto.randomUUID(), row_no: n, key, action: 'create', decision: 'pending', payload: data, site_index: null, errors: [], ...extra,
    diff: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { old: null, new: v }])),
  });
  const rows: MockBatchRow[] = [
    row(2, 'NEW-001', { site_code: 'NEW-001', region_id: 1, name: 'New site one', name_ar: 'الموقع الجديد الأول', delivery_scenario: 'new_build', scope_tower_erection: 'yes' }),
    row(3, 'NEW-002', { site_code: 'NEW-002', region_id: 5, name: 'New site two', delivery_scenario: 'expansion', cluster_code: 'BN-NEW', overall_status: 'cancelled' },
      { warnings: [{ column: 'Cluster', field: 'cluster_code', code: 'cluster_will_be_created', message: 'This cluster does not exist yet: it is created in the region of the site when L2 approves.' }] }),
    { id: crypto.randomUUID(), row_no: 4, key: siteMeta(10).code, action: 'error', decision: 'pending', payload: {}, site_index: null, diff: {},
      errors: [{ column: 'Site ID', field: 'site_code', code: 'duplicate', message: 'This Site ID exists already. A Site ID is never reused, also when the site is cancelled or voided.' }] },
    { id: crypto.randomUUID(), row_no: 5, key: 'NEW-004', action: 'error', decision: 'pending', payload: {}, site_index: null, diff: {},
      errors: [{ column: 'Region', field: 'region', code: 'unknown_region', message: 'Unknown region. Use a region name, its code or a known alias (Settings, region aliases).' }] },
  ];
  if (many) { // a big file: `many` valid rows (regions in turn, flags yes / no / na), no invalid one
    rows.length = 0;
    const SC = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'], FL = ['yes', 'no', 'na'];
    for (let i = 1; i <= many; i += 1) rows.push(row(i + 1, `BIG-${String(i).padStart(4, '0')}`, { site_code: `BIG-${String(i).padStart(4, '0')}`, region_id: (i % 7) + 1, name: `Big site ${i}`, delivery_scenario: SC[i % SC.length], scope_tower_erection: FL[i % 3] }));
  }
  return { id: crypto.randomUUID(), register_key: null, entity: 'site', template_id: 'TPL-SITE-NEW', file_name, status: 'validated', version: 1, created: Date.now(), uploaded_by: viewer()!.employee_id ?? '9999', uploaded_at: new Date().toISOString(), rows };
}
function toRow(r: MockBatchRow): ImportRow {
  const m = r.site_index !== null ? siteMeta(r.site_index) : null, rec = r.record_id ? R().records.find((x) => x.id === r.record_id) : undefined;
  return {
    id: r.id, sheet: r.sheet ?? 'Data', row_no: r.row_no, key: r.key, site_code: m?.code ?? r.key, record_type: rec?.record_type ?? null, record_id: r.record_id ?? null, action: r.action, diff: r.diff, errors: r.errors,
    decision: decisionOf(r), ...(r.hold_reason ? { hold_reason: r.hold_reason } : {}), note: r.note ?? null, ...(r.site_id ? { site_id: r.site_id } : {}), ...(r.warnings && !r.task_code ? { warnings: r.warnings } : {}),
    ...(r.task_code ? { task_code: r.task_code, task_id: taskIdOf(r.site_index, r.task_code), site_id: m?.id ?? null, warnings: r.warnings ?? [], source_ref: r.source_ref ?? `${r.sheet ?? 'Data'}!${r.row_no}` } : {}),
  };
}
/** A task of the mock site (the same ids the task grid uses, so "Open the task" lands on a task that exists). */
const taskIdOf = (site: number | null, code: string) => `60000000-0000-4000-8000-${String(((site ?? 0) + 1) * 100 + (code.charCodeAt(0) % 20) + 1).padStart(12, '0')}`;

/** A stream batch (contract 0.11.5): one row per touched task of a site. An update that starts a task, one held for a predecessor, an identical task, a gate-locked task and an unknown site. */
function makeStreamBatch(stream: NonNullable<MockBatch['stream']>, template_id: string, file_name: string, group_id?: string): MockBatch {
  const T: Record<string, string[]> = { DESIGN_ACQ: ['A2', 'A5', 'A1', 'A3'], CW: ['B4', 'B5', 'B6', 'B8'], TE: ['D5', 'D6', 'D7', 'D8'], CLOSURE: ['B15', 'D18', 'D17', 'Z1'] };
  const [ok, held, same, locked] = T[stream]!;
  const sheet = group_id ? 'Master' : 'Data', site = 10, code = siteMeta(site).code;
  const ref = (n: number) => `${sheet}!${n}`;
  const rows: MockBatchRow[] = [
    { id: crypto.randomUUID(), row_no: 2, sheet, source_ref: ref(2), task_code: ok, key: `${code} / ${ok}`, action: 'update', decision: 'pending', payload: {}, site_index: site, errors: [],
      diff: { planned_date: { old: null, new: '2026-10-01' }, actual_date: { old: null, new: '2026-10-10' }, ...(stream === 'CW' ? { aat_se_name: { old: null, new: 'Eng Master' } } : {}) },
      warnings: [{ column: `${ok} Actual Date`, field: `${ok}:actual_date`, code: 'sla_late', message: 'The actual date is after the SLA limit (2026-10-05): the task is late.' }] },
    { id: crypto.randomUUID(), row_no: 2, sheet, source_ref: ref(2), task_code: held, key: `${code} / ${held}`, action: 'update', decision: 'pending_previous_approval', hold_reason: 'predecessor_open', payload: {}, site_index: site, errors: [],
      diff: { actual_date: { old: null, new: '2026-10-12' } }, warnings: [{ column: `${held} Actual Date`, code: 'held_predecessor', message: `The row waits until ${ok} is approved.` }] },
    { id: crypto.randomUUID(), row_no: 3, sheet, source_ref: ref(3), task_code: same, key: `${code} / ${same}`, action: 'unchanged', decision: 'pending', payload: {}, site_index: site, errors: [], diff: {},
      warnings: [{ column: `${same} Actual Date`, code: 'calculated_column', message: 'Calculated or register-owned column: the value is not read.' }] },
    { id: crypto.randomUUID(), row_no: 3, sheet, source_ref: ref(3), task_code: locked, key: `${code} / ${locked}`, action: 'error', decision: 'pending', payload: {}, site_index: site, diff: {},
      errors: [{ column: `${locked} Actual Date`, field: `${locked}:actual_date`, code: 'gate_locked', message: 'The task is locked: the gate G3 is not open yet (Q81).' }] },
    { id: crypto.randomUUID(), row_no: 4, sheet, source_ref: ref(4), key: 'XX999', action: 'error', decision: 'pending', payload: {}, site_index: null, diff: {},
      errors: [{ column: 'Site ID', field: 'site_code', code: 'site_not_in_scope', message: 'Unknown site, or a site outside your regions.' }] },
  ];
  return { id: crypto.randomUUID(), register_key: null, stream, template_id, file_name, status: 'validated', version: 1, created: Date.now(), uploaded_by: viewer()!.employee_id ?? '9999', uploaded_at: new Date().toISOString(),
    ...(group_id ? { group_id, part_sheet: 'Master' } : { part_sheet: 'Data' }), rows };
}
function toBatch(b: MockBatch): ImportBatch {
  const n = (a: string) => b.rows.filter((r) => r.action === a).length;
  const valid = b.rows.filter((r) => r.action === 'create' || r.action === 'update'), d = (x: string) => valid.filter((r) => decisionOf(r) === x).length;
  const status = statusOf(b);
  return {
    id: b.id, template_id: b.template_id, template_version: 1, source: b.group_id ? 'master_template' : 'template', file_name: b.file_name, status, current_level: b.status === 'validated' ? 1 : 2, levels_required: 2, register_key: b.register_key, note: b.note ?? null,
    ...(b.stream ? { stream: b.stream } : {}), ...(b.entity ? { entity: b.entity } : {}), ...(b.group_id ? { group_id: b.group_id, part_sheet: b.part_sheet ?? null } : {}),
    counts: { create: n('create'), update: n('update'), unchanged: n('unchanged'), error: n('error'), pending: d('pending'), approved: d('approved'), rejected: d('rejected'), held: d('pending_previous_approval') },
    job_id: null, progress: progressOf(b.run), task_id: null, site_id: null, uploaded_by: { id: uid(b.uploaded_by), display_name: b.uploaded_by }, uploaded_at: b.uploaded_at, version: b.version,
    historical_load: b.historical ? { cutoff_date: b.historical.cutoff_date, reason: b.historical.reason, marked_by: { id: uid(b.uploaded_by), display_name: b.uploaded_by }, marked_at: b.historical.marked_at } : null,
  };
}
