// MSW handlers of contract 0.11.1 (migration 0047): the site field near_airport (Q130), document slots on register records (Q131) and QC snag photos (Q132).
// Synthetic data; the checks mirror the contract (the real API reads the bytes and the EXIF date, the mock reads the name).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DocumentSlot, SiteDetail } from '@/api/types';
import type { Snag, SnagType } from '@/api/qc';
import { db, stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { rejectReason } from './handlers.documents';
import { uid } from './ids';
import { detail, siteIndex, siteMeta } from './sites';

const B = API_BASE;
const fields = (...errors: { path: string; code: string; message?: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });
const ifMatchOf = (req: Request): number | null | 'missing' => {
  const h = req.headers.get('If-Match');
  return h ? Number(h.replace(/"/g, '')) : 'missing';
};
const isPm = () => viewer()?.key === 'pm';

// ---------------------------------------------------------------- Q130: the site's custom fields
const siteCustom = new Map<string, { custom: Record<string, unknown>; version: number }>();
const SITE_FIELDS = [{ code: 'near_airport', label_en: 'Near an airport', label_ar: 'قريب من مطار', type: 'bool' as const, section: 'Site', required: false }];

/** The detail of a mock site with its custom fields (and the open snags of the mock store). */
export function qcSiteDetail(d: SiteDetail): SiteDetail {
  const c = siteCustom.get(d.id);
  const snags = SNAGS.get(d.id);
  return {
    ...d,
    version: c?.version ?? d.version,
    custom: c?.custom ?? {},
    custom_fields: SITE_FIELDS.map((f) => ({ ...f, can_edit: !!viewer() && viewer()!.key !== 'viewer' })),
    counts: snags ? { ...d.counts, open_snags: snags.filter((s) => s.state !== 'closed' && s.state !== 'cancelled').length } : d.counts,
  } as SiteDetail;
}

// ---------------------------------------------------------------- Q131: slots of register records (one Permits & HSE scan, keyed on the logical record)
const recSlots = new Map<string, DocumentSlot[]>();
function recordOf(key: string, id: string) {
  return db().reg.records.find((x) => x.id === id && x.register_key === key);
}
function slotsOfRecord(key: string, id: string): DocumentSlot[] | null {
  const r = recordOf(key, id);
  if (!r) return null;
  if (r.site_index === null || key !== 'permits_hse') return [];
  let list = recSlots.get(r.entity_id);
  if (!list) {
    list = [{
      id: uid(`recslot-${r.entity_id}`), doc_type_id: uid('lib-PERMIT_SCAN'), doc_code: 'PERMIT_SCAN', name_en: 'Signed permit (scan)', name_ar: 'التصريح الموقّع (نسخة ممسوحة)', kind: 'scanned_document',
      mandatory: true, conditional: false, status: 'missing', reject_reason: null, candidate_label: null, formats: ['pdf', 'jpg', 'jpeg', 'png'], max_size_mb: 20, min_files: 1, max_files: 1,
      files: [], can_upload: true, expiry_tracked: false, blank_form_file_id: null, valid_to: null, camera_only: false,
    } as DocumentSlot];
    recSlots.set(r.entity_id, list);
  }
  const entry = r.state === 'entry';
  // the statuses follow the record, as the database moves them (submit: in review; approval: approved; back to entry: uploaded)
  return list.map((s) => {
    const has = s.files.some((f) => f.is_current);
    const status = s.status === 'rejected' && entry ? 'rejected' : r.state === 'approved' && has ? 'approved' : (r.state === 'in_review' || r.state === 'in_approval') && has ? 'in_review' : has ? 'uploaded' : 'missing';
    return { ...s, status, can_upload: entry && status !== 'approved' } as DocumentSlot;
  });
}

// ---------------------------------------------------------------- Q132: snags
const TYPES: SnagType[] = [
  { id: uid('snagtype-QC_GENERAL'), code: 'QC_GENERAL', name_en: 'General QC snag', name_ar: 'ملاحظة جودة عامة', photo_rules: { min_count: 1, shot_types: [], formats: ['JPG', 'PNG', 'HEIC'], max_size_mb: 20 }, blocks_preliminary_acceptance: true, is_active: true, version: 1 },
  { id: uid('snagtype-CRACK'), code: 'CRACK', name_en: 'Concrete crack', name_ar: 'شرخ خرساني', photo_rules: { min_count: 2, shot_types: ['wide', 'close'], formats: ['JPG'], max_size_mb: 20 }, blocks_preliminary_acceptance: true, is_active: true, version: 1 },
];
const SNAGS = new Map<string, Snag[]>();
const me = () => { const v = viewer()!; return { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? null }; };
const missingOf = (s: Snag) => {
  const live = s.photos!.filter((p) => p.status !== 'rejected');
  const r = s.snag_type.photo_rules;
  const out: { path: string; code: string; message: string }[] = [];
  if (live.length < Math.max(r.min_count ?? 1, 1)) out.push({ path: '/photos', code: 'min_count', message: `At least ${Math.max(r.min_count ?? 1, 1)} photo(s) of the fix are needed.` });
  for (const shot of r.shot_types ?? []) if (!live.some((p) => p.shot_type === shot)) out.push({ path: '/photos', code: 'shot_type_missing', message: `A "${shot}" photo is needed.` });
  return out;
};
/** The mock decides who acts: the PM (L2) approves and rejects, everyone else signed in is L1 (the site engineer). */
function view(s: Snag): Snag {
  const missing = missingOf(s);
  const l1 = !isPm(), state = s.state === 'open' || s.state === 'fix_submitted' ? (missing.length ? 'open' : 'fix_submitted') : s.state;
  const actions: NonNullable<Snag['allowed_actions']> = [];
  if ((state === 'open' || state === 'fix_submitted') && l1) { actions.push('upload', 'edit'); if (!missing.length) actions.push('submit'); }
  if (state === 'in_review' && isPm()) actions.push('approve', 'reject');
  return { ...s, state, photos_missing: state === 'open' || state === 'fix_submitted' ? missing : [], allowed_actions: actions };
}
function snagById(id: string): { site: string; s: Snag } | null {
  for (const [site, list] of SNAGS) { const s = list.find((x) => x.id === id); if (s) return { site, s }; }
  return null;
}
function update(id: string, fn: (s: Snag) => Snag): Snag | null {
  const hit = snagById(id);
  if (!hit) return null;
  const next = fn(hit.s);
  SNAGS.set(hit.site, SNAGS.get(hit.site)!.map((x) => (x.id === id ? next : x)));
  return next;
}
const tagged = (s: Snag, status = 200) => HttpResponse.json(view(s), { status, headers: { ETag: `"${s.version}"` } });

export const qcHandlers = [
  // ---- Q130
  http.patch(`${B}/sites/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const id = params.id as string;
    if (siteIndex(id) < 0) return problem(404, 'not_found', 'Site not found');
    if (viewer()!.key === 'viewer') return problem(403, 'action_forbidden', 'You need sites edit in this region');
    const cur = siteCustom.get(id) ?? { custom: {}, version: 1 };
    const m = ifMatchOf(request);
    if (m === 'missing') return problem(428, 'precondition_required', 'If-Match is required');
    if (m !== cur.version) return problem(412, 'precondition_failed', 'The site changed; reload and retry');
    const b = (await request.json().catch(() => ({}))) as { custom?: Record<string, unknown> };
    const errs: { path: string; code: string }[] = [];
    for (const [k, v] of Object.entries(b.custom ?? {})) {
      const f = SITE_FIELDS.find((x) => x.code === k);
      if (!f) errs.push({ path: `/custom/${k}`, code: 'unknown_field' });
      else if (v !== null && typeof v !== 'boolean') errs.push({ path: `/custom/${k}`, code: 'invalid' });
    }
    if (errs.length || !b.custom || !Object.keys(b.custom).length) return fields(...(errs.length ? errs : [{ path: '/custom', code: 'required' }]));
    const custom = { ...cur.custom };
    for (const [k, v] of Object.entries(b.custom)) { if (v === null) delete custom[k]; else custom[k] = v; }
    const next = { custom, version: cur.version + 1 };
    siteCustom.set(id, next);
    return HttpResponse.json(qcSiteDetail(detail(siteIndex(id))), { headers: { ETag: `"${next.version}"` } });
  }),

  // ---- Q131
  http.get(`${B}/registers/:key/records/:id/slots`, ({ params }) => {
    const g = guard(); if (g) return g;
    const list = slotsOfRecord(params.key as string, params.id as string);
    if (list === null) return problem(404, 'not_found', 'Record not found');
    const r = recordOf(params.key as string, params.id as string)!;
    const missing = r.state === 'entry' ? list.filter((s) => s.mandatory && (s.status === 'missing' || s.status === 'rejected')).map((s) => s.doc_code) : [];
    return HttpResponse.json({ items: list, task_id: r.task?.id ?? null, missing_for_submit: missing });
  }),
  http.post(`${B}/registers/:key/records/:id/slots`, () => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/doc_code', code: 'unknown_document' }] })),
  http.post(`${B}/registers/:key/records/:id/slots/:slot/files`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = recordOf(params.key as string, params.id as string);
    const list = slotsOfRecord(params.key as string, params.id as string);
    const slot = list?.find((s) => s.id === params.slot);
    if (!r || !slot) return problem(404, 'not_found', 'Slot not found');
    if (r.state !== 'entry') return problem(409, 'invalid_transition', 'Documents can be uploaded only while the record is in Data Entry');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return fields({ path: '/file', code: 'required' });
    const bad = rejectReason(file.name, slot);
    if (bad) return problem(422, 'file_rejected', 'The file is not accepted', { reason: bad, allowed: slot.formats } as never);
    const stored = recSlots.get(r.entity_id)!;
    const s = stored.find((x) => x.id === slot.id)!;
    const prev = s.files.find((f) => f.is_current);
    const site = siteMeta(r.site_index!);
    const f = {
      id: crypto.randomUUID(), file_group_id: prev?.file_group_id ?? crypto.randomUUID(), version: prev ? prev.version + 1 : 1, is_current: true, original_name: file.name,
      download_name: `${site.code}_PERMITS-HSE_${s.doc_code.replace(/_/g, '-')}_DRAFT-20261102.${(file.name.split('.').pop() ?? 'pdf').toLowerCase()}`, mime_type: file.type || 'application/pdf',
      size_bytes: file.size, sha256: '0'.repeat(64), uploaded_at: new Date().toISOString(), approved_date: null, capture_date: null, unknown_capture_date: false, superseded_by: null, uploaded_by: me(),
    };
    s.files = [...s.files.map((x) => (x.is_current ? { ...x, is_current: false, superseded_by: f.id } : x)), f];
    s.status = 'uploaded'; s.reject_reason = null;
    return HttpResponse.json(f, { status: 201 });
  }),
  http.delete(`${B}/registers/:key/records/:id/slots/:slot/files/:file`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = recordOf(params.key as string, params.id as string);
    const s = r && recSlots.get(r.entity_id)?.find((x) => x.id === params.slot);
    if (!r || !s) return problem(404, 'not_found', 'Slot not found');
    s.files = s.files.map((f) => (f.id === params.file ? { ...f, is_current: false } : f));
    s.status = s.files.some((f) => f.is_current) ? 'uploaded' : 'missing';
    return HttpResponse.json(slotsOfRecord(params.key as string, params.id as string)!.find((x) => x.id === s.id));
  }),

  // ---- Q132
  http.get(`${B}/snag-types`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: TYPES.filter((x) => x.is_active) }); }),
  http.get(`${B}/sites/:id/snags`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (siteIndex(params.id as string) < 0) return problem(404, 'not_found', 'Site not found');
    const st = new URL(request.url).searchParams.get('state');
    const list = (SNAGS.get(params.id as string) ?? []).map(view).filter((s) => !st || s.state === st);
    return HttpResponse.json({ items: list, page: { limit: 200, next_cursor: null }, open_count: list.filter((s) => s.state !== 'closed' && s.state !== 'cancelled').length });
  }),
  http.post(`${B}/sites/:id/snags`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    if (i < 0) return problem(404, 'not_found', 'Site not found');
    const b = (await request.json().catch(() => ({}))) as { snag_type_id?: string; scope?: 'CW' | 'TE'; title?: string; description?: string; task_id?: string };
    const type = TYPES.find((x) => x.id === b.snag_type_id);
    const errs: { path: string; code: string }[] = [];
    if (!type) errs.push({ path: '/snag_type_id', code: 'unknown_snag_type' });
    if (!b.title || b.title.trim().length < 3) errs.push({ path: '/title', code: 'invalid' });
    if (!b.scope && !b.task_id) errs.push({ path: '/scope', code: 'required' });
    if (errs.length) return fields(...errs);
    const s: Snag = {
      id: crypto.randomUUID(), site_id: params.id as string, site_code: siteMeta(i).code, task_id: b.task_id ?? null, scope: b.scope ?? 'CW', snag_type: type!, title: b.title!.trim(),
      description: b.description ?? null, state: 'open', photos: [], photos_required: Math.max(type!.photo_rules.min_count ?? 1, 1), return_count: 0, last_return_note: null,
      raised_by: me(), raised_at: new Date().toISOString(), closed_at: null, version: 1, self_approval: false,
    };
    SNAGS.set(s.site_id, [s, ...(SNAGS.get(s.site_id) ?? [])]);
    return tagged(s, 201);
  }),
  http.get(`${B}/snags/:id`, ({ params }) => { const g = guard(); if (g) return g; const h = snagById(params.id as string); return h ? tagged(h.s) : problem(404, 'not_found', 'Snag not found'); }),
  http.post(`${B}/snags/:id/photos`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const h = snagById(params.id as string);
    if (!h) return problem(404, 'not_found', 'Snag not found');
    const v = view(h.s);
    if (!v.allowed_actions!.includes('upload')) return v.state === 'open' || v.state === 'fix_submitted' ? problem(403, 'not_eligible_holder', 'Only L1 uploads the photos of the fix') : problem(409, 'invalid_transition', 'The snag does not wait for photos');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return fields({ path: '/file', code: 'required' });
    const formats = (h.s.snag_type.photo_rules.formats ?? []).map((x) => x.toLowerCase());
    if (rejectReason(file.name, { formats })) return problem(422, 'file_rejected', 'The photo is not accepted', { reason: 'format_not_allowed', allowed: h.s.snag_type.photo_rules.formats } as never);
    // the mock has no EXIF reader: a photo whose bytes start with "exif:before" stands for one taken before the snag was raised
    if ((await file.text()).startsWith('exif:before')) return problem(422, 'file_rejected', 'The photo was taken before the snag was raised', { reason: 'before_snag_raised' } as never);
    const shot = (form.get('shot_type') as string | null) || null;
    const shots = h.s.snag_type.photo_rules.shot_types ?? [];
    if (shots.length && (!shot || !shots.includes(shot))) return fields({ path: '/shot_type', code: 'unknown_shot_type' });
    const p = { id: crypto.randomUUID(), file_id: '', shot_type: shot, status: 'accepted' as const, reject_reason: null, captured_at: null, unknown_capture_date: true, in_app_camera: false, distance_m: null, geofence_ok: null, uploaded_by: me(), uploaded_at: new Date().toISOString() };
    p.file_id = p.id;
    const next = update(h.s.id, (s) => ({ ...s, photos: [...s.photos!, p], version: s.version + 1 }))!;
    void next;
    return HttpResponse.json(p, { status: 201 });
  }),
  http.delete(`${B}/snags/:id/photos/:photo`, ({ params }) => {
    const g = guard(); if (g) return g;
    const next = update(params.id as string, (s) => ({ ...s, photos: s.photos!.filter((p) => p.id !== params.photo), version: s.version + 1 }));
    return next ? tagged(next) : problem(404, 'not_found', 'Snag not found');
  }),
  ...(['submit', 'review', 'approve', 'reject'] as const).map((op) => http.post(`${B}/snags/:id/${op}`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const h = snagById(params.id as string);
    if (!h) return problem(404, 'not_found', 'Snag not found');
    const m = ifMatchOf(request);
    if (m === 'missing') return problem(428, 'precondition_required', 'If-Match is required');
    if (m !== h.s.version) return problem(412, 'precondition_failed', 'The snag changed; reload and retry');
    if (op === 'review') return problem(409, 'invalid_transition', 'A snag has two levels');
    const v = view(h.s);
    if (!v.allowed_actions!.includes(op)) return problem(v.state === 'closed' ? 409 : 403, v.state === 'closed' ? 'invalid_transition' : 'not_eligible_holder', 'Not possible now');
    const b = (await request.json().catch(() => ({}))) as { note?: string };
    if (op === 'reject' && !(b.note ?? '').trim()) return problem(422, 'note_required', 'A rejection needs a note');
    if (op === 'approve' && !stepUpValid()) return stepUp();
    const next = update(h.s.id, (s) => op === 'submit' ? { ...s, state: 'in_review', version: s.version + 1 }
      : op === 'approve' ? { ...s, state: 'closed', closed_at: new Date().toISOString(), version: s.version + 1 }
        : { ...s, state: 'open', return_count: (s.return_count ?? 0) + 1, last_return_note: b.note!, version: s.version + 1 })!;
    return tagged(next);
  })),
];

/** Test helper: an empty snag store and no edited site field. */
export function resetQcMocks() { SNAGS.clear(); siteCustom.clear(); recSlots.clear(); }
