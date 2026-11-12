// MSW handlers for work package P3 (contract 0.12.8): the legacy Master import and its comparison report (/master-import), the template mapping screen
// (/template-mapping) and the import aliases (/import-aliases). They follow the API: the legacy path is for a System Admin (the mock `pm` account), an upload
// without the Master sheet is refused with `not_a_master`, a file with the hidden _tpl sheet with `is_pmis_template`, and an apply needs a reason and a step-up.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { ImportAlias, MasterImportDiff, MasterImportRun, TemplateMappingChange, TemplateTaskField } from '@/api/masterImport';
import { db, stepUpValid, viewer } from './db';
import { guard, page, problem, stepUp } from './handlers';
import { uid } from './ids';
import { isSystemAdmin, waiver, waiverToday, waiverView } from './waiverData';

/** 0.15.5: the background applies of the mock (run id → the run once applied, after two reads). */
const applyLater = new Map<string, { reads: number; run: Partial<MasterImportRun> }>();

const B = API_BASE;

interface State { runs: MasterImportRun[]; diffs: Record<string, MasterImportDiff[]>; fields: TemplateTaskField[]; aliases: { region: ImportAlias[]; role: ImportAlias[] } }
const states = new WeakMap<object, State>();
const now = () => new Date().toISOString();

const seedFields = (): TemplateTaskField[] => [
  { id: 'f-b4-act', task_code: 'B4', field_key: 'actual_date', label: 'CW Survey Actual', field_type: 'date', master_col: 'AO', master_header: 'CW Survey & Analysis Report / Actual Date', read_only: false, is_active: true, scenarios: null, projection: null },
  { id: 'f-b8-act', task_code: 'B8', field_key: 'actual_date', label: 'CW MOS Actual', field_type: 'date', master_col: 'AZ', master_header: 'CW MOS / Actual Date', read_only: false, is_active: true, scenarios: null, projection: null },
  { id: 'f-b9-act', task_code: 'B9', field_key: 'actual_date', label: 'Actual Date', field_type: 'date', master_col: 'AZ', master_header: 'CW MOS / Actual Date', read_only: false, is_active: true, scenarios: null, projection: null },
  { id: 'f-b10-as', task_code: 'B10', field_key: 'actual_start', label: 'Actual Start', field_type: 'date', master_col: 'BL', master_header: 'CW Installation Status / Actual Start Date', read_only: false, is_active: true, scenarios: null, projection: 'earliest' },
  { id: 'f-b7-sub', task_code: 'B7', field_key: 'submitted_date', label: 'CW DN Submitted', field_type: 'date', master_col: 'AT', master_header: 'CW DN / Submitted Date', read_only: true, is_active: true, scenarios: null, projection: null },
];
const alias = (kind: 'region' | 'role', label: string, target: string | null, target_name: string | null, status: 'mapped' | 'ambiguous' | 'unmapped', note: string | null = null): ImportAlias =>
  ({ kind, alias: label.toLowerCase(), label, target, target_name, status, is_active: true, note, updated_at: '2026-11-04T08:00:00Z' });

/** 0.14.6: one chunk of the background sends of an applied run (25 rows). */
function advance(r: MasterImportRun) {
  const p = r.progress!;
  const done = Math.min(p.rows_total, p.rows_done + 25), draft = r.apply_mode === 'draft', t = now();
  Object.assign(p, { rows_done: done, percent: p.rows_total ? Math.floor((100 * done) / p.rows_total) : 100, submitted: draft ? 0 : done, saved: draft ? done : 0, updated_at: t });
  if (done >= p.rows_total) Object.assign(p, { state: 'done', batches_running: 0, finished_at: t });
}

