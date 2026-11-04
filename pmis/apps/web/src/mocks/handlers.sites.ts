import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Matrix, MatrixPatch, SiteTasks, TaskRegisterField } from '@/api/types';
import { levelKind, usedLevels } from '@/lib/matrixLevels';
import { canAct, canEditTask, db, save, slotsOf, STAFF, stepUpValid, toDetail, viewer, skipPath, type MockTask } from './db';
import { find, guard, ifMatch, page, problem, recordStep, stepUp } from './handlers';
import { uid } from './ids';
import { resolveMentions } from './handlers.x';
import { rejectReason } from './handlers.documents';
import { qcSiteDetail } from './handlers.qc';
import { accountStatus } from './db';
import { GROUPS, recomputeSkip, ROLES, rowOf } from './matrixData';
import { REGISTER_DEFS, TEMPLATE_OF_REGISTER } from './registersData';
import { detail, gridOf, listItem, scopedTasks, siteIndex, SITE_COUNT, siteMeta, STREAMS, TODAY, VIEWS } from './sites';

const B = API_BASE;
const REGIONS = [['Tripoli', 'طرابلس'], ['Middle', 'الوسطى'], ['WM', 'الجبل الغربي'], ['Zawia', 'الزاوية'], ['Benghazi', 'بنغازي'], ['GM', 'الجبل الأخضر'], ['Sebha', 'سبها']];
const TEMPLATES = [['TPL-SITE', 'Site tasks (dates and statuses)', 'مهام الموقع (التواريخ والحالات)']];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown) => s === null || (typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s)));
const tagged = (t: MockTask) => HttpResponse.json(toDetail(t), { headers: { ETag: `"${t.version}"` } });
const invalid = (path: string, code: string, title = 'Validation failed') => problem(422, code === 'invalid_date' ? 'validation_failed' : code, title, { errors: [{ path, code }] });

/** Register-owned fields on three mock tasks (contract 0.4.9), read live from the register records so edit_via follows the record state. */
const REG_FIELDS: Record<string, { key: string; type: string | null; code: string; en: string; ar: string; kind: 'text' | 'date' }> = {
  B1: { key: 'procurement', type: 'pr', code: 'pr_no', en: 'PR number', ar: 'رقم طلب الشراء', kind: 'text' },
  B2: { key: 'procurement', type: 'wo', code: 'po_wo_no', en: 'PO / WO number', ar: 'رقم أمر الشراء', kind: 'text' },
  C4: { key: 'hlc', type: null, code: 'fiber_status', en: 'Fiber status', ar: 'حالة الألياف', kind: 'text' },
  C2: { key: 'gecol', type: null, code: 'power_on_date', en: 'Power-on date', ar: 'تاريخ التشغيل', kind: 'date' },
};
function withRegisterFields(grid: SiteTasks, site: number): SiteTasks {
  const recs = db().reg.records;
  const fieldOf = (code: string, siteId: string): TaskRegisterField[] => {
    const d = REG_FIELDS[code]; if (!d) return [];
    const r = recs.filter((x) => x.register_key === d.key && x.site_index === site && x.record_type === d.type && x.state !== 'voided').sort((a, b) => b.version_no - a.version_no)[0];
    const via = !r ? 'create' : r.state === 'entry' ? 'patch' : r.state === 'approved' ? 'new_version' : 'none';
    return [{ code: d.code, label_en: d.en, label_ar: d.ar, type: d.kind, value: r?.data[d.code] ?? null, editable: via !== 'none', edit_via: via,
      source: { register_key: d.key, record_type: d.type, site_id: siteId, record_id: r?.id ?? null, entity_id: r?.entity_id ?? null, record_state: r?.state ?? null, record_version: r?.version ?? null, field: `data.${d.code}` } }];
  };
  return { ...grid, stages: grid.stages.map((st) => ({ ...st, tasks: st.tasks.map((t) => ({ ...t, register_fields: fieldOf(t.task_code, t.site_id) })) })) };
}

