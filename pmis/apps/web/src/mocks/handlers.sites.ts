import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Matrix, MatrixPatch } from '@/api/types';
import { levelKind, usedLevels } from '@/lib/matrixLevels';
import { canAct, canEditTask, db, save, slotsOf, STAFF, stepUpValid, toDetail, viewer, skipPath, type MockTask } from './db';
import { find, guard, ifMatch, page, problem, recordStep, stepUp } from './handlers';
import { uid } from './ids';
import { accountStatus } from './db';
import { GROUPS, recomputeSkip, ROLES, rowOf } from './matrixData';
import { detail, gridOf, listItem, siteIndex, SITE_COUNT, siteMeta, STREAMS, TODAY } from './sites';

const B = API_BASE;
const REGIONS = [['Tripoli', 'طرابلس'], ['Middle', 'الوسطى'], ['WM', 'الجبل الغربي'], ['Zawia', 'الزاوية'], ['Benghazi', 'بنغازي'], ['GM', 'الجبل الأخضر'], ['Sebha', 'سبها']];
const TEMPLATES = [['TPL-SITE', 'Site tasks (dates and statuses)', 'مهام الموقع (التواريخ والحالات)'], ['TPL-ACQ', 'Acquisition', 'الاستحواذ'], ['TPL-RF', 'RF & Design', 'RF والتصميم'], ['TPL-PO', 'Procurement', 'المشتريات'], ['TPL-PRM', 'Permits', 'التصاريح'], ['TPL-GECOL', 'GECOL', 'GECOL'], ['TPL-HLC', 'HLC', 'HLC']];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: unknown) => s === null || (typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s)));
const tagged = (t: MockTask) => HttpResponse.json(toDetail(t), { headers: { ETag: `"${t.version}"` } });
const invalid = (path: string, code: string, title = 'Validation failed') => problem(422, code === 'invalid_date' ? 'validation_failed' : code, title, { errors: [{ path, code }] });