function st(): State {
  const key = db() as unknown as object;
  let s = states.get(key);
  if (!s) {
    const run: MasterImportRun = {
      id: 'run-0001', file_name: 'GSDN_Site_Master.xlsx', file_sha256: 'a1'.repeat(32), file_size: 2718655, status: 'previewed',
      structure: { identified: true, columns_expected: 187, columns_found: 187, missing: [], moved: [], extra: [], register_sheets_missing: ['Contractors', 'Dismantle'], has_tpl: false },
      summary: { rows: 3, sites_matched: 2, sites_unknown: 1, cells_compared: 220, matches: 214, diffs: 3, missing_in_pmis: 1, missing_in_master: 0, exceptions: 2, applicable: 2, staff_mapped: 0, staff_rows: 2 },
      created_by: { id: uid('1001'), display_name: 'Project Manager', employee_id: '1001' }, created_at: '2026-11-04T07:30:00Z', applied_by: null, applied_at: null,
      apply_reason: null, apply_mode: null, group_id: null, outcome: null, has_file: true, version: 1,
    };
    const d = (id: string, o: Partial<MasterImportDiff>): MasterImportDiff => ({ id, sheet: 'Master', row_no: 5, source_ref: 'Master!5', site_code: 'TR-0001', site_id: null, region_id: 1,
      master_col: null, header: null, field: null, master_value: null, pmis_value: null, kind: 'diff', reason: 'value_differs', applicable: false, resolution: 'open',
      resolution_note: null, resolved_by: null, resolved_at: null, ...o });
    s = {
      runs: [run],
      diffs: { [run.id]: [
        d('diff-1', { master_col: 'AO', header: 'CW Survey & Analysis Report / Actual Date', field: 'B4:actual_date', master_value: '2026-02-03', pmis_value: null, applicable: true }),
        d('diff-2', { master_col: 'V', header: 'Milestone / Site Release Date', field: 'calc', master_value: '2026-01-05', pmis_value: '2026-01-02', reason: 'calculated' }),
        d('diff-3', { row_no: 7, source_ref: 'Master!7', site_code: 'XX-9999', master_col: 'B', header: 'Site ID', field: 'site', master_value: 'XX-9999', kind: 'missing_in_pmis', reason: 'site_not_in_pmis', region_id: null }),
        d('diff-4', { sheet: 'Setting', row_no: 3, source_ref: 'Setting!3', site_code: null, region_id: null, master_col: 'J', header: 'Project Staff / Role', field: 'role_aliases', master_value: 'Site Engineer', kind: 'exception', reason: 'role_ambiguous' }),
      ] },
      fields: seedFields(),
      aliases: {
        region: [alias('region', 'Tripoli Area', '1', 'Tripoli', 'mapped'), alias('region', 'Benghazi Area', '5', 'Benghazi', 'mapped')],
        role: [alias('role', 'Team Lead (CW)', null, null, 'unmapped', 'proposal: CW Team Lead (awaiting owner approval, Q8)'), alias('role', 'Site Engineer', null, null, 'ambiguous', 'CW or TE is not known (Q8)')],
      },
    };
    states.set(key, s);
  }
  return s;
}

const isAdmin = () => viewer()?.key === 'pm';
const adminOnly = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Action not allowed', { detail: 'The legacy Master import is for a System Admin or a delegate of templates administer.' }));
const rejected = (reason: string, detail: string) => problem(422, 'template_rejected', 'Not an accepted file', { detail, reason } as never);

