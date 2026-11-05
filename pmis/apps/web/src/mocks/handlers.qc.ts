// MSW handlers of contract 0.11.1 (migration 0047): the site field near_airport (Q130), document slots on register records (Q131) and QC snag photos (Q132);
// contract 0.12.4 (migration 0056, P6): severities, pending evidence, no self-approval of a snag (D230b) and the documents and QC settings.
// Synthetic data; the checks mirror the contract (the real API reads the bytes and the EXIF date, the mock reads the name).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DocumentSlot, SiteDetail } from '@/api/types';
import type { DocumentsQcSettings, Snag, SnagSeverity, SnagType } from '@/api/qc';
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
// contract 0.12.10 (Q225): near_airport changes the permits, so it is changed by a Change Control proposal, never by PATCH
const SITE_FIELDS = [{ code: 'near_airport', label_en: 'Near an airport', label_ar: 'قريب من مطار', type: 'bool' as const, section: 'Site', required: false, requires_approval: true }];
/** Change Control drafts opened by POST /sites/{id}/change-proposals (mock store). */
export const siteProposals: { site_id: string; field: string; record_id: string; change_id: string; old_value: string; new_value: string; reason: string }[] = [];
const asText = (v: unknown): string => (v === true ? 'Yes' : v === false ? 'No' : v === null || v === undefined ? '(none)' : String(v));

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
  { id: uid('snagtype-QC_GENERAL'), code: 'QC_GENERAL', name_en: 'General QC snag', name_ar: 'ملاحظة جودة عامة', photo_rules: { min_count: 1, shot_types: [], formats: ['JPG', 'PNG', 'HEIC'], max_size_mb: 20 }, stream: null, blocking_rule: 'always', blocks_preliminary_acceptance: true, is_active: true, version: 1 },
  { id: uid('snagtype-CRACK'), code: 'CRACK', name_en: 'Concrete crack', name_ar: 'شرخ خرساني', photo_rules: { min_count: 2, shot_types: ['wide', 'close'], formats: ['JPG'], max_size_mb: 20 }, stream: 'CW', blocking_rule: 'by_severity', blocks_preliminary_acceptance: true, is_active: true, version: 1 },
];
// ---------------------------------------------------------------- P6 (contract 0.12.4): severities (Q233) and the documents / QC settings (Q229, Q232)
const SEVERITIES_SEED: SnagSeverity[] = [
  { code: 'CRITICAL', name_en: 'Critical', name_ar: 'حرجة', blocks: true, is_active: true },
  { code: 'MAJOR', name_en: 'Major', name_ar: 'رئيسية', blocks: true, is_active: true },
  { code: 'MINOR', name_en: 'Minor', name_ar: 'ثانوية', blocks: false, is_active: true },
];
let severities = { items: SEVERITIES_SEED.map((x) => ({ ...x })), version: 1 };
const SETTINGS_SEED: DocumentsQcSettings = {
  new_version_inherit: false, exif_tolerance_hours: 24, exif_time_zone: 'Africa/Tripoli',
  scan: { mode: 'clamd', on_failure: 'fail_closed', uploads: true, generated_exports: false, zip_leaves_out_unscanned: true }, version: 1, updated_at: null,
};
let qcSettings: DocumentsQcSettings = { ...SETTINGS_SEED };
const SNAGS = new Map<string, Snag[]>();
const me = () => { const v = viewer()!; return { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? null }; };
const missingOf = (s: Snag) => {
  const live = s.photos!.filter((p) => p.status === 'accepted');
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
  // D230b: whoever raised, found or fixed the snag never approves its closure
  const mine = [s.raised_by?.id, s.found_by?.id, s.fixed_by?.id].includes(me().id);
  if (state === 'in_review' && isPm() && !mine) actions.push('approve', 'reject');
  if (isPm() && !mine && state !== 'closed' && state !== 'cancelled' && s.photos!.some((p) => p.status === 'pending_evidence')) actions.push('decide_evidence');
  const sev = severities.items.find((x) => x.code === s.severity);
  return { ...s, state, photos_missing: state === 'open' || state === 'fix_submitted' ? missing : [], allowed_actions: actions,
    approval_blocked: state === 'in_review' && isPm() && mine ? 'self_approval_forbidden' : null, severity_missing: !s.severity,
    severity_label: sev ? { name_en: sev.name_en, name_ar: sev.name_ar ?? null } : null };
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
      else if (f.requires_approval && (cur.custom[k] ?? null) !== v) errs.push({ path: `/custom/${k}`, code: 'approval_required' });
    }
    if (errs.length || !b.custom || !Object.keys(b.custom).length) return fields(...(errs.length ? errs : [{ path: '/custom', code: 'required' }]));
    const custom = { ...cur.custom };
    for (const [k, v] of Object.entries(b.custom)) { if (v === null) delete custom[k]; else custom[k] = v; }
    const next = { custom, version: cur.version + 1 };
    siteCustom.set(id, next);
    return HttpResponse.json(qcSiteDetail(detail(siteIndex(id))), { headers: { ETag: `"${next.version}"` } });
  }),

  // ---- Q225 (contract 0.12.10): one Change Control draft per field; the site keeps its value until L2 approves.
  // ---- Q473 (contract 0.14.1): the identity of the site (names, coordinates, region, cluster) is proposed the same way; region and cluster are for a System Admin.
  http.post(`${B}/sites/:id/change-proposals`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const id = params.id as string;
    if (siteIndex(id) < 0) return problem(404, 'not_found', 'Site not found');
    if (viewer()!.key === 'viewer') return problem(403, 'action_forbidden', 'You need the Change Control create right in this region');
    const cur = siteCustom.get(id) ?? { custom: {}, version: 1 };
    const b = (await request.json().catch(() => ({}))) as { custom?: Record<string, unknown>; identity?: Record<string, unknown>; reason?: string };
    // Q473: region and cluster change who can see the site: a System Admin only, before any other check
    if (b.identity && ('region_id' in b.identity || 'cluster_code' in b.identity) && !isPm()) return problem(403, 'action_forbidden', 'Only a System Admin proposes or approves a change of the region or the cluster.');
    const errs: { path: string; code: string }[] = [];
    if (!b.reason?.trim()) errs.push({ path: '/reason', code: 'required' });
    for (const [k, v] of Object.entries(b.custom ?? {})) {
      const f = SITE_FIELDS.find((x) => x.code === k);
      if (!f) errs.push({ path: `/custom/${k}`, code: 'unknown_field' });
      else if (!f.requires_approval) errs.push({ path: `/custom/${k}`, code: 'no_approval_needed' });
      else if ((cur.custom[k] ?? null) === v) errs.push({ path: `/custom/${k}`, code: 'unchanged' });
    }
    const drafts: { field: string; old_value: string; new_value: string }[] = [];
    if (b.identity) {
      const idn = b.identity, site = detail(siteIndex(id)), m = siteMeta(siteIndex(id));
      const bad = (path: string, code: string) => errs.push({ path: `/identity/${path}`, code });
      for (const k of Object.keys(idn)) if (!['name', 'name_ar', 'latitude', 'longitude', 'region_id', 'cluster_code', 'site_code'].includes(k)) bad(k, 'unknown_field');
      if ('site_code' in idn) bad('site_code', 'immutable');                                 // the Site ID never changes
      if ('name' in idn) {
        const v = String(idn.name ?? '').trim();
        if (!v) bad('name', 'required'); else if (v.length > 200) bad('name', 'too_long'); else if (v === site.name) bad('name', 'unchanged');
        else drafts.push({ field: 'name', old_value: site.name, new_value: v });
      }
      if ('name_ar' in idn) {
        const v = idn.name_ar === null ? '' : String(idn.name_ar).trim(), was = site.name_ar ?? '';
        if (v.length > 200) bad('name_ar', 'too_long'); else if (v === was) bad('name_ar', 'unchanged');
        else drafts.push({ field: 'name_ar', old_value: was || '(none)', new_value: v || '(none)' });
      }
      if ('latitude' in idn || 'longitude' in idn) {
        const lat = idn.latitude, lon = idn.longitude;
        const none = (v: unknown) => v === undefined || v === null || v === '';
        if (none(lat) || none(lon)) bad(none(lat) ? 'latitude' : 'longitude', 'pair_required');
        else if (typeof lat !== 'number' || typeof lon !== 'number') bad(typeof lat === 'number' ? 'longitude' : 'latitude', 'invalid');
        else if (Math.abs(lat) > 90) bad('latitude', 'invalid');
        else if (Math.abs(lon) > 180) bad('longitude', 'invalid');
        else drafts.push({ field: 'coordinates', old_value: site.latitude == null ? '(none)' : `${site.latitude.toFixed(6)}, ${(site.longitude ?? 0).toFixed(6)}`, new_value: `${lat.toFixed(6)}, ${lon.toFixed(6)}` });
      }
      if ('region_id' in idn || 'cluster_code' in idn) {
        const REG = ['TR', 'MI', 'WM', 'ZW', 'BG', 'GM', 'SB'];
        const target = 'region_id' in idn ? Number(idn.region_id) : site.region_id;
        const code = 'cluster_code' in idn ? (idn.cluster_code === null || idn.cluster_code === '' ? null : String(idn.cluster_code)) : undefined;
        const fits = (c: string) => c.startsWith('GLOBAL') || c === `CL-${REG[target - 1]}-${c.slice(-1)}`;
        if ('region_id' in idn && !(Number.isInteger(target) && target >= 1 && target <= 7)) bad('region_id', 'unknown_region');
        else if ('region_id' in idn && target === site.region_id && code === undefined) bad('region_id', 'unchanged');
        else if (code && !/^(CL-[A-Z]{2}-\d|GLOBAL.*)$/.test(code)) bad('cluster_code', 'unknown_cluster');
        else if (code && !fits(code)) bad('cluster_code', 'cluster_other_region');
        else if ('region_id' in idn && target !== site.region_id) {
          const keep = code === undefined ? (m.cluster as string) : code;
          if (keep && !fits(keep)) bad('cluster_code', 'cluster_other_region');
          else drafts.push({ field: 'region', old_value: `${REG[site.region_id - 1]} / ${m.cluster}`, new_value: `${REG[target - 1]} / ${keep || '(none)'}` });
        } else if (code !== undefined) {
          if ((code ?? '(none)') === m.cluster) bad('cluster_code', 'unchanged'); else drafts.push({ field: 'cluster', old_value: m.cluster as string, new_value: code ?? '(none)' });
        }
      }
      if (Object.keys(idn).length === 0) errs.push({ path: '/identity', code: 'required' });
    }
    if (!b.custom && !b.identity) errs.push({ path: '/custom', code: 'required' });
    if (errs.length) return fields(...errs);
    const items = [
      ...drafts.map((d) => ({ ...d })),
      ...Object.entries(b.custom ?? {}).map(([k, v]) => ({ field: k, old_value: asText(cur.custom[k]), new_value: asText(v) })),
    ].map((d, i) => {
      const it = { ...d, record_id: `cc000000-0000-4000-8000-${String(siteProposals.length + i + 1).padStart(12, '0')}`, change_id: `SFC-${d.field.toUpperCase()}-${siteProposals.length + i + 1}` };
      siteProposals.push({ ...it, site_id: id, reason: b.reason!.trim() });
      return it;
    });
    return HttpResponse.json({ items }, { status: 201 });
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
    const b = (await request.json().catch(() => ({}))) as { snag_type_id?: string; scope?: 'CW' | 'TE'; title?: string; description?: string; task_id?: string; severity?: string };
    const type = TYPES.find((x) => x.id === b.snag_type_id);
    const errs: { path: string; code: string }[] = [];
    if (!type) errs.push({ path: '/snag_type_id', code: 'unknown_snag_type' });
    if (!b.title || b.title.trim().length < 3) errs.push({ path: '/title', code: 'invalid' });
    if (!b.scope && !b.task_id) errs.push({ path: '/scope', code: 'required' });
    const sev = severities.items.find((x) => x.is_active && (x.code === (b.severity ?? '').toUpperCase() || x.name_en.toLowerCase() === (b.severity ?? '').toLowerCase()));
    if (!b.severity) errs.push({ path: '/severity', code: 'required' });
    else if (!sev) errs.push({ path: '/severity', code: 'unknown_severity' });
    if (type?.stream && b.scope && type.stream !== b.scope) errs.push({ path: '/snag_type_id', code: 'wrong_stream' });
    if (errs.length) return fields(...errs);
    const s: Snag = {
      id: crypto.randomUUID(), site_id: params.id as string, site_code: siteMeta(i).code, task_id: b.task_id ?? null, scope: b.scope ?? 'CW', snag_type: type!, title: b.title!.trim(),
      description: b.description ?? null, state: 'open', photos: [], photos_required: Math.max(type!.photo_rules.min_count ?? 1, 1), return_count: 0, last_return_note: null,
      raised_by: me(), found_by: me(), raised_at: new Date().toISOString(), closed_at: null, version: 1, self_approval: false, severity: sev?.code ?? null,
      blocks_acceptance: type!.blocking_rule === 'always' || (type!.blocking_rule === 'by_severity' && (sev?.blocks ?? true)), register_record: null,
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
    const head = await file.text();
    if (head.startsWith('exif:before')) return problem(422, 'file_rejected', 'The photo was taken before the snag was raised', { reason: 'before_snag_raised' } as never);
    // "exif:future" stands for a photo dated in the future beyond the tolerance (Q232): kept as pending evidence
    const future = head.startsWith('exif:future');
    const shot = (form.get('shot_type') as string | null) || null;
    const shots = h.s.snag_type.photo_rules.shot_types ?? [];
    if (shots.length && (!shot || !shots.includes(shot))) return fields({ path: '/shot_type', code: 'unknown_shot_type' });
    const p = { id: crypto.randomUUID(), file_id: '', shot_type: shot, status: (future ? 'pending_evidence' : 'accepted') as 'accepted' | 'pending_evidence', reject_reason: null,
      evidence_note: future ? 'EXIF date in the future beyond the tolerance' : null, captured_at: null, unknown_capture_date: true, in_app_camera: false, distance_m: null, geofence_ok: null, uploaded_by: me(), uploaded_at: new Date().toISOString() };
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
  http.post(`${B}/snags/:id/photos/:photo/evidence`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const h = snagById(params.id as string);
    if (!h) return problem(404, 'not_found', 'Snag not found');
    const b = (await request.json().catch(() => ({}))) as { decision?: string; note?: string };
    if (!['accept', 'reject'].includes(b.decision ?? '') || (b.note ?? '').trim().length < 3) return fields({ path: '/note', code: 'required' });
    const v = view(h.s);
    if (!v.allowed_actions!.includes('decide_evidence')) return problem(403, v.approval_blocked || [h.s.raised_by?.id, h.s.fixed_by?.id].includes(me().id) ? 'self_approval_forbidden' : 'not_eligible_holder', 'Only L2 decides');
    // contract 0.13.2 (Q265): accepting the evidence needs step-up, like the closure; rejecting does not
    if (b.decision === 'accept' && !stepUpValid()) return stepUp();
    const next = update(h.s.id, (s) => ({ ...s, version: s.version + 1, photos: s.photos!.map((p) => p.id !== params.photo ? p
      : { ...p, status: b.decision === 'accept' ? 'accepted' : 'rejected', evidence_note: b.note!.trim(), reject_reason: b.decision === 'accept' ? null : b.note!.trim() }) }))!;
    return tagged(next);
  }),
  http.get(`${B}/snag-severities`, () => { const g = guard(); if (g) return g; return HttpResponse.json(severities, { headers: { ETag: `"${severities.version}"` } }); }),
  http.put(`${B}/snag-severities`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isPm()) return problem(403, 'action_forbidden', 'Only the admin edits the catalogue');
    const m = ifMatchOf(request);
    if (m === 'missing') return problem(428, 'precondition_required', 'If-Match is required');
    if (m !== severities.version) return problem(412, 'precondition_failed', 'The severities changed');
    const b = (await request.json().catch(() => ({}))) as { reason?: string; items?: SnagSeverity[] };
    if (!b.reason || b.reason.trim().length < 3 || !Array.isArray(b.items) || !b.items.length) return fields({ path: '/items', code: 'required' });
    const gone = severities.items.filter((x) => !b.items!.some((y) => y.code === x.code));
    if (gone.length) return fields(...gone.map((x) => ({ path: '/items', code: 'cannot_remove', message: `The severity ${x.code} cannot be removed: deactivate it.` })));
    severities = { items: b.items.map((x) => ({ ...x, is_active: x.is_active ?? true })), version: severities.version + 1 };
    return HttpResponse.json(severities, { headers: { ETag: `"${severities.version}"` } });
  }),
  http.get(`${B}/settings/documents-qc`, () => { const g = guard(); if (g) return g; return HttpResponse.json(qcSettings, { headers: { ETag: `"${qcSettings.version}"` } }); }),
  http.put(`${B}/settings/documents-qc`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isPm()) return problem(403, 'action_forbidden', 'Only the admin changes the settings');
    const m = ifMatchOf(request);
    if (m === 'missing') return problem(428, 'precondition_required', 'If-Match is required');
    if (m !== qcSettings.version) return problem(412, 'precondition_failed', 'The settings changed');
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const unknown = Object.keys(b).filter((k) => !['reason', 'new_version_inherit', 'exif_tolerance_hours'].includes(k));
    if (unknown.length) return fields(...unknown.map((k) => ({ path: `/${k}`, code: 'unknown_key' })));
    const h = b.exif_tolerance_hours;
    if (h !== undefined && (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 168)) return fields({ path: '/exif_tolerance_hours', code: 'out_of_range' });
    qcSettings = { ...qcSettings, ...(typeof b.new_version_inherit === 'boolean' ? { new_version_inherit: b.new_version_inherit } : {}), ...(typeof h === 'number' ? { exif_tolerance_hours: h } : {}),
      version: qcSettings.version + 1, updated_at: new Date().toISOString() };
    return HttpResponse.json(qcSettings, { headers: { ETag: `"${qcSettings.version}"` } });
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
    if (op === 'approve' && v.approval_blocked) return problem(403, 'self_approval_forbidden', 'You raised, found or fixed this snag');
    if (op === 'approve' && !stepUpValid()) return stepUp();
    const next = update(h.s.id, (s) => op === 'submit' ? { ...s, state: 'in_review', fixed_by: me(), version: s.version + 1 }
      : op === 'approve' ? { ...s, state: 'closed', closed_at: new Date().toISOString(), approved_by: me(), version: s.version + 1 }
        : { ...s, state: 'open', return_count: (s.return_count ?? 0) + 1, last_return_note: b.note!, version: s.version + 1 })!;
    return tagged(next);
  })),
];

/** Test helper: an empty snag store and no edited site field. */
export function resetQcMocks() {
  SNAGS.clear(); siteCustom.clear(); recSlots.clear(); siteProposals.length = 0;
  severities = { items: SEVERITIES_SEED.map((x) => ({ ...x })), version: 1 };
  qcSettings = { ...SETTINGS_SEED };
}
