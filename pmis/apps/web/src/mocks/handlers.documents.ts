// MSW handlers for the document upload module (contract 0.6.0): slots, upload checks, the Documents list, the bulk zip, the Document Library.
// Synthetic data; the checks mirror the contract (the real API reads the bytes, the mock reads the name).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DocumentFile, DocumentSlot } from '@/api/types';
import type { DocumentType, DocumentTypeVersion } from '@/api/documents';
import { tripoliToday } from '@/lib/today';
import { db, save, slotsOf, stepUpValid, viewer, type MockTask } from './db';
import { find, guard, problem, stepUp } from './handlers';
import { uid } from './ids';
import { SITE_COUNT, siteIndex, siteIdOf, siteTasks } from './sites';

const B = API_BASE;
const isAdmin = () => viewer()?.key === 'pm';
const ETag = (n: number) => ({ headers: { ETag: `"${n}"` } });
const fields = (...errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });
const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase().replace('jpeg', 'jpg');

/** Why the mock refuses a file (by its name; the real API reads the content). null = accepted. */
export function rejectReason(name: string, slot: Pick<DocumentSlot, 'formats'>): string | null {
  if (!name.includes('.')) return null; // a name without an extension (the test runtime loses the real name): nothing to judge
  const e = ext(name);
  if (['exe', 'dll', 'bat', 'cmd', 'sh', 'js', 'vbs', 'ps1', 'msi', 'scr', 'jar'].includes(e)) return 'executable';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(e)) return 'archive';
  if (['html', 'htm', 'mht', 'mhtml'].includes(e)) return 'html';
  if (['xlsm', 'docm', 'pptm'].includes(e)) return 'macro';
  if (slot.formats?.length && !slot.formats.map((x) => x.toLowerCase().replace('jpeg', 'jpg')).includes(e)) return 'format_not_allowed';
  return null;
}

/** Every task the mock knows for a site (generated and created ones). */
function tasksOfSite(siteId: string): MockTask[] {
  const i = siteIndex(siteId);
  const gen = i >= 0 && i < SITE_COUNT ? siteTasks(i) : [];
  const extra = db().extra.filter((t) => t.site_id === siteId);
  return [...gen, ...extra];
}
const allSites = (): string[] => Array.from({ length: SITE_COUNT }, (_, i) => siteIdOf(i));

// ---------------------------------------------------------------- the library (a compact copy of the seed of migration 0038)
type Doc = DocumentType & { _drafted?: boolean; _versions: DocumentTypeVersion[] };
const spec = (code: string, name_en: string, name_ar: string, tasks: string[], over: Partial<DocumentType> = {}): Doc => ({
  id: uid(`lib-${code}`), code, version: 1, published_version: 1, has_unpublished_changes: false, needs_review: false, updated_at: '2026-10-01T09:00:00Z', kind: 'scanned_document', form_kind: null,
  name_en, name_ar, placements: tasks.map((ref) => ({ target: 'task' as const, ref })), mandatory: true, condition_rule: null, formats: ['pdf', 'jpg', 'jpeg', 'png'], max_size_mb: 20, min_files: 1, max_files: null,
  photo_rules: null, expiry_tracked: false, blank_form_file_id: null, is_active: true,
  _versions: [{ version_no: 1, published_at: '2026-10-01T09:00:00Z', effective_from: '2026-10-01', apply_to: 'new_only', reason: 'seed', affected_open_tasks: 0, spec: {} as never }],
  ...over,
} as Doc);
const draft = (code: string, en: string, ar: string, tasks: string[], over: Partial<DocumentType> = {}) =>
  spec(code, en, ar, tasks, { published_version: 0, has_unpublished_changes: true, needs_review: true, _versions: [], ...over } as Partial<DocumentType>);