export const siteHandlers = [
  http.get(`${B}/regions`, () => (viewer() ? HttpResponse.json({ items: REGIONS.map(([en, ar], i) => ({ id: i + 1, code: en, name_en: en, name_ar: ar, visible: true })) }) : problem(401, 'unauthenticated', 'Sign in required'))),

  http.get(`${B}/sites`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const q = (u.get('q') ?? '').toLowerCase(), regions = u.getAll('region_id').map(Number), limit = Math.min(Number(u.get('limit') ?? 50), 200), start = Number(u.get('cursor') ?? 0);
    const sc = u.get('scenario'), st = u.get('overall_status'), stage = u.get('stage_code'), stream = u.get('stream');
    if (stream && !STREAMS.some((x) => x.code === stream)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/stream', code: 'unknown_stream' }] });
    const all = Array.from({ length: SITE_COUNT }, (_, i) => siteMeta(i)).filter((m) =>
      (!q || `${m.code} ${m.name}`.toLowerCase().includes(q)) && (!regions.length || regions.includes(m.region_id)) && (!sc || m.scenario === sc) && (!st || m.status === st));
    // with a stream: rail and counts cover that stream only, and sites where it does not apply are left out (contract 0.4.1)
    const items = all.map((m) => listItem(m.i, stream ?? undefined))
      .filter((x) => !stream || x.streams?.find((s) => s.code === stream)?.state !== 'na')
      .filter((x) => !stage || (stream ? x.rail.find((r) => r.state === 'current' || r.state === 'late')?.code === stage : x.current_milestone === stage));
    const slice = items.slice(start, start + limit), next = start + limit < items.length ? String(start + limit) : null;
    return HttpResponse.json({ items: slice, page: { limit, next_cursor: next, total: items.length } });
  }),
  http.get(`${B}/sites/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    return i >= 0 && i < SITE_COUNT ? HttpResponse.json(detail(i), { headers: { ETag: '"1"' } }) : problem(404, 'not_found', 'Site not found');
  }),
  http.get(`${B}/sites/:id/tasks`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    const stream = new URL(request.url).searchParams.get('stream');
    if (stream && !STREAMS.some((x) => x.code === stream)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/stream', code: 'unknown_stream' }] });
    return i >= 0 && i < SITE_COUNT ? HttpResponse.json(gridOf(i, stream ?? undefined)) : problem(404, 'not_found', 'Site not found');
  }),

  http.patch(`${B}/tasks/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    const bad = ifMatch(request, t); if (bad) return bad;
    if ((t.state !== 'entry' && t.state !== 'open') || !canEditTask(t)) return problem(403, 'forbidden', 'You cannot edit this task');
    const body = (await request.json()) as Record<string, unknown>;
    for (const k of ['planned_date', 'actual_start', 'actual_date'] as const) if (k in body && !validDate(body[k])) return invalid(`/${k}`, 'invalid_date');
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
    const { body } = (await request.json()) as { body?: string };
    if (!body?.trim()) return invalid('/body', 'required');
    const c = { id: crypto.randomUUID(), author: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined }, body: body.trim(), created_at: new Date().toISOString() };
    t.comments = [...(t.comments ?? []), c];
    save();
    return HttpResponse.json(c, { status: 201 });
  }),
  http.post(`${B}/tasks/:id/slots/:slot/files`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string), v = viewer()!;
    const slot = t && slotsOf(t).find((s) => s.id === params.slot);
    if (!t || !slot) return problem(404, 'not_found', 'Slot not found');
    const file = (await request.formData()).get('file');
    if (!file || typeof file === 'string') return invalid('/file', 'required'); // duck-typed: jsdom and undici have different File classes
    if (file.size > 20 * 1024 * 1024) return problem(413, 'payload_too_large', 'File is larger than 20 MB');
    const f = { id: crypto.randomUUID(), file_group_id: crypto.randomUUID(), version: 1, is_current: true, original_name: file.name, download_name: `${t.site_code}_${t.task_code}_${file.name}`, mime_type: file.type, size_bytes: file.size, uploaded_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name }, uploaded_at: new Date().toISOString() };
    t.slots = slotsOf(t).map((s) => (s.id === slot.id ? { ...s, status: 'uploaded' as const, files: [...s.files, f] } : s));
    t.slots_filled = t.slots.filter((s) => s.files.length).length;
    save();
    return HttpResponse.json(f, { status: 201 });
  }),

  http.get(`${B}/templates`, () => (viewer() ? HttpResponse.json({ items: TEMPLATES.map(([id, en, ar]) => ({ template_id: id, name_en: en, name_ar: ar, kind: 'data_import', current_version: 1, is_active: true })) }) : problem(401, 'unauthenticated', 'Sign in required'))),
  http.get(`${B}/templates/:id/download`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const task = new URL(request.url).searchParams.get('task_id');
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4]), {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${params.id}_v1${task ? '_task' : ''}.xlsx"` },
    });
  }),
  http.post(`${B}/import-batches`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const f = (await request.formData()).get('file');
    if (!f || typeof f === 'string' || !f.name.endsWith('.xlsx')) return problem(422, 'template_rejected', 'Not an approved template', { reason: 'tpl_missing' } as never);
    return HttpResponse.json({ id: crypto.randomUUID(), template_id: 'TPL-SITE', template_version: 1, status: 'parsing', counts: {}, version: 1, file_name: f.name }, { status: 202 });
  }),

  http.get(`${B}/matrix`, () => {
    const g = guard(); if (g) return g;
    const m = db().matrix;
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
    for (const l of body.stage_levels ?? []) { const r = rowOf(m, l.stage_code); if (r) r.approval_levels = l.approval_levels; }
    for (const c of body.cells ?? []) {
      const r = rowOf(m, c.stage_code);
      if (!r) continue;
      // 422 empty_cell as the API answers it: the level in use (cell 1, and 3 / 2 and 3 for 2 / 3 levels) has no holder; `cells` lists them
      if (usedLevels(r.approval_levels).includes(c.level as 1 | 2 | 3) && c.assignees.length === 0) {
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
  http.get(`${B}/users/picker`, ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return page(STAFF.filter((s) => s.status === 'active' && (s.name_en.toLowerCase().includes(q) || s.employee_id.includes(q))).slice(0, 20).map((s) => ({ id: uid(s.employee_id), display_name: s.name_en, employee_id: s.employee_id })));
  }),
];
