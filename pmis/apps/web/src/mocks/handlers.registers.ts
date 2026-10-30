// MSW handlers for the generic register endpoints and template import, following contracts/openapi.yaml (/registers, /import-batches).
// Claim, release and history of a record are NOT in the contract yet: they are mock-only (TODO(contract), see api/registers.ts).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { BallInCourt, ImportBatch, ImportRow, RegisterDefinition, RegisterRecord, WorkflowStep } from '@/api/types';
import { DATE_MAX, DATE_MIN, hasExpiry, validateRecord, visibleData } from '@/lib/registerForms';
import { db, save, stepUpValid, viewer, accountStatus } from './db';
import { guard, page, problem, stepUp } from './handlers';
import { uid } from './ids';
import { holdersOf, rowOf } from './matrixData';
import { REGISTER_DEFS, REGISTER_TEMPLATES, recId, type MockBatch, type MockRecord } from './registersData';
import { SITE_COUNT, siteIdOf, siteIndex, siteMeta, TODAY } from './sites';

const B = API_BASE;
const R = () => db().reg;
const defOf = (key: string): RegisterDefinition | undefined => REGISTER_DEFS.find((d) => d.register_key === key);
const levelsOf = (key: string) => rowOf(db().matrix, key)?.approval_levels ?? 3;
const tag = (r: MockRecord) => HttpResponse.json(toRecord(r), { headers: { ETag: `"${r.version}"` } });
const ref = () => { const v = viewer()!; return { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined }; };
const userHolds = (key: string, level: number, emp?: string | null) => holdersOf(db().matrix, key, level).some((a) => a.kind === 'user' && a.employee_id === emp);
/** The admin account acts at every level (as in the task mock); anyone else only where the matrix row names them. */
const canAt = (key: string, level: number) => { const v = viewer(); return !!v && (v.key === 'pm' || userHolds(key, level, v.employee_id)); };

function ball(r: MockRecord): BallInCourt {
  const L = r.levels_required ?? levelsOf(r.register_key), level = r.state === 'entry' ? 1 : r.current_level;
  const holders = holdersOf(db().matrix, r.register_key, level).map((h) => (h.employee_id ? { ...h, account_status: accountStatus(h.employee_id) } : h));
  return { level, level_kind: level === 1 ? 'entry' : level >= L ? 'approve' : 'review', holders, rule: 'any_one', ...(r.claimed_by ? { claimed_by: r.claimed_by } : {}) };
}

function actions(r: MockRecord): RegisterRecord['allowed_actions'] {
  const out: NonNullable<RegisterRecord['allowed_actions']> = [];
  const L = r.levels_required ?? levelsOf(r.register_key);
  if (r.state === 'entry' && canAt(r.register_key, 1)) out.push('edit', 'submit');
  if (r.state === 'in_review' && canAt(r.register_key, r.current_level)) out.push('review', 'reject');
  if (r.state === 'in_approval' && canAt(r.register_key, L)) out.push('approve', 'reject');
  if (r.state !== 'voided' && viewer()?.key === 'pm') out.push('void');
  return out;
}

export function toRecord(r: MockRecord): RegisterRecord {
  const m = r.site_index !== null ? siteMeta(r.site_index) : null;
  return {
    id: r.id, register_key: r.register_key, record_type: r.record_type, site_id: m?.id ?? null, site_code: m?.code ?? null, region_id: (m?.region_id ?? null) as never, state: r.state,
    current_level: r.state === 'entry' ? 1 : r.current_level, levels_required: r.levels_required ?? levelsOf(r.register_key), ball_in_court: ball(r), data: r.data, return_count: r.return_count, last_return_note: r.last_return_note,
    allowed_actions: actions(r), created_by: { id: uid(r.created_by), display_name: r.created_by }, created_at: r.created_at, updated_at: r.updated_at, version: r.version,
  };
}

const noMatch = (req: Request, r: MockRecord) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === r.version ? null : problem(412, 'precondition_failed', 'The record changed; reload and retry');
};
const step = (r: MockRecord, action: WorkflowStep['action'], level: number, note?: string, self = false) => {
  r.steps.push({ id: crypto.randomUUID(), level, action, acted_by: ref(), note: note ?? null, created_at: new Date().toISOString(), self_approval: self } as WorkflowStep);
};
const touch = (r: MockRecord) => { r.version += 1; r.updated_at = new Date().toISOString(); };