let LIB: Doc[] | null = null;
const lib = (): Doc[] => (LIB ??= [
  spec('A1', 'A1 SAR (one per candidate)', 'A1 طلب قبول الموقع (SAR) لكل مرشح', ['A1']), spec('A2', 'A2 TSSR', 'A2 تقرير مسح موقع TSSR', ['A2']),
  spec('A3', 'A3 Owner contract', 'A3 عقد المالك', ['A3']),
  spec('A3_CAA', 'A3 Civil aviation permit (near an airport)', 'A3 تصريح الطيران المدني', ['A3'], { condition_rule: { is_yes: 'site.custom.near_airport' } }),
  spec('A4', 'A4 LLD', 'A4 التصميم التفصيلي LLD', ['A4']),
  spec('B1', 'B1 PR email (outsourced only)', 'B1 بريد طلب الشراء', ['B1'], { kind: 'email', formats: ['pdf', 'jpg', 'jpeg', 'png', 'eml', 'msg'], condition_rule: { eq: ['procurement.delivery', 'outsourced'] } }),
  spec('B7_DN', 'B7 CW DN (signed scan)', 'B7 إشعار تسليم CW DN', ['B7'], { kind: 'generated_form', form_kind: 'dn' }),
  spec('B9', 'B9 MOS proof', 'B9 إثبات MOS', ['B8', 'B9'], { kind: 'photo', formats: ['jpg', 'jpeg', 'png', 'heic'], photo_rules: { min_count: 1, formats: ['JPG', 'PNG', 'HEIC'] } }),
  draft('D16_PAC', 'TE PAC certificate (signed and scanned)', 'شهادة القبول الأولي TE PAC', ['D16']), draft('D17_HOTO', 'HOTO package (signed and scanned)', 'حزمة التسليم HOTO', ['D17']),
  draft('B15_FAC', 'CW FAC certificate (signed and scanned)', 'شهادة القبول النهائي CW FAC', ['B15'], { kind: 'generated_form', form_kind: 'fac' }),
]);
const out = ({ _versions, _drafted, ...d }: Doc): DocumentType => (void _versions, void _drafted, d);
const need = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const reasonErr = (r?: string) => ((r ?? '').trim().length < 3 ? fields({ path: '/reason', code: 'required' }) : null);
const OPEN_TASKS = 7; // pending or ongoing tasks a publish "also open tasks" would reach, in the mock

const formsOk = (b: Partial<DocumentType>): { path: string; code: string }[] => {
  const e: { path: string; code: string }[] = [];
  if (b.name_en !== undefined && b.name_en.trim().length < 2) e.push({ path: '/name_en', code: 'required' });
  if (b.formats?.some((f) => ['exe', 'html', 'htm', 'zip', 'rar', '7z', 'xlsm', 'js'].includes(f))) e.push({ path: '/formats', code: 'not_allowed' });
  if (b.max_size_mb !== undefined && (b.max_size_mb < 1 || b.max_size_mb > 200)) e.push({ path: '/max_size_mb', code: 'invalid' });
  if (b.max_files != null && b.max_files < Math.max(1, b.min_files ?? 1)) e.push({ path: '/max_files', code: 'invalid' });
  b.placements?.forEach((p, i) => { if (p.target === 'task' && !/^[A-Z][0-9A-Za-z]{0,4}$/.test(p.ref)) e.push({ path: `/placements/${i}`, code: 'unknown_task' }); });
  if (b.kind === 'generated_form' && !b.form_kind) e.push({ path: '/form_kind', code: 'required' });
  return e;
};

const jobs = new Map<string, { polls: number; scope: unknown; name: string }>();