export const masterImportHandlers = [
  http.get(`${B}/master-import/runs`, () => adminOnly() ?? page(st().runs)),
  http.post(`${B}/master-import/runs`, async ({ request }) => {
    const g = adminOnly(); if (g) return g;
    const fd = await request.formData();
    const f = fd.get('file');
    if (!f || typeof f === 'string' || f.size === 0) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/file', code: 'required', message: 'Send the Site Master.' }] });
    const name = f.name.toLowerCase();
    if (name.endsWith('.xlsm')) return rejected('macros_not_allowed', 'This is a macro-enabled workbook. Save it as a plain .xlsx.');
    const text = await f.text();
    if (text.includes('_tpl')) return rejected('is_pmis_template', 'This file is a template issued by GSDN Workspace (it has the _tpl sheet): upload it on the Templates page.');
    if (!text.includes('Master')) return rejected('not_a_master', 'This file is not the Site Master: it has no sheet "Master".');
    const base = st().runs[0]!;
    // 0.15.3: a big Master (a test file named with `bigmaster<rows>`) is compared in the background: 202 `staging`, 100 rows more per read
    const big = /bigmaster(\d+)/.exec(text), t0 = now();
    const run: MasterImportRun = { ...base, id: `run-${st().runs.length + 1}`, file_name: f.name, file_sha256: 'b2'.repeat(32), file_size: f.size, status: big ? 'staging' : 'previewed', created_at: t0,
      summary: big ? { ...base.summary, rows: Number(big[1]), sites_matched: Number(big[1]) } : base.summary,
      applied_by: null, applied_at: null, apply_reason: null, apply_mode: null, group_id: null, outcome: null, version: 1,
      staging: big ? { upload_id: uid('upload'), state: 'running', rows_total: Number(big[1]), rows_done: 0, percent: 0, started_at: t0, updated_at: t0, finished_at: null, error: null } : null };
    st().runs = [run, ...st().runs];
    st().diffs[run.id] = (st().diffs[base.id] ?? []).map((x) => ({ ...x, id: `${x.id}-${run.id}`, resolution: 'open' as const, resolution_note: null }));
    return HttpResponse.json(run, { status: big ? 202 : 201, headers: { ETag: `"${run.version}"` } });
  }),
  http.get(`${B}/master-import/runs/:id`, ({ params }) => {
    const g = adminOnly(); if (g) return g;
    const r = st().runs.find((x) => x.id === params.id);
    if (r?.progress?.state === 'running') advance(r);   // 0.14.6: each read moves the background sends by one chunk of 25 rows
    if (r?.status === 'applying' && r.applying) {
      // 0.15.5: the background apply of a big file ends at the second read (all or nothing)
      const later = applyLater.get(r.id);
      if (later && ++later.reads >= 2) {
        const t = now();
        Object.assign(r.applying, { state: 'done', updated_at: t, finished_at: t });
        Object.assign(r, later.run, { version: r.version + 1 });
        applyLater.delete(r.id);
      }
    }
    if (r?.status === 'staging' && r.staging) {
      // 0.15.3: each read compares 100 more rows; the run is previewed with the last ones
      const s = r.staging, done = Math.min(s.rows_total, s.rows_done + 100), t = now();
      Object.assign(s, { rows_done: done, percent: s.rows_total ? Math.floor((100 * done) / s.rows_total) : 100, updated_at: t });
      if (done >= s.rows_total) { Object.assign(s, { state: 'done', percent: 100, finished_at: t }); r.status = 'previewed'; }
    }
    return r ? HttpResponse.json(r, { headers: { ETag: `"${r.version}"` } }) : problem(404, 'not_found', 'Not found');
  }),
  http.get(`${B}/master-import/runs/:id/diffs`, ({ params, request }) => {
    const g = adminOnly(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const items = (st().diffs[String(params.id)] ?? []).filter((d) => (!q.get('kind') || d.kind === q.get('kind')) && (!q.get('resolution') || d.resolution === q.get('resolution'))
      && (!q.get('reason') || d.reason === q.get('reason')) && (!q.get('site_code') || (d.site_code ?? '').toUpperCase() === (q.get('site_code') ?? '').toUpperCase()));
    return page(items);
  }),
  http.get(`${B}/master-import/runs/:id/export`, () => adminOnly()
    ?? new HttpResponse(new Uint8Array([80, 75]), { headers: { 'Content-Disposition': 'attachment; filename="master-comparison_run.xlsx"', 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })),
  http.get(`${B}/master-import/runs/:id/file`, () => adminOnly()
    ?? new HttpResponse(new Uint8Array([80, 75]), { headers: { 'Content-Disposition': 'attachment; filename="GSDN_Site_Master.xlsx"' } })),
  http.post(`${B}/master-import/runs/:id/apply`, async ({ params, request }) => {
    const g = adminOnly(); if (g) return g;
    const r = st().runs.find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found', 'Not found');
    const body = await request.json() as { mode?: string; reason?: string; historical_load?: { reason?: string; approve_directly?: boolean; registers?: boolean }; approve_directly?: unknown; registers?: unknown };
    // 0.15.6: approve_directly exists only inside historical_load (an unknown field elsewhere)
    if (body.registers !== undefined) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '', code: 'unrecognized_keys', message: 'Unrecognized key: registers' }] });   // 0.15.7: only inside historical_load
    if (body.approve_directly !== undefined) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '', code: 'unrecognized_keys', message: 'Unrecognized key: approve_directly' }] });
    if (!body.reason || body.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required', message: 'A reason is required.' }] });
    if (r.status === 'applied') return problem(409, 'invalid_transition', 'Not possible now', { detail: 'This run was already applied.' });
    if (r.status === 'applying') return problem(409, 'upload_processing', 'The file is being checked', { detail: 'This file is being applied in the background. Wait until it ends.', run_id: r.id } as never);
    if (r.status === 'staging') return problem(409, 'upload_processing', 'The file is being checked', { detail: 'The file is still being compared. Wait until the comparison ends.', run_id: r.id } as never);
    if (!stepUpValid()) return stepUp();
    if (body.historical_load) {
      // Q462 (0.14.3): a System Admin, the submit mode, a reason, the waiver open
      if (!isSystemAdmin()) return problem(403, 'action_forbidden', 'Action not allowed', { detail: 'Only a System Admin can accept a batch without documents (historical load).' });
      if (body.mode === 'draft') return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/mode', code: 'invalid', message: 'The historical load is for the submit mode.' }] });
      if ((body.historical_load.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/historical_load/reason', code: 'required', message: 'A reason is required.' }] });
      if (!waiver().open) return problem(409, 'invalid_transition', 'Not possible now', { detail: 'The historical-load waiver is closed: a batch cannot be accepted without documents.' });
    }
    // 0.14.6: a staged batch with more rows than imports.async_rows (50) is sent in the background: 202 with the run's progress
    const rowsToSend = Number((r.summary as Record<string, unknown>).applicable ?? 0), big = rowsToSend > 50, draft = body.mode === 'draft';
    const direct = !!body.historical_load?.approve_directly;   // 0.15.6: the submitted rows are approved at once (admin override, no L2)
    const outcome = { group_id: uid('group'), mode: draft ? 'draft' as const : 'submit' as const, queued: big ? 1 : 0, approve_directly: direct,
      batches: [{ id: uid('batch'), kind: 'stream', sheet: 'Master', ref: 'CW', rows: rowsToSend, template_id: 'TPL-SITE-CW', submitted: big || draft ? 0 : 1, saved: draft && !big ? 1 : 0, held: 0, failed: 0, errors: 0,
        approved: direct && !big && !draft ? 1 : 0,
        ...(big ? { queued: true, job_id: uid('job'), rows: rowsToSend } : {}) }] as Record<string, unknown>[], skipped: [] as Record<string, unknown>[],
      registers: false, register_notes: [] as Record<string, unknown>[] };
    if (body.historical_load?.registers && !draft) {
      // 0.15.7: the register sheets of the same file, one register batch each; the sheets the file lacks are skipped with their reason
      outcome.registers = true;
      outcome.batches.push(
        { id: uid('batch'), kind: 'register', sheet: 'RF & Design', ref: 'rf_design', template_id: 'TPL-RF', rows: 3, submitted: 2, saved: 0, held: 0, failed: 0, errors: 1, skipped: 0, approved: direct ? 2 : 0 },
        { id: uid('batch'), kind: 'register', sheet: 'Acquisition', ref: 'acquisition', template_id: 'TPL-ACQ', rows: 2, submitted: 2, saved: 0, held: 0, failed: 0, errors: 0, skipped: 0, approved: direct ? 2 : 0 });
      for (const [sheet, ref] of [['Permission Log', 'permits_hse'], ['PR-PO', 'procurement'], ['GECOL', 'gecol'], ['HLC', 'hlc'], ['As-Built', 'as_built'], ['Risk Register', 'risks']]) {
        outcome.skipped.push({ sheet, kind: 'register', ref, reason: 'sheet_missing', detail: `The file has no sheet "${sheet}".` });
      }
    }
    const t0 = now();
    // 0.15.5: a file with more sites than imports.async_rows (50) is applied in the background: 202 `applying`, then `applied` with its outcome
    const sites = Number((r.summary as Record<string, unknown>).sites_matched ?? 0);
    if (sites > 50) {
      applyLater.set(r.id, { reads: 0, run: { status: 'applied', applied_at: t0, apply_reason: body.reason ?? null, apply_mode: outcome.mode, group_id: outcome.group_id, outcome,
        applied_by: { id: uid('1001'), display_name: 'Project Manager', employee_id: '1001' }, progress: null } });
      Object.assign(r, { status: 'applying', version: r.version + 1,
        applying: { job_id: uid('apply'), state: 'running', sites_total: sites, started_at: t0, updated_at: t0, finished_at: null, error_code: null, error: null } });
      return HttpResponse.json({ ...r, outcome: null }, { status: 202, headers: { ETag: `"${r.version}"` } });
    }
    Object.assign(r, { status: 'applied', applied_at: t0, apply_reason: body.reason, apply_mode: outcome.mode, group_id: outcome.group_id, outcome, version: r.version + 1,
      applied_by: { id: uid('1001'), display_name: 'Project Manager', employee_id: '1001' },
      progress: big ? { state: 'running', batches: 1, batches_running: 1, rows_total: rowsToSend, rows_done: 0, percent: 0, submitted: 0, saved: 0, approved: 0, held: 0, failed: 0,
        started_at: t0, updated_at: t0, finished_at: null } : null });
    return HttpResponse.json({ ...r, outcome }, { status: big ? 202 : 200, headers: { ETag: `"${r.version}"` } });
  }),
  // Q462 (contract 0.14.3): the one-time historical-load document waiver. Any signed-in user reads it; only a System Admin opens or closes it, with a step-up.
  http.get(`${B}/settings/historical-waiver`, () => { const g = guard(); if (g) return g; return HttpResponse.json(waiverView()); }),
  http.put(`${B}/settings/historical-waiver`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isSystemAdmin()) return problem(403, 'action_forbidden', 'Action not allowed', { detail: 'Only a System Admin can open or close the historical-load waiver.' });
    if (!stepUpValid()) return stepUp();
    const b = await request.json() as { open?: unknown; cutoff_date?: string; reason?: string } & Record<string, unknown>;
    const errs: { path: string; code: string }[] = [];
    for (const k of Object.keys(b)) if (!['open', 'cutoff_date', 'reason'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_field' });
    if (typeof b.open !== 'boolean') errs.push({ path: '/open', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (b.open === true) {
      if (!b.cutoff_date) errs.push({ path: '/cutoff_date', code: 'required' });
      else if (b.cutoff_date > waiverToday()) errs.push({ path: '/cutoff_date', code: 'in_the_future' });
    }
    if (errs.length) return problem(422, 'validation_failed', 'Validation failed', { errors: errs as never });
    const w = waiver();
    if (b.open && w.open) return problem(409, 'invalid_transition', 'Not possible now', { detail: 'The waiver is already open. Close it first to open it again with another cutoff date.' });
    if (!b.open && !w.open) return problem(409, 'invalid_transition', 'Not possible now', { detail: 'The waiver is not open.' });
    if (b.open) Object.assign(w, { open: true, cutoff_date: b.cutoff_date!, opened_at: now(), expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), reason: b.reason!.trim(), opened_by: uid(viewer()?.employee_id ?? '1001'), closed_at: null, closed_how: null });
    else Object.assign(w, { open: false, cutoff_date: null, closed_at: now(), closed_how: 'manual' });
    return HttpResponse.json(waiverView());
  }),
  http.patch(`${B}/master-import/diffs/:id`, async ({ params, request }) => {
    const g = adminOnly(); if (g) return g;
    const body = await request.json() as { resolution: MasterImportDiff['resolution']; note?: string };
    const d = Object.values(st().diffs).flat().find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'Not found');
    if (body.resolution !== 'open' && (body.note ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/note', code: 'required', message: 'Say why (a note).' }] });
    Object.assign(d, { resolution: body.resolution, resolution_note: body.note ?? null, resolved_at: now(), resolved_by: { id: uid('1001'), display_name: 'Project Manager', employee_id: '1001' } });
    return HttpResponse.json(d);
  }),

  http.get(`${B}/template-mapping`, () => guard() ?? HttpResponse.json({
    fields: st().fields, can_edit: isAdmin(),
    master_columns: [{ letter: 'AO', header: 'CW Survey & Analysis Report / Actual Date', owner: 'task', fields: 1 }, { letter: 'V', header: 'Milestone / Site Release Date', owner: 'calc', fields: 1 }],
    tasks: [{ code: 'B4', name_en: 'CW survey', name_ar: null, stream: 'CW', mode: 'edit' }, { code: 'B7', name_en: 'Layout approval and CW DN', name_ar: null, stream: 'CW', mode: 'edit' }],
  })),
  http.post(`${B}/template-mapping`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Action not allowed');
    const body = await request.json() as { changes: TemplateMappingChange[]; reason: string; dry_run?: boolean };
    if (!body.reason || body.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required', message: 'A reason is required.' }] });
    const errs = body.changes.flatMap((c, i) => (c.op === 'upsert' && c.read_only === false && !/^(planned_date|actual_start|actual_date|v:)/.test(c.field_key)
      ? [{ path: `/changes/${i}/read_only`, code: 'calculated_field', message: 'This field is set by the workflow, calculated or owned by a register: it stays read only (Q207).' }] : []));
    if (errs.length) return problem(422, 'validation_failed', 'Validation failed', { errors: errs });
    const impact = [{ template_id: 'TPL-SITE-CW', kind: 'stream', version_before: 2, version_after: 3, columns_added: body.changes.filter((c) => c.op === 'upsert').map((c) => `${c.task_code} ${c.label ?? ''}`.trim()), columns_removed: [], columns_changed: [], open_batches: 1 }];
    if (!body.dry_run) {
      for (const c of body.changes) {
        const f = st().fields.find((x) => x.task_code === c.task_code && x.field_key === c.field_key);
        if (c.op === 'deactivate') { if (f) f.is_active = false; continue; }
        const v: TemplateTaskField = { id: f?.id ?? uid(`${c.task_code}${c.field_key}`), task_code: c.task_code, field_key: c.field_key, label: c.label ?? c.field_key, field_type: c.field_type ?? 'text',
          master_col: c.master_col ?? null, master_header: null, read_only: c.read_only ?? false, is_active: true, scenarios: c.scenarios ?? null, projection: c.projection ?? null };
        if (f) Object.assign(f, v); else st().fields.push(v);
      }
    }
    return HttpResponse.json({ dry_run: !!body.dry_run, changes: body.changes.length, impact });
  }),

  http.get(`${B}/import-aliases`, ({ request }) => {
    const g = guard(); if (g) return g;
    const kind = new URL(request.url).searchParams.get('kind') === 'role' ? 'role' : 'region';
    return HttpResponse.json({ items: st().aliases[kind], can_edit: isAdmin() });
  }),
  http.put(`${B}/import-aliases`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Action not allowed');
    const b = await request.json() as { kind: 'region' | 'role'; alias: string; label?: string; target?: string | null; status?: 'ambiguous' | 'unmapped'; reason: string };
    if (!b.reason || b.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required', message: 'A reason is required.' }] });
    const list = st().aliases[b.kind];
    const key = b.alias.trim().toLowerCase();
    const a: ImportAlias = alias(b.kind, b.label ?? b.alias, b.target ?? null, b.target ?? null, b.target ? 'mapped' : b.status ?? 'unmapped');
    a.alias = key;
    const i = list.findIndex((x) => x.alias === key);
    if (i >= 0) list[i] = a; else list.push(a);
    return HttpResponse.json(a);
  }),
];