/** Field problems as the server answers them (`errors[].path` = `/data/<code>`), plus the checks only the server can make (V1, duplicate). */
function check(def: RegisterDefinition, data: Record<string, unknown>, site: number | null) {
  const issues = validateRecord(def, data, site === null ? null : siteIdOf(site), TODAY);
  return Object.entries(issues).map(([code, i]) => ({ path: code === 'site_id' ? '/site_id' : `/data/${code}`, code: i.code }));
}
const invalid = (errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });

export const registerHandlers = [
  http.get(`${B}/registers`, () => {
    const g = guard(); if (g) return g;
    const nav = viewer()!.nav;
    return HttpResponse.json({ items: REGISTER_DEFS.filter((d) => nav.includes(d.module_key)).map((d) => ({ ...d, approval_levels: levelsOf(d.register_key), record_count: R().records.filter((r) => r.register_key === d.register_key).length })) });
  }),

  http.get(`${B}/registers/:key/records`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const def = defOf(params.key as string);
    if (!def || !viewer()!.nav.includes(def.module_key)) return problem(404, 'not_found', 'Register not found');
    const u = new URL(request.url).searchParams;
    const q = (u.get('q') ?? '').toLowerCase(), region = u.get('region_id'), state = u.get('state'), type = u.get('record_type'), site = u.get('site_id');
    const limit = Math.min(Number(u.get('limit') ?? 50), 200), start = Number(u.get('cursor') ?? 0);
    const all = R().records.filter((r) => r.register_key === def.register_key).map(toRecord).filter((r) =>
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
    if (!viewer() || !(viewer()!.key === 'pm' || userHolds(def.register_key, 1, viewer()!.employee_id))) return problem(403, 'forbidden', 'Not allowed');
    if (!def.multiple_per_site && R().records.some((r) => r.register_key === def.register_key && r.site_index === si && r.state !== 'voided'))
      return problem(409, 'duplicate', 'This site already has a row; a new request is a new version of it (Q55)');
    const data = visibleData(def, b.data ?? {});
    const bad = Object.entries(data).filter(([c, v]) => def.fields.find((f) => f.code === c)?.type === 'date' && typeof v === 'string' && (v < DATE_MIN || v > DATE_MAX));
    if (bad.length) return invalid(bad.map(([c]) => ({ path: `/data/${c}`, code: 'date_range' })));
    const now = new Date().toISOString();
    const r: MockRecord = { id: recId(++R().seq), register_key: def.register_key, record_type: b.record_type ?? null, site_index: si, state: 'entry', current_level: 1, levels_required: levelsOf(def.register_key), data, version: 1, return_count: 0, last_return_note: null, created_by: viewer()!.employee_id ?? '9999', created_at: now, updated_at: now, steps: [] };
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
    r.data = visibleData(def, { ...r.data, ...(b.data ?? {}) });
    if (b.data && !hasExpiry(r.data)) delete r.data.valid_to;
    touch(r); save();
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
      const holdsAll = Array.from({ length: L }, (_, i) => userHolds(key, i + 1, v.employee_id)).every(Boolean);
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
        while (next <= L && userHolds(key, next, v.employee_id)) next += 1;
        const skipped = Array.from({ length: next - 2 }, (_, i) => i + 2);
        if (next > L) { const e = finish(true); if (e) return e; } // the submitter holds every level they would reach: a self-approval (B5)
        else { r.state = next === L && L >= 3 ? 'in_approval' : 'in_review'; r.current_level = next; }
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
        if (r.state === 'in_approval') { r.state = 'in_review'; r.current_level = 2; } else { r.state = 'entry'; r.current_level = 1; }
      }
      r.claimed_by = undefined; touch(r); save();
      return tag(r);
    })),
  // TODO(contract): not in openapi.yaml.
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
  http.get(`${B}/registers/:key/records/:id/history`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === params.key);
    return r ? page(r.steps) : problem(404, 'not_found', 'Record not found');
  }),

  // ---- template import for registers; a call with `task_id` or another template falls through to the task upload mock
  http.post(`${B}/import-batches`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const fd = await request.formData();
    const tpl = String(fd.get('template_id') ?? ''), f = fd.get('file');
    const key = REGISTER_TEMPLATES[tpl];
    if (!key || fd.get('task_id')) { // per-task upload (task grid): same answer as before
      if (!f || typeof f === 'string' || f.size === 0) return problem(422, 'template_rejected', 'Not an approved template', { reason: 'tpl_missing' } as never);
      return HttpResponse.json({ id: crypto.randomUUID(), template_id: tpl || 'TPL-SITE', template_version: 1, status: 'parsing', counts: {}, version: 1, file_name: f.name }, { status: 202 });
    }
    if (!f || typeof f === 'string' || f.size === 0) return problem(422, 'template_rejected', 'Not an approved template', { reason: 'tpl_missing' } as never);
    if ((await f.text()).includes('retired')) return problem(422, 'template_rejected', 'This template version is retired', { reason: 'outdated_version' } as never);
    const b = makeBatch(key, tpl, f.name);
    R().batches.unshift(b); save();
    return HttpResponse.json(toBatch(b), { status: 202 });
  }),
  http.get(`${B}/import-batches/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    if (b.status === 'parsing' && Date.now() - b.created > 400) { b.status = 'validated'; b.version += 1; save(); }
    return HttpResponse.json(toBatch(b), { headers: { ETag: `"${b.version}"` } });
  }),
  http.get(`${B}/import-batches/:id/rows`, ({ params }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    return b ? page(b.rows.map(toRow)) : problem(404, 'not_found', 'Batch not found');
  }),
  http.post(`${B}/import-batches/:id/submit`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (Number(h.replace(/"/g, '')) !== b.version) return problem(412, 'precondition_failed', 'The batch changed; reload');
    if (b.status !== 'validated') return problem(409, 'invalid_transition', 'The batch is not waiting to be sent');
    if (!b.rows.some((r) => r.action !== 'error')) return problem(422, 'validation_failed', 'No valid rows', { errors: [{ path: '/rows', code: 'no_valid_rows' }] });
    b.status = 'in_review'; b.current_level = 2; b.version += 1; save();
    return HttpResponse.json(toBatch(b), { headers: { ETag: `"${b.version}"` } });
  }),
  http.post(`${B}/import-batches/:id/decisions`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = R().batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Batch not found');
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (Number(h.replace(/"/g, '')) !== b.version) return problem(412, 'precondition_failed', 'The batch changed; reload');
    const body = (await request.json()) as { action: 'review' | 'approve' | 'reject'; scope: 'all' | 'rows'; rows?: { row_id: string; decision: 'approved' | 'rejected' }[]; note?: string };
    const reviewing = b.status === 'in_review', approving = b.status === 'in_approval';
    if (!reviewing && !approving) return problem(409, 'invalid_transition', 'The batch is not in review');
    if (!canAt(b.register_key, b.current_level)) return problem(403, 'not_eligible_holder', 'You do not hold this level');
    const valid = b.rows.filter((r) => r.action !== 'error');
    if (body.action === 'reject') {
      if (!body.note?.trim()) return problem(422, 'note_required', 'A rejection needs a note', { errors: [{ path: '/note', code: 'required' }] });
      valid.forEach((r) => { if (r.decision !== 'approved' || approving) r.decision = 'rejected'; });
      b.status = 'rejected'; b.version += 1; save();
      return HttpResponse.json(toBatch(b), { headers: { ETag: `"${b.version}"` } });
    }
    if ((body.action === 'review') !== reviewing) return problem(409, 'invalid_transition', 'Wrong action for this level');
    const pending = valid.filter((r) => r.decision === 'pending');
    if (body.scope === 'all') pending.forEach((r) => { r.decision = 'approved'; });
    else for (const x of body.rows ?? []) { const r = pending.find((p) => p.id === x.row_id); if (!r) return problem(422, 'validation_failed', 'Unknown or decided row', { errors: [{ path: `/rows/${x.row_id}`, code: 'invalid_row' }] }); r.decision = x.decision; }
    if (!valid.some((r) => r.decision === 'pending')) {
      const okRows = valid.filter((r) => r.decision === 'approved');
      const last = b.levels_required <= 2 || approving;
      if (!okRows.length) b.status = 'rejected';
      else if (!last) { b.status = 'in_approval'; b.current_level = b.levels_required; okRows.forEach((r) => { r.decision = 'pending'; }); }
      else {
        if (!stepUpValid() && b.levels_required > 0 && Array.from({ length: b.levels_required }, (_, i) => userHolds(b.register_key, i + 1, viewer()!.employee_id)).every(Boolean)) return stepUp();
        applyBatch(b, okRows); b.status = 'applied';
      }
    }
    b.version += 1; save();
    return HttpResponse.json(toBatch(b), { headers: { ETag: `"${b.version}"` } });
  }),
];

// ---- batch helpers
function makeBatch(key: MockRecord['register_key'], template_id: string, file_name: string): MockBatch {
  const L = levelsOf(key), def = defOf(key)!;
  const sample = (i: number): Record<string, unknown> => key === 'procurement' ? { scope: 'cw', delivery: 'outsourced', pr_no: `PR-2026-1${i}`, pr_date: '2026-09-1' + i, order_status: 'open' }
    : key === 'gecol' ? { survey_date: `2026-09-0${i + 1}`, meter_no: `M-9${i}00` } : key === 'hlc' ? { request_no: `HLC-2026-1${i}`, request_date: '2026-09-1' + i, fiber_status: 'planned' }
      : { type: 'access_cw', status: 'approved', valid_from: `2026-09-0${i + 1}`, has_expiry: true, valid_to: '2027-01-01' };
  const taken = new Set(R().records.filter((r) => r.register_key === key && !def.multiple_per_site).map((r) => r.site_index));
  const sites = [10, 11, 12, 13].map((s) => { let x = s; while (taken.has(x)) x += 7; return x; });
  const rows: MockBatch['rows'] = sites.slice(0, 3).map((s, i) => ({ id: crypto.randomUUID(), row_no: i + 2, key: siteMeta(s).code, action: 'create' as const, decision: 'pending' as const, payload: sample(i + 1), site_index: s, errors: [], diff: Object.fromEntries(Object.entries(sample(i + 1)).slice(0, 3).map(([k, v]) => [k, { new: v }])) }));
  rows.push({ id: crypto.randomUUID(), row_no: 5, key: siteMeta(sites[3]).code, action: 'unchanged', decision: 'pending', payload: sample(4), site_index: sites[3], errors: [], diff: {} });
  rows.push({ id: crypto.randomUUID(), row_no: 6, key: 'XX999', action: 'error', decision: 'pending', payload: {}, site_index: null, errors: [{ column: 'Site ID', code: 'unknown_site', message: 'Site not in the Site Register' }], diff: {} });
  rows.push({ id: crypto.randomUUID(), row_no: 7, key: siteMeta(14).code, action: 'error', decision: 'pending', payload: {}, site_index: 14, errors: [{ column: def.fields.find((f) => f.type === 'date')?.label_en ?? 'Date', code: 'date_range' }], diff: {} });
  return { id: crypto.randomUUID(), register_key: key, template_id, file_name, status: 'parsing', current_level: 1, levels_required: L, version: 1, created: Date.now(), uploaded_by: viewer()!.employee_id ?? '9999', uploaded_at: new Date().toISOString(), rows };
}
function applyBatch(b: MockBatch, rows: MockBatch['rows']) {
  const now = new Date().toISOString();
  for (const x of rows) {
    if (x.action !== 'create') continue;
    R().records.unshift({ id: recId(++R().seq), register_key: b.register_key, record_type: b.register_key === 'procurement' ? 'pr' : null, site_index: x.site_index, state: 'approved', current_level: b.levels_required, levels_required: b.levels_required, data: x.payload, version: 1, return_count: 0, last_return_note: null, created_by: b.uploaded_by, created_at: now, updated_at: now, steps: [{ id: crypto.randomUUID(), level: 1, action: 'submit', acted_by: ref(), note: `via batch ${b.id.slice(0, 8)}`, created_at: now } as WorkflowStep] });
  }
}
function toRow(r: MockBatch['rows'][number]): ImportRow {
  return { id: r.id, sheet: 'Data', row_no: r.row_no, key: r.key, action: r.action, diff: r.diff, errors: r.errors, decision: r.decision };
}
function toBatch(b: MockBatch): ImportBatch {
  const valid = b.rows.filter((r) => r.action !== 'error'), n = (a: string) => b.rows.filter((r) => r.action === a).length, d = (x: string) => valid.filter((r) => r.decision === x).length;
  const ready = b.status !== 'parsing';
  return {
    id: b.id, template_id: b.template_id, template_version: 1, source: 'template', file_name: b.file_name, status: b.status as ImportBatch['status'], current_level: b.current_level, levels_required: b.levels_required,
    counts: ready ? { create: n('create'), update: n('update'), unchanged: n('unchanged'), error: n('error'), pending: d('pending'), approved: d('approved'), rejected: d('rejected') } : {},
    job_id: ready ? null : `job-${b.id.slice(0, 8)}`, task_id: null, site_id: null, uploaded_by: { id: uid(b.uploaded_by), display_name: b.uploaded_by }, uploaded_at: b.uploaded_at, version: b.version,
  };
}