export const documentHandlers = [
  http.get(`${B}/tasks/:id/slots`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    return t ? HttpResponse.json({ items: slotsOf(t) }) : problem(404, 'not_found', 'Task not found');
  }),
  http.post(`${B}/tasks/:id/slots/suggest`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    const names = ((await request.json().catch(() => ({}))) as { file_names?: string[] }).file_names;
    if (!names?.length) return fields({ path: '/file_names', code: 'too_small' });
    const slots = slotsOf(t).filter((s) => s.status !== 'not_required');
    return HttpResponse.json({
      items: names.map((file_name) => {
        const low = file_name.toLowerCase();
        const hit = slots.filter((s) => low.includes(s.doc_code.toLowerCase()) || s.name_en.toLowerCase().split(/\W+/).some((w) => w.length > 3 && low.includes(w)));
        return { file_name, suggestions: hit.map((s) => ({ slot_id: s.id, doc_code: s.doc_code, score: low.includes(s.doc_code.toLowerCase()) ? 0.95 : 0.6 })) };
      }),
    });
  }),
  http.post(`${B}/tasks/:id/slots`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string), v = viewer()!;
    if (!t) return problem(404, 'not_found', 'Task not found');
    const b = (await request.json().catch(() => ({}))) as { doc_code?: string; candidate_label?: string | null };
    const slots = slotsOf(t);
    const same = slots.find((s) => s.doc_code === b.doc_code && (s.candidate_label ?? null) === (b.candidate_label ?? null));
    if (same && same.status !== 'not_required') return problem(409, 'duplicate', 'The task has this slot already');
    const base = slots.find((s) => s.doc_code === b.doc_code);
    if (!base) return fields({ path: '/doc_code', code: 'unknown_document' });
    const slot: DocumentSlot = same ? { ...same, status: 'missing' } : { ...base, id: crypto.randomUUID(), status: 'missing', candidate_label: b.candidate_label ?? null, files: [], reject_reason: null };
    t.slots = same ? slots.map((s) => (s.id === same.id ? slot : s)) : [...slots, slot];
    save(); void v;
    return HttpResponse.json(slot, { status: 201 });
  }),
  http.delete(`${B}/tasks/:id/slots/:slot/files/:file`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    const slot = t && slotsOf(t).find((s) => s.id === params.slot);
    if (!t || !slot) return problem(404, 'not_found', 'Slot not found');
    const files = slot.files.map((f) => (f.id === params.file ? { ...f, is_current: false, superseded_by: null } : f));
    const out: DocumentSlot = { ...slot, files, status: files.some((f) => f.is_current) ? slot.status : 'missing' };
    t.slots = slotsOf(t).map((s) => (s.id === slot.id ? out : s));
    save();
    return HttpResponse.json(out);
  }),
  http.get(`${B}/documents`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const siteId = u.get('site_id');
    const stage = u.get('stage_code'), task = u.get('task_code'), docs = u.getAll('doc_code'), kind = u.get('kind'), status = u.get('slot_status'), q = (u.get('q') ?? '').toLowerCase();
    const history = u.get('include_superseded') === 'true';
    const tasks = (siteId ? tasksOfSite(siteId) : allSites().slice(0, 12).flatMap(tasksOfSite));
    const items = tasks.flatMap((t) => slotsOf(t).flatMap((s) => s.files.map((f) => ({
      file: { ...f, approved_date: f.approved_date ?? null } as DocumentFile, slot_id: s.id, slot_status: s.status, candidate_label: s.candidate_label ?? null, doc_code: s.doc_code, doc_name_en: s.name_en, doc_name_ar: s.name_ar ?? null,
      kind: s.kind ?? 'scanned_document', task_id: t.id, task_code: t.task_code, task_name: t.name_en, stage_code: t.stage_code, stage_name: t.stage_code, site_id: t.site_id, site_code: t.site_code, site_name: null, region_id: t.region_id,
    }))))
      .filter((i) => (history || i.file.is_current) && (!stage || i.stage_code === stage) && (!task || i.task_code === task) && (!docs.length || docs.includes(i.doc_code)) && (!kind || i.kind === kind) && (!status || i.slot_status === status)
        && (!q || `${i.site_code} ${i.doc_name_en} ${i.file.original_name}`.toLowerCase().includes(q)));
    return HttpResponse.json({ items, page: { limit: 200, next_cursor: null } });
  }),
  http.get(`${B}/files/:id/download`, ({ params }) => {
    const g = guard(); if (g) return g;
    const id = params.id as string;
    if (id.startsWith('9a000000-')) return undefined; // the security log export file: the settings handler serves it
    for (const t of [...db().extra, ...db().tasks, ...Object.values(db().ov)]) {
      const f = slotsOf(t).flatMap((s) => s.files).find((x) => x.id === id);
      if (f) return new HttpResponse(`mock file ${f.original_name}\n`, { headers: { 'Content-Type': f.mime_type ?? 'application/pdf', 'Content-Disposition': `attachment; filename="${f.download_name}"` } });
    }
    const doc = lib().find((d) => d.blank_form_file_id === id);
    if (doc) return new HttpResponse('mock blank form\n', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${doc.code}_BLANK-FORM.pdf"` } });
    return problem(404, 'not_found', 'File not found');
  }),
  http.post(`${B}/exports/zip`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.site_id && !b.stage_code && !b.doc_code && !b.file_ids) return fields({ path: '/', code: 'scope_required' });
    const id = crypto.randomUUID();
    jobs.set(id, { polls: 0, scope: b, name: `GSDN_Documents_${tripoliToday().replace(/-/g, '')}.zip` });
    return HttpResponse.json({ id, kind: 'zip_export', status: 'queued', progress: 0, created_at: new Date().toISOString(), finished_at: null }, { status: 202 });
  }),
  http.get(`${B}/jobs/:id`, ({ params }) => {
    const j = jobs.get(params.id as string);
    if (!j) return undefined; // another kind of job: the next handler answers
    j.polls += 1;
    const done = j.polls >= 2;
    return HttpResponse.json({ id: params.id, kind: 'zip_export', status: done ? 'done' : 'running', progress: done ? 1 : 0.5, ...(done ? { result: { export_id: params.id, file_count: 3, size_bytes: 2048 } } : {}), created_at: new Date().toISOString(), finished_at: done ? new Date().toISOString() : null });
  }),
  http.get(`${B}/exports/zip/:id/download`, ({ params }) => {
    const g = guard(); if (g) return g;
    const j = jobs.get(params.id as string);
    if (!j) return problem(404, 'not_found', 'Export not found');
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${j.name}"` } });
  }),

  // ---- the Document Library
  http.get(`${B}/document-library`, ({ request }) => {
    const g = need(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const kind = u.get('kind'), ref = u.get('placement_ref'), inactive = u.get('include_inactive') === 'true';
    const items = lib().filter((d) => (inactive || d.is_active) && (!kind || d.kind === kind) && (!ref || d.placements?.some((p) => p.ref === ref))).map(out);
    return HttpResponse.json({ items, page: { limit: 200, next_cursor: null } });
  }),
  http.post(`${B}/document-library`, async ({ request }) => {
    const g = need(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as Partial<DocumentType> & { reason?: string; code?: string };
    const r = reasonErr(b.reason); if (r) return r;
    if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(b.code ?? '')) return fields({ path: '/code', code: 'invalid' });
    if (lib().some((d) => d.code === b.code)) return problem(409, 'duplicate', 'This code is in use');
    const e = formsOk(b); if (e.length) return fields(...e);
    const d = spec(b.code!, b.name_en ?? '', b.name_ar ?? '', [], { ...b, published_version: 0, has_unpublished_changes: true, id: crypto.randomUUID(), _versions: [] } as Partial<DocumentType>);
    lib().push(d);
    return HttpResponse.json(out(d), { status: 201, ...ETag(d.version) });
  }),
  http.get(`${B}/document-library/:id`, ({ params }) => {
    const g = need(); if (g) return g;
    const d = lib().find((x) => x.id === params.id);
    return d ? HttpResponse.json({ ...out(d), open_task_count: OPEN_TASKS }, ETag(d.version)) : problem(404, 'not_found', 'Not found');
  }),
  http.patch(`${B}/document-library/:id`, async ({ params, request }) => {
    const g = need(); if (g) return g;
    const d = lib().find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'Not found');
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (Number(h.replace(/"/g, '')) !== d.version) return problem(412, 'precondition_failed', 'Changed by someone else');
    const { reason, ...b } = (await request.json().catch(() => ({}))) as Partial<DocumentType> & { reason?: string };
    const r = reasonErr(reason); if (r) return r;
    const e = formsOk(b); if (e.length) return fields(...e);
    Object.assign(d, b, { has_unpublished_changes: true, version: d.version + 1, updated_at: new Date().toISOString() });
    return HttpResponse.json(out(d), ETag(d.version));
  }),
  http.post(`${B}/document-library/:id/publish`, async ({ params, request }) => {
    const g = need(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const d = lib().find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'Not found');
    const b = (await request.json().catch(() => ({}))) as { reason?: string; apply_to?: string; effective_from?: string };
    const r = reasonErr(b.reason); if (r) return r;
    if (!d.has_unpublished_changes) return fields({ path: '/', code: 'nothing_to_publish' });
    d.published_version = (d.published_version ?? 0) + 1; d.has_unpublished_changes = false; d.needs_review = false; d.version += 1;
    const affected = b.apply_to === 'open_too' ? OPEN_TASKS : 0;
    d._versions.unshift({ version_no: d.published_version ?? 1, published_at: new Date().toISOString(), effective_from: b.effective_from ?? tripoliToday(), apply_to: b.apply_to === 'open_too' ? 'open_too' : 'new_only', reason: b.reason!, affected_open_tasks: affected, spec: {} as never, published_by: { id: uid(viewer()!.employee_id ?? '1001'), display_name: viewer()!.name } });
    return HttpResponse.json({ published_version: d.published_version ?? 1, affected_open_tasks: affected });
  }),
  http.get(`${B}/document-library/:id/versions`, ({ params }) => {
    const g = need(); if (g) return g;
    const d = lib().find((x) => x.id === params.id);
    return d ? HttpResponse.json({ items: d._versions }) : problem(404, 'not_found', 'Not found');
  }),
  http.get(`${B}/document-library/:id/blank-form`, ({ params }) => {
    const g = need(); if (g) return g;
    const d = lib().find((x) => x.id === params.id);
    return d?.blank_form_file_id ? new HttpResponse('mock blank form\n', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${d.code}_BLANK-FORM.pdf"` } }) : problem(404, 'not_found', 'No blank form');
  }),
  http.post(`${B}/document-library/:id/blank-form`, async ({ params, request }) => {
    const g = need(); if (g) return g;
    const d = lib().find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'Not found');
    const file = (await request.formData()).get('file');
    if (!file || typeof file === 'string') return fields({ path: '/file', code: 'required' });
    const bad = rejectReason(file.name, { formats: ['pdf', 'png', 'jpg', 'docx', 'xlsx'] });
    if (bad) return problem(422, 'file_rejected', 'The file is not accepted', { reason: bad } as never);
    d.blank_form_file_id = crypto.randomUUID(); d.has_unpublished_changes = true; d.version += 1;
    return HttpResponse.json(out(d), ETag(d.version));
  }),
];
