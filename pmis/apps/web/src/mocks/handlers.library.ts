// MSW handlers of the Library menu (plan W5, contract 0.15.70): Forms (approved forms, preview, generate, download, void), Archive (cards, rows with the
// lifecycle, zip), Settings > Documents > Form templates and Archive. Synthetic sites of the mock database; the rules mirror the database (migration 0151):
// generation by the L1 holder or "Documents: generate" while the task is open, numbers from the form's sequence, never reused.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { LibraryArchiveRow, LibraryArchiveSetting, LibraryDocStatus, LibraryFormTemplate, LibraryGeneratedDocument } from '@/api/library';
import { ARCHIVE_COLUMNS } from '@/api/library';
import { stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { siteMeta } from './sites';

const B = API_BASE;
const NOW = '2026-11-24T08:00:00.000Z';
const REGION_EN = ['Tripoli', 'Middle', 'WM', 'Zawia', 'Benghazi', 'GM', 'Sebha'];
const REGION_AR = ['طرابلس', 'الوسطى', 'الغربية', 'الزاوية', 'بنغازي', 'الجبل الغربي', 'سبها'];
const DOCS = [
  { code: 'A1', id: 'd0c00000-0000-4000-8000-000000000001', en: 'A1 SAR (site acquisition report)', ar: 'A1 تقرير الاستحواذ على الموقع', task: 'A1', task_en: 'Site survey and SAR', task_ar: 'مسح الموقع وتقرير الاستحواذ', group: 'DESIGN_ACQ' },
  { code: 'A2', id: 'd0c00000-0000-4000-8000-000000000002', en: 'A2 TSSR', ar: 'A2 تقرير مسح الموقع الفني', task: 'A2', task_en: 'TSSR', task_ar: 'تقرير المسح الفني', group: 'DESIGN_ACQ' },
  { code: 'B13_PAC', id: 'd0c00000-0000-4000-8000-000000000013', en: 'CW PAC certificate (signed and scanned)', ar: 'شهادة القبول الأولي CW PAC', task: 'B13', task_en: 'CW PAC', task_ar: 'القبول الأولي للأعمال المدنية', group: 'CW' },
];
const GROUPS: Record<string, { en: string; ar: string }> = { DESIGN_ACQ: { en: 'Design & Acquisition', ar: 'التصميم والاستحواذ' }, CW: { en: 'Civil Works', ar: 'الأعمال المدنية' } };
const pad = (n: number, w = 12) => String(n).padStart(w, '0');
const slotIdOf = (i: number, d: number) => `7c1b0000-0000-4000-8000-${pad(i * 10 + d + 1)}`;
const taskIdOf = (i: number, d: number) => `7c1a0000-0000-4000-8000-${pad(i * 10 + d + 1)}`;
const me = () => { const v = viewer(); return v ? { id: `mock-${v.key}`, display_name: v.name, employee_id: v.employee_id ?? null } : null; };
const canUse = () => { const v = viewer(); return !!v && (v.key === 'pm' || (v.nav ?? []).includes('sites')); };
const isAdmin = () => viewer()?.key === 'pm';
const canGenerate = () => { const v = viewer(); return !!v && (v.key === 'pm' || v.key === 'engineer' || v.key === 'reviewer'); };

interface Row extends LibraryArchiveRow { site_i: number }
interface Gen extends LibraryGeneratedDocument { html: string }
interface State { rows: Row[]; gen: Gen[]; tpls: LibraryFormTemplate[]; seq: Record<string, number>; setting: LibraryArchiveSetting }

const SEED_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Site survey report</title><style>body{font-family:Cairo,sans-serif}td{border:1px solid #888;padding:4px}</style></head>'
  + '<body><h1>Site survey report {{doc.ref_no}}</h1><table><tr><td>Site ID</td><td>{{site.id}}</td></tr><tr><td>Site name</td><td>{{site.name}}</td></tr><tr><td>Region</td><td>{{site.region_name}}</td></tr>'
  + '<tr><td>Date</td><td>{{doc.date}}</td></tr><tr><td>Prepared by</td><td>{{generated_by.name}}</td></tr></table><p>Signature: ____________</p></body></html>';

function seed(): State {
  const rows: Row[] = [];
  for (let i = 0; i < 8; i++) {
    const m = siteMeta(i);
    DOCS.forEach((d, k) => {
      if (d.code === 'B13_PAC' && i % 2) return;
      const status: LibraryDocStatus = k === 0 ? (i % 3 === 0 ? 'approved' : 'in_review') : k === 1 ? (i === 0 ? 'approved' : 'due') : 'due';
      const has = status === 'approved' || status === 'in_review';
      rows.push({
        key: `S:${slotIdOf(i, k)}`, slot_id: slotIdOf(i, k), status, site_id: m.id, site_code: m.code, site_name: m.name, region_id: m.region_id as LibraryArchiveRow['region_id'],
        region_name: REGION_EN[m.region_id - 1] ?? null, region_name_ar: REGION_AR[m.region_id - 1] ?? null, cluster: m.cluster, doc_type_id: d.id, doc_code: d.code,
        doc_name_en: d.en, doc_name_ar: d.ar, candidate_label: null, doc_number: null, generated_id: null, version: has ? 1 : null, task_id: taskIdOf(i, k), task_code: d.task,
        task_name_en: d.task_en, task_name_ar: d.task_ar, register_key: null, file_id: has ? `7c1f0000-0000-4000-8000-${pad(i * 10 + k + 1)}` : null,
        file_group_id: has ? `7c1e0000-0000-4000-8000-${pad(i * 10 + k + 1)}` : null, file_name: has ? `${m.code}_${d.code}.pdf` : null, mime_type: has ? 'application/pdf' : null,
        file_count: has ? 1 : 0, uploaded_by: has ? { id: 'u-1102', display_name: 'Demo User 02', employee_id: '1102' } : null, uploaded_at: has ? '2026-11-10T09:00:00.000Z' : null,
        approved_by: status === 'approved' ? { id: 'u-1001', display_name: 'Demo User 01', employee_id: '1001' } : null, approved_at: status === 'approved' ? '2026-11-12' : null,
        generated_at: null, form_id: null, site_i: i,
      } as Row);
    });
  }
  const tpl: LibraryFormTemplate = {
    id: 'f0000000-0000-4000-8000-000000000001', code: 'SSR', version: 1, name_en: 'Site survey report', name_ar: 'تقرير مسح الموقع', doc_type_id: DOCS[1]!.id, doc_code: 'A2',
    doc_name_en: DOCS[1]!.en, doc_name_ar: DOCS[1]!.ar, trigger_task_code: 'A2', trigger_task_name_en: 'TSSR', trigger_task_name_ar: 'تقرير المسح الفني', numbering_pattern: 'SSR-{YYYY}-{SEQ:4}',
    numbering_reset: 'yearly', bindings: {}, placeholders: ['doc.date', 'doc.ref_no', 'generated_by.name', 'site.id', 'site.name', 'site.region_name'], status: 'approved', sha256: '0'.repeat(64),
    size_bytes: SEED_HTML.length, created_by: { id: 'u-1001', display_name: 'Demo User 01', employee_id: '1001' }, created_at: '2026-11-20T08:00:00.000Z',
    approved_by: { id: 'u-1001', display_name: 'Demo User 01', employee_id: '1001' }, approved_at: '2026-11-20T09:00:00.000Z', retired_at: null, updated_at: '2026-11-20T09:00:00.000Z',
  };
  for (const r of rows) if (r.doc_type_id === tpl.doc_type_id) r.form_id = tpl.id;
  return { rows, gen: [], tpls: [tpl], seq: {}, setting: { hidden: [], order: [], default_columns: [...ARCHIVE_COLUMNS], zip_limit: 500, version: 0 } };
}
let S: State = seed();
const HTML: Record<string, string> = { 'f0000000-0000-4000-8000-000000000001': SEED_HTML };
/** Test hook: back to the seed. */
export function resetLibraryMock(): void { S = seed(); }

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const fill = (html: string, ctx: Record<string, unknown>) => html.replace(/\{\{\{?\s*([a-z_.]+)\s*\}?\}\}/gi, (_m, p: string) => esc(p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx)));
const ctxOf = (i: number, num: string) => {
  const m = siteMeta(i);
  return { site: { id: m.code, name: m.name, region_name: REGION_EN[m.region_id - 1] }, doc: { ref_no: num, date: NOW.slice(0, 10) }, generated_by: { name: me()?.display_name } };
};
const siteRow = (siteId: string, tplId: string) => {
  const t = S.tpls.find((x) => x.id === tplId);
  return t ? S.rows.find((r) => r.site_id === siteId && r.doc_type_id === t.doc_type_id) : undefined;
};
const noHtml = (d: Gen): LibraryGeneratedDocument => { const o: Partial<Gen> = { ...d }; delete o.html; return o as LibraryGeneratedDocument; };
const counted = (all: Row[], items: Row[]) => ({ total: all.length, filtered: items.length });

export const libraryHandlers = [
  http.get(`${B}/library/forms`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use sites.documents.');
    const items = S.tpls.filter((t) => t.status === 'approved').map((t) => ({ id: t.id, kind: 'html', code: t.code, name_en: t.name_en, name_ar: t.name_ar, version: t.version, doc_type_id: t.doc_type_id,
      doc_code: t.doc_code, doc_name_en: t.doc_name_en, doc_name_ar: t.doc_name_ar, trigger_task_code: t.trigger_task_code, trigger_task_name_en: t.trigger_task_name_en,
      trigger_task_name_ar: t.trigger_task_name_ar, numbering_pattern: t.numbering_pattern, blank_form_file_id: null, owner: t.approved_by, updated_at: t.updated_at }));
    return HttpResponse.json({ items, can_configure: isAdmin() });
  }),
  http.post(`${B}/library/forms/:id/preview`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { site_id: string };
    const r = siteRow(b.site_id, String(params.id));
    if (!r) return problem(404, 'not_found', 'The site does not exist or is not visible to you.');
    if (!canGenerate()) return problem(403, 'not_eligible_holder', 'Only the L1 holder of the task, or a holder of "Documents: generate" for the region, generates this document.');
    return HttpResponse.json({ html: fill(HTML[String(params.id)] ?? '', ctxOf(r.site_i, 'PREVIEW')), task_id: r.task_id, warnings: [] });
  }),
  http.post(`${B}/library/forms/:id/generate`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { site_id: string; remarks?: string };
    const t = S.tpls.find((x) => x.id === params.id && x.status === 'approved');
    const r = siteRow(b.site_id, String(params.id));
    if (!t || !r) return problem(404, 'not_found', 'The form or the site does not exist.');
    if (!canGenerate()) return problem(403, 'not_eligible_holder', 'Only the L1 holder of the task, or a holder of "Documents: generate" for the region, generates this document.');
    if (r.status === 'approved' || r.status === 'in_review') return problem(409, 'invalid_transition', `The document is due when task ${t.trigger_task_code} opens; the task is ${r.status}.`);
    const n = (S.seq[t.code] = (S.seq[t.code] ?? 0) + 1);
    const number = t.numbering_pattern.replace('{YYYY}', '2026').replace('{YY}', '26').replace(/\{SEQ:(\d)\}/, (_m, w: string) => String(n).padStart(Number(w), '0'));
    const doc: Gen = { id: crypto.randomUUID(), number, status: 'generated', template_id: t.id, template_code: t.code, template_version: t.version, site_id: r.site_id, site_code: r.site_code,
      region_id: r.region_id, task_id: r.task_id!, task_code: r.task_code!, doc_code: r.doc_code, remarks: b.remarks ?? null, sha256: null, size_bytes: 0, generated_by: me(), generated_at: NOW,
      void_reason: null, voided_by: null, voided_at: null, warnings: [], html: fill(HTML[t.id] ?? '', ctxOf(r.site_i, number)) };
    S.gen.push(doc);
    if (r.status === 'due' || r.status === 'rejected') { r.status = 'generated'; }
    r.doc_number = number; r.generated_id = doc.id; r.generated_at = NOW;
    return HttpResponse.json(noHtml(doc), { status: 201 });
  }),
  http.get(`${B}/library/generated/:id/download`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const d = S.gen.find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'The document does not exist or is not visible to you.');
    const purpose = new URL(request.url).searchParams.get('purpose') ?? 'download';
    return new HttpResponse(d.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `${purpose === 'download' ? 'attachment' : 'inline'}; filename="${d.site_code}_${d.number}.html"` } });
  }),
  http.post(`${B}/library/generated/:id/void`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const d = S.gen.find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'The document does not exist.');
    if (d.status === 'voided') return problem(409, 'invalid_transition', 'The document is voided already.');
    const b = await request.json() as { reason: string };
    Object.assign(d, { status: 'voided', void_reason: b.reason, voided_by: me(), voided_at: NOW });
    const r = S.rows.find((x) => x.generated_id === d.id);
    if (r) { r.generated_id = null; r.doc_number = null; if (r.status === 'generated') r.status = 'due'; }
    return HttpResponse.json(noHtml(d));
  }),
  http.get(`${B}/library/archive`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use sites.documents.');
    const hidden = new Set(S.setting.hidden), order = new Map(S.setting.order.map((c, i) => [c, i]));
    const groups = new Map<string, { key: string; name_en: string; name_ar: string; cards: unknown[] }>();
    const docs = [...DOCS].sort((a, b) => (order.get(a.code) ?? 1e6) - (order.get(b.code) ?? 1e6) || a.code.localeCompare(b.code));
    for (const d of docs) {
      const rs = S.rows.filter((r) => r.doc_code === d.code);
      if (!rs.some((r) => (r.file_count ?? 0) > 0 || r.generated_id)) continue;
      if (hidden.has(d.code) && !isAdmin()) continue;
      const grp = groups.get(d.group) ?? { key: d.group, name_en: GROUPS[d.group]!.en, name_ar: GROUPS[d.group]!.ar, cards: [] };
      grp.cards.push({ doc_code: d.code, doc_type_id: d.id, name_en: d.en, name_ar: d.ar, hidden: hidden.has(d.code), counts: { total: rs.length,
        approved: rs.filter((r) => r.status === 'approved').length, waiting_review: rs.filter((r) => r.status === 'signed_uploaded' || r.status === 'in_review').length,
        missing: rs.filter((r) => r.status === 'due' || r.status === 'generated' || r.status === 'rejected').length, generated: rs.filter((r) => r.status === 'generated').length,
        files: rs.reduce((n, r) => n + (r.file_count ?? 0), 0) } });
      groups.set(d.group, grp);
    }
    return HttpResponse.json({ groups: [...groups.values()], can_configure: isAdmin() });
  }),
  http.get(`${B}/library/archive/rows`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use sites.documents.');
    const u = new URL(request.url).searchParams;
    const doc = u.get('doc_code'), site = u.get('site_id'), status = u.get('status'), sup = u.get('include_superseded') === 'true';
    const tokens = [...new Set((u.get('q') ?? '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
    let tree: { items?: { field: string; operator: string; value: unknown }[] } | null = null;
    try { tree = u.get('filter') ? JSON.parse(u.get('filter')!) : null; } catch { tree = null; }
    const base = S.rows.filter((r) => (!doc || r.doc_code === doc) && (!site || r.site_id === site));
    const old: Row[] = sup ? base.filter((r) => (r.version ?? 0) > 1).map((r) => ({ ...r, key: `F:${r.slot_id}`, status: 'superseded' as LibraryDocStatus, version: (r.version ?? 2) - 1 })) : [];
    const all = [...base, ...old];
    const items = all.filter((r) => (!status || r.status === status)
      && (tokens.length === 0 || (tokens.length === 1 ? [r.site_code, r.site_name ?? '', r.doc_number ?? '', r.file_name ?? ''].some((x) => x.toUpperCase().includes(tokens[0]!)) : tokens.includes(r.site_code.toUpperCase())))
      && (tree?.items ?? []).every((c) => (c.field === 'status' ? (Array.isArray(c.value) ? c.value.includes(r.status) : r.status === c.value) : c.field === 'region_id' ? String(r.region_id) === String(c.value) : true)))
      .sort((a, b) => a.site_code.localeCompare(b.site_code) || a.doc_code.localeCompare(b.doc_code) || Number(a.status === 'superseded') - Number(b.status === 'superseded'));
    const search = tokens.length > 1 ? { pasted: tokens.length, found: tokens.filter((c) => S.rows.some((r) => r.site_code.toUpperCase() === c)).length, not_found: tokens.filter((c) => !S.rows.some((r) => r.site_code.toUpperCase() === c)) } : undefined;
    return HttpResponse.json({ items: items.map(({ site_i: _i, ...r }) => r), page: { limit: 200, next_cursor: null }, counts: counted(all, items), ...(search ? { search } : {}) });
  }),
  http.post(`${B}/library/archive/zip`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json({ id: `libzip-${crypto.randomUUID()}`, kind: 'zip_export', status: 'queued', progress: 0, created_at: NOW, finished_at: null }, { status: 202 });
  }),
  http.get(`${B}/jobs/:id`, ({ params }) => {
    if (!String(params.id).startsWith('libzip-')) return undefined;
    return HttpResponse.json({ id: params.id, kind: 'zip_export', status: 'done', progress: 1, created_at: NOW, finished_at: NOW, result: { export_id: params.id, file_count: 1, size_bytes: 10 } });
  }),
  http.get(`${B}/exports/zip/:id/download`, ({ params }) => {
    if (!String(params.id).startsWith('libzip-')) return undefined;
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="archive.zip"' } });
  }),
  // the signed copy goes into the task's own slot (the existing upload path); only the slots of this mock are answered here
  http.post(`${B}/tasks/:taskId/slots/:slotId/files`, async ({ params, request }) => {
    const r = S.rows.find((x) => x.slot_id === params.slotId && x.task_id === params.taskId);
    if (!r) return undefined;
    const g = guard(); if (g) return g;
    const f = (await request.formData()).get('file') as File | null;
    if (!f) return problem(422, 'validation_failed', 'Send the file as the multipart field "file".');
    const id = crypto.randomUUID();
    Object.assign(r, { status: 'signed_uploaded', file_id: id, file_group_id: r.file_group_id ?? crypto.randomUUID(), file_name: f.name, mime_type: f.type || 'application/pdf',
      file_count: 1, version: (r.version ?? 0) + 1, uploaded_by: me(), uploaded_at: NOW });
    return HttpResponse.json({ id, file_group_id: r.file_group_id, version: r.version, is_current: true, original_name: f.name, download_name: f.name, mime_type: r.mime_type,
      size_bytes: f.size, sha256: '0'.repeat(64), uploaded_at: NOW, approved_date: null, capture_date: null, unknown_capture_date: false, superseded_by: null }, { status: 201 });
  }),
  http.get(`${B}/library/form-templates`, () => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Only a System Admin or a delegate of the Document Library for all regions manages the form templates.');
    return HttpResponse.json({ items: [...S.tpls].sort((a, b) => a.code.localeCompare(b.code) || b.version - a.version) });
  }),
  http.get(`${B}/library/form-templates/:id/html`, ({ params }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Configuration right only.');
    return HttpResponse.json({ html: HTML[String(params.id)] ?? '' });
  }),
  http.post(`${B}/library/form-templates`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Only a System Admin or a delegate of the Document Library for all regions manages the form templates.');
    const fd = await request.formData();
    const file = fd.get('file') as File | null;
    const v = (k: string) => String(fd.get(k) ?? '');
    const html = file ? await file.text() : '';
    if (/<\s*script|\son[a-z]+\s*=|javascript:/i.test(html)) return problem(422, 'validation_failed', 'The form is not valid.', { errors: [{ path: '/html', code: 'unsafe_html', message: 'Not allowed in a form: <script>.' }] });
    if (!/\{SEQ:[1-9]\}/.test(v('numbering_pattern'))) return problem(422, 'validation_failed', 'The form is not valid.', { errors: [{ path: '/numbering_pattern', code: 'sequence_token', message: 'The pattern holds {SEQ:n} exactly once.' }] });
    const code = v('code').toUpperCase();
    const version = Math.max(0, ...S.tpls.filter((x) => x.code === code).map((x) => x.version)) + 1;
    const d = DOCS.find((x) => x.code === v('doc_code')) ?? DOCS[1]!;
    const t: LibraryFormTemplate = { id: crypto.randomUUID(), code, version, name_en: v('name_en'), name_ar: v('name_ar') || null, doc_type_id: d.id, doc_code: d.code, doc_name_en: d.en, doc_name_ar: d.ar,
      trigger_task_code: v('trigger_task_code'), trigger_task_name_en: null, trigger_task_name_ar: null, numbering_pattern: v('numbering_pattern'), numbering_reset: (v('numbering_reset') || 'yearly') as 'yearly',
      bindings: JSON.parse(v('bindings') || '{}'), placeholders: [...new Set([...html.matchAll(/\{\{\{?\s*([a-z_.]+)/gi)].map((m) => m[1]!))], status: 'draft', sha256: '0'.repeat(64), size_bytes: html.length,
      created_by: me(), created_at: NOW, approved_by: null, approved_at: null, retired_at: null, updated_at: NOW };
    S.tpls.push(t);
    HTML[t.id] = html;
    return HttpResponse.json(t, { status: 201 });
  }),
  http.post(`${B}/library/form-templates/:id/:op`, ({ params }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Configuration right only.');
    if (!stepUpValid()) return stepUp();
    const t = S.tpls.find((x) => x.id === params.id);
    if (!t) return problem(404, 'not_found', 'The form template does not exist.');
    if (params.op === 'approve') {
      if (t.status !== 'draft') return problem(409, 'invalid_transition', `Only a draft is approved (this version is ${t.status}).`);
      for (const x of S.tpls) if (x.code === t.code && x.status === 'approved') Object.assign(x, { status: 'retired', retired_at: NOW });
      Object.assign(t, { status: 'approved', approved_by: me(), approved_at: NOW, updated_at: NOW });
      for (const r of S.rows) if (r.doc_type_id === t.doc_type_id) r.form_id = t.id;
    } else if (params.op === 'retire') {
      if (t.status === 'retired') return problem(409, 'invalid_transition', 'This version is retired already.');
      Object.assign(t, { status: 'retired', retired_at: NOW, updated_at: NOW });
    } else return undefined;
    return HttpResponse.json(t);
  }),
  http.get(`${B}/settings/library-archive`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json(S.setting, { headers: { ETag: `"${S.setting.version}"` } });
  }),
  http.put(`${B}/settings/library-archive`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'admin path: System Admin or a delegation covering admin.settings.edit required');
    const tag = request.headers.get('If-Match');
    if (!tag) return problem(428, 'precondition_required', 'Send the ETag you last read in If-Match.');
    if (tag.replace(/"/g, '') !== String(S.setting.version)) return problem(412, 'precondition_failed', 'The setting changed meanwhile.');
    const b = await request.json() as LibraryArchiveSetting & { reason?: string };
    if (!b.reason || b.reason.trim().length < 3) return problem(422, 'validation_failed', 'A reason is required.', { errors: [{ path: '/reason', code: 'required', message: 'A reason of at least 3 characters is required.' }] });
    S.setting = { hidden: b.hidden, order: b.order, default_columns: b.default_columns, zip_limit: b.zip_limit, version: S.setting.version + 1, updated_at: NOW, ...(me() ? { updated_by: me()! } : {}) };
    return HttpResponse.json(S.setting, { headers: { ETag: `"${S.setting.version}"` } });
  }),
];