export const siteHandlers = [
  http.get(`${B}/regions`, () => (viewer() ? HttpResponse.json({ items: REGIONS.map(([en, ar], i) => ({ id: i + 1, code: en, name_en: en, name_ar: ar, visible: true })) }) : problem(401, 'unauthenticated', 'Sign in required'))),

  http.get(`${B}/sites`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const q = (u.get('q') ?? '').toLowerCase(), regions = u.getAll('region_id').map(Number), limit = Math.min(Number(u.get('limit') ?? 50), 200), start = Number(u.get('cursor') ?? 0);
    const sc = u.get('scenario'), st = u.get('overall_status'), stage = u.get('stage_code'), stream = u.get('stream');
    if (stream && !STREAMS.some((x) => x.code === stream)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/stream', code: 'unknown_stream' }] });
    const view = u.get('view'), bucket = u.get('bucket');
    if (view && !VIEWS.some((x) => x.code === view)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/view', code: 'unknown_view' }] });
    const all = Array.from({ length: SITE_COUNT }, (_, i) => siteMeta(i)).filter((m) =>
      (!q || `${m.code} ${m.name}`.toLowerCase().includes(q)) && (!regions.length || regions.includes(m.region_id)) && (!sc || m.scenario === sc) && (!st || m.status === st));
    // with a stream: rail and counts cover that stream only, and sites where it does not apply are left out (contract 0.4.1)
    const items = all.map((m) => listItem(m.i, stream ?? undefined, view ?? undefined))
      .filter((x) => !view || scopedTasks(siteIndex(x.id), stream ?? undefined, view).some((t) => t.state !== 'na')) // sites with no task in the view are left out
      .filter((x) => bucket !== 'late' || (x.late_task_count ?? 0) > 0)
      .filter((x) => !stream || x.streams?.find((s) => s.code === stream)?.state !== 'na')
      .filter((x) => !stage || (stream ? x.rail.find((r) => r.state === 'current' || r.state === 'late')?.code === stage : x.current_milestone === stage));
    const slice = items.slice(start, start + limit), next = start + limit < items.length ? String(start + limit) : null;
    return HttpResponse.json({ items: slice, page: { limit, next_cursor: next, total: items.length } });
  }),
  http.get(`${B}/sites/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    if (i < 0 || i >= SITE_COUNT) return problem(404, 'not_found', 'Site not found');
    const d = qcSiteDetail(detail(i));
    return HttpResponse.json(d, { headers: { ETag: `"${d.version}"` } });
  }),
  http.get(`${B}/sites/:id/tasks`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    const stream = new URL(request.url).searchParams.get('stream'), view = new URL(request.url).searchParams.get('view');
    if (view && !VIEWS.some((x) => x.code === view)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/view', code: 'unknown_view' }] });
    if (stream && !STREAMS.some((x) => x.code === stream)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/stream', code: 'unknown_stream' }] });
    return i >= 0 && i < SITE_COUNT ? HttpResponse.json(withRegisterFields(gridOf(i, stream ?? undefined, view ?? undefined), i)) : problem(404, 'not_found', 'Site not found');
  }),

  http.patch(`${B}/tasks/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    const bad = ifMatch(request, t); if (bad) return bad;
    if ((t.state !== 'entry' && t.state !== 'open') || !canEditTask(t)) return problem(403, 'forbidden', 'You cannot edit this task');
    const body = (await request.json()) as Record<string, unknown>;
    for (const k of ['planned_date', 'actual_start', 'actual_date'] as const) if (k in body && !validDate(body[k])) return invalid(`/${k}`, 'invalid_date');
    // contract 0.12.0 (Q13): the Layout Submitted Date of B6, a typed date that is never in the future
    const lsd = (body.values as Record<string, unknown> | undefined)?.layout_submitted_date;
    if (lsd !== undefined && lsd !== null && (!validDate(lsd) || (lsd as string) > TODAY)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/values/layout_submitted_date', code: validDate(lsd) ? 'future_date' : 'invalid_date' }] });
    if (body.values && typeof body.values === 'object') (t as MockTask & { values?: Record<string, unknown> }).values = { ...((t as MockTask & { values?: Record<string, unknown> }).values ?? {}), ...(body.values as Record<string, unknown>) };
    if ('planned_date' in body) t.planned_date = body.planned_date as string | null;
    if ('actual_start' in body) t.actual_start = body.actual_start as string | null;
    if ('actual_date' in body) t.actual_date = body.actual_date as string | null;
    t.version += 1;
    save();
    return tagged(t);
  }),
  http.post(`${B}/tasks/:id/submit`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    const bad = ifMatch(request, t); if (bad) return bad;
    if (t.state !== 'entry' || !canEditTask(t)) return problem(409, 'invalid_transition', 'Task cannot be submitted');
    if (!t.actual_date) return problem(422, 'mandatory_fields_missing', 'Mandatory fields are missing', { missing: ['actual_date'] } as never);
    const miss = slotsOf(t).filter((s) => s.mandatory && (s.status === 'missing' || s.status === 'rejected'));
    if (miss.length) return problem(422, 'mandatory_slots_missing', 'Mandatory documents are missing', { errors: miss.map((s) => ({ path: `/slots/${s.id}`, code: 'missing' })) });
    const v = viewer()!, sp = skipPath(t, v.employee_id);
    if (sp.final && !stepUpValid()) return stepUp();
    const { note } = (await request.json().catch(() => ({}))) as { note?: string };
    const L = t.levels_required ?? 3;
    t.submitted_by = v.employee_id ?? t.submitted_by;
    t.waiting_since = new Date().toISOString();
    if (sp.final) { t.state = 'approved'; t.current_level = L; t.actual_date ??= TODAY; t.slots = slotsOf(t).map((s) => ({ ...s, status: 'approved' })); }
    else { t.current_level = sp.to!; t.level_kind = sp.to === L ? 'approve' : 'review'; t.state = sp.to === L ? 'in_approval' : 'in_review'; t.slots = slotsOf(t).map((s) => ({ ...s, status: 'in_review' })); }
    t.version += 1;
    recordStep(t, 'submit', note, sp.skipped);
    save();
    return HttpResponse.json({ task: toDetail(t), step_ids: [], skipped_levels: sp.skipped }, { headers: { ETag: `"${t.version}"` } });
  }),
  // open -> entry (the holder starts the work); claim / release: a group level is taken by one holder at a time
  http.post(`${B}/tasks/:id/start`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    const bad = ifMatch(request, t); if (bad) return bad;
    if (t.state !== 'open') return problem(409, 'invalid_transition', 'The task is not open');
    if (!canEditTask(t)) return problem(403, 'not_eligible_holder', 'You do not hold this level');
    const { actual_start } = (await request.json().catch(() => ({}))) as { actual_start?: string };
    t.state = 'entry'; t.version += 1;
    t.actual_start = actual_start ?? TODAY;
    save();
    return HttpResponse.json({ task: toDetail(t), step_ids: [], skipped_levels: [], unlocked_task_ids: [] }, { headers: { ETag: `"${t.version}"` } });
  }),
  ...(['claim', 'release'] as const).map((op) =>
    http.post(`${B}/tasks/:id/${op}`, ({ params, request }) => {
      const g = guard(); if (g) return g;
      const t = find(params.id as string), v = viewer()!;
      if (!t) return problem(404, 'not_found', 'Task not found');
      const bad = ifMatch(request, t); if (bad) return bad;
      if (!canAct(t.level_kind) || (t.state !== 'in_review' && t.state !== 'in_approval')) return problem(403, 'not_eligible_holder', 'You do not hold this level');
      const me = { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined };
      if (op === 'claim') {
        if (t.claimed_by && t.claimed_by.id !== me.id) return problem(409, 'already_claimed', 'Another holder has claimed this level', { claimed_by: t.claimed_by } as never);
        t.claimed_by = me;
      } else if (t.claimed_by?.id === me.id) t.claimed_by = undefined;
      else return problem(409, 'invalid_transition', 'You have not claimed this level');
      t.version += 1;
      save();
      return HttpResponse.json({ task: toDetail(t), step_ids: [], skipped_levels: [], unlocked_task_ids: [] }, { headers: { ETag: `"${t.version}"` } });
    })),
  http.get(`${B}/tasks/:id/history`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    return t ? page(t.steps ?? []) : problem(404, 'not_found', 'Task not found');
  }),
  http.get(`${B}/tasks/:id/comments`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    return t ? page(t.comments ?? []) : problem(404, 'not_found', 'Task not found');
  }),
  http.post(`${B}/tasks/:id/comments`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string), v = viewer()!;
    if (!t) return problem(404, 'not_found', 'Task not found');
    const { body, mention_user_ids } = (await request.json()) as { body?: string; mention_user_ids?: string[] };
    if (!body?.trim()) return invalid('/body', 'required');
    const c = { id: crypto.randomUUID(), author: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined }, body: body.trim(), mentions: resolveMentions(body, mention_user_ids), created_at: new Date().toISOString() };
    t.comments = [...(t.comments ?? []), c];
    save();
    return HttpResponse.json(c, { status: 201 });
  }),
  http.post(`${B}/tasks/:id/slots/:slot/files`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string), v = viewer()!;
    const slot = t && slotsOf(t).find((s) => s.id === params.slot);
    if (!t || !slot) return problem(404, 'not_found', 'Slot not found');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return invalid('/file', 'required'); // duck-typed: jsdom and undici have different File classes
    if (!slot.can_upload && !(canEditTask(t) && ['missing', 'uploaded', 'rejected'].includes(slot.status))) return problem(409, 'invalid_transition', 'This slot takes no new file');
    const limit = (slot.max_size_mb ?? 20) * 1024 * 1024;
    if (file.size > limit) return problem(413, 'file_too_large', 'File is too large', { max_size_mb: slot.max_size_mb ?? 20 } as never);
    const why = rejectReason(file.name, slot);
    if (why) return problem(422, 'file_rejected', 'The file is not accepted', { reason: why, allowed: slot.formats } as never);
    const replaces = form.get('replaces_file_group_id');
    const prev = typeof replaces === 'string' && replaces ? slot.files.find((x) => x.file_group_id === replaces && x.is_current) : undefined;
    if (!prev && slot.max_files != null && slot.files.filter((x) => x.is_current).length >= slot.max_files) return problem(422, 'file_rejected', 'The file is not accepted', { reason: 'too_many_files' } as never);
    const fid = crypto.randomUUID();
    const f = { id: fid, file_group_id: prev?.file_group_id ?? crypto.randomUUID(), version: (prev?.version ?? 0) + 1, is_current: true, original_name: file.name, download_name: `${t.site_code}_${t.task_code}_${slot.doc_code}_DRAFT-20261025.${file.name.split('.').pop()}`, mime_type: file.type, size_bytes: file.size, uploaded_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name }, uploaded_at: new Date().toISOString(), approved_date: null, superseded_by: null, unknown_capture_date: slot.kind === 'photo' && !/exif/i.test(file.name), capture_date: null };
    t.slots = slotsOf(t).map((s) => (s.id === slot.id ? { ...s, status: 'uploaded' as const, reject_reason: null, files: [...s.files.map((x) => (prev && x.id === prev.id ? { ...x, is_current: false, superseded_by: fid } : x)), f] } : s));
    t.slots_filled = t.slots.filter((s) => s.files.some((x) => x.is_current)).length;
    save();
    return HttpResponse.json(f, { status: 201 });
  }),

  // contract 0.7.0: one template per register (issued by the database), so the catalogue follows the registers the viewer may use
  http.get(`${B}/templates`, () => {
    const v = viewer();
    if (!v) return problem(401, 'unauthenticated', 'Sign in required');
    const issued = '2026-10-21T08:00:00Z', versions = [{ version: 1, issued_at: issued, reason: 'first version' }];
    const registers = REGISTER_DEFS.filter((d) => v.nav.includes(d.module_key)).map((d) => ({ template_id: TEMPLATE_OF_REGISTER[d.register_key], name_en: d.name_en, name_ar: d.name_ar, kind: 'data_import', module_key: d.module_key, register_key: d.register_key, current_version: 1, issued_at: issued, is_active: true, versions }));
    const legacy = TEMPLATES.map(([id, en, ar]) => ({ template_id: id, name_en: en, name_ar: ar, kind: 'data_import', register_key: null, current_version: 1, issued_at: issued, is_active: true, versions }));
    // contract 0.11.5: the whole Master and one template per stream, for people who may use the Site Register and the Templates page
    const site = v.nav.includes('sites') && v.nav.includes('templates') ? [
      ['TPL-MASTER', 'Master (all sheets)', 'الماستر الكامل (كل الأوراق)', 'master', null, 1],
      ['TPL-SITE-DA', 'Site Register: Design & Acquisition', 'سجل المواقع: التصميم والاستحواذ', 'stream', 'DESIGN_ACQ', 3],
      ['TPL-SITE-CW', 'Site Register: Civil Works', 'سجل المواقع: الأعمال المدنية', 'stream', 'CW', 4],
      ['TPL-SITE-TE', 'Site Register: Installation (TE)', 'سجل المواقع: التركيبات', 'stream', 'TE', 5],
      ['TPL-SITE-CL', 'Site Register: Handover & Closure', 'سجل المواقع: التسليم والإغلاق', 'stream', 'CLOSURE', 6],
    ].map(([id, en, ar, tk, stream]) => ({ template_id: id, name_en: en, name_ar: ar, kind: 'data_import', template_kind: tk, module_key: 'sites', register_key: null, stream, current_version: 1, issued_at: issued, is_active: true, versions })) : [];
    return HttpResponse.json({ items: [...site, ...registers, ...legacy] } as never);
  }),
  http.get(`${B}/templates/:id/download`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, task = u.get('task_id'), prefill = u.get('prefill') === 'true' || !!u.get('site_ids');
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4]), {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${params.id}_v1${task ? '_task' : prefill ? '_prefilled' : ''}.xlsx"` },
    });
  }),

  http.get(`${B}/matrix`, ({ request }) => {
    const g = guard(); if (g) return g;
    const region = Number(new URL(request.url).searchParams.get('region_id') ?? 0);
    // as the API answers: the cells of every region, and those of the region asked for
    const full = db().matrix;
    const m: Matrix = { ...full, stages: full.stages.map((r) => ({ ...r, cells: r.cells.filter((c) => !c.region_id || c.region_id === region) })) };
    // B14: a deactivated or deleted holder keeps the seat and shows the badge.
    const tag = (x: unknown): unknown => Array.isArray(x) ? x.map(tag) : x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, tag(v)]).concat((x as { kind?: string }).kind === 'user' && (x as { employee_id?: string }).employee_id ? [['account_status', accountStatus((x as { employee_id: string }).employee_id)]] : [])) : x;
    return HttpResponse.json(tag(m) as never, { headers: { ETag: `"${m.version}"` } });
  }),
  http.patch(`${B}/matrix`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const m: Matrix = db().matrix;
    if (!viewer()?.nav.includes('admin.matrix')) return problem(403, 'forbidden', 'Not allowed');
    if (Number((request.headers.get('If-Match') ?? '').replace(/"/g, '')) !== m.version) return problem(412, 'precondition_failed', 'The matrix changed; reload');
    if (!stepUpValid()) return stepUp();
    const body = (await request.json()) as MatrixPatch;
    if (!body.reason?.trim()) return invalid('/reason', 'required');
    // the level count is fixed at 2 (owner decision 2026-11-01): the API refuses anything else with 422 and accepts 2 as a no-op
    for (const [i, l] of (body.stage_levels ?? []).entries()) if ((l.approval_levels as number) !== 2) return invalid(`/stage_levels/${i}/approval_levels`, 'invalid');
    for (const c of body.cells ?? []) {
      const r = rowOf(m, c.stage_code);
      if (!r) continue;
      // 422 empty_cell as the API answers it: a level in use (L1 = cell 1, L2 = cell 3) has no holder; `cells` lists them
      if (usedLevels().includes(c.level as 1 | 2 | 3) && c.assignees.length === 0) {
        return problem(422, 'empty_cell', 'A used level needs at least one holder', { cells: [{ stage_code: c.stage_code, task_code: null, level: c.level, level_kind: levelKind(c.level), region_id: null }] } as never);
      }
      const label = (a: { kind: string; ref_id: string }) => (a.kind === 'user' ? STAFF.find((s) => uid(s.employee_id) === a.ref_id) : a.kind === 'role' ? ROLES.find((x) => x.id === a.ref_id) : GROUPS.find((x) => x.id === a.ref_id));
      const assignees = c.assignees.map((a) => { const x = label(a) as { name_en?: string; name?: string; employee_id?: string } | undefined; return { kind: a.kind, ref_id: a.ref_id, label: x?.name_en ?? x?.name ?? '?', employee_id: a.kind === 'user' ? x?.employee_id ?? null : null, ...(a.kind === 'user' ? { user_id: a.ref_id } : {}) }; });
      const cur = r.cells.find((x) => x.level === c.level);
      if (cur) { cur.rule = c.rule; cur.assignees = assignees as never; }
      else r.cells.push({ id: crypto.randomUUID(), stage_code: c.stage_code, task_code: null, level: c.level, region_id: null, rule: c.rule, assignees: assignees as never });
    }
    m.version += 1;
    recomputeSkip(m);
    save();
    return HttpResponse.json(m, { headers: { ETag: `"${m.version}"` } });
  }),
  // Q86: delete a region or task override cell; the row default applies again
  http.delete(`${B}/matrix/cells/:id`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const m: Matrix = db().matrix;
    if (!viewer()?.nav.includes('admin.matrix')) return problem(403, 'forbidden', 'Not allowed');
    const sp = new URL(request.url).searchParams;
    const tagHeader = request.headers.get('If-Match');
    if (!tagHeader) return problem(428, 'precondition_required', 'If-Match is required');
    if (Number(tagHeader.replace(/"/g, '')) !== m.version) return problem(412, 'precondition_failed', 'The matrix changed; reload');
    if (!stepUpValid()) return stepUp();
    if ((sp.get('reason') ?? '').trim().length < 3) return invalid('/reason', 'required');
    for (const r of m.stages) {
      const i = r.cells.findIndex((c) => c.id === params.id);
      if (i < 0) continue;
      const c = r.cells[i]!;
      if (!c.region_id && !c.task_code) return invalid('/cell_id', 'row_default');
      r.cells.splice(i, 1);
      m.version += 1; recomputeSkip(m); save();
      return HttpResponse.json(m, { headers: { ETag: `"${m.version}"` } });
    }
    return problem(404, 'not_found', 'No such matrix cell.');
  }),
  http.get(`${B}/users/picker`, ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return page(STAFF.filter((s) => s.status === 'active' && (s.name_en.toLowerCase().includes(q) || s.employee_id.includes(q))).slice(0, 20).map((s) => ({ id: uid(s.employee_id), display_name: s.name_en, employee_id: s.employee_id })));
  }),
];
