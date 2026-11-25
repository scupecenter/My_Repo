import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import { stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';

/**
 * Contract 0.15.43 (Workflow Studio S2): the Site Master columns an admin manages. A small synthetic set in the shape of `GET /site-master/columns`:
 * original columns (some protected, some filled by a task input), and added columns after GE (never held a value, holds values, deactivated).
 * Only the System Admin (account `pm`) writes; every write checks the reason, the column's version (If-Match) and the step-up, in that order.
 */
type Type = 'text' | 'number' | 'date' | 'list' | 'yes_no';
interface Col {
  ord: number; display_order: number; group_top: string | null; group_mid: string | null; name_en: string | null; name_ar: string | null; value_type: Type; list_catalogue: string | null;
  source: { kind: string; note: string | null; task_code?: string; field_key?: string; input_label?: string; input_read_only?: boolean; site_field_id?: string; site_field_code?: string; site_field_label?: string };
  sections: string[]; is_protected: boolean; protected_reason: string | null; is_added: boolean; is_active: boolean; version: number; values: { site_code: string; value: string }[];
}
export const SITE_FIELD_ID = 'f1000000-0000-4000-8000-000000000001';
export const SITE_FIELD_USED_ID = 'f1000000-0000-4000-8000-000000000002';

/** The letter of a Master order: 1 = A, 26 = Z, 27 = AA, 187 = GE, 188 = GF. */
export const letterOf = (n: number): string => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
const task = (code: string, key: string, label: string, ro = false) => ({ kind: 'task', note: null, task_code: code, field_key: key, input_label: label, input_read_only: ro });
const col = (ord: number, top: string, mid: string | null, en: string, o: Partial<Col> = {}): Col => ({
  ord, display_order: ord, group_top: top, group_mid: mid, name_en: en, name_ar: null, value_type: 'text', list_catalogue: null, source: { kind: 'site', note: null }, sections: ['design_acq'],
  is_protected: false, protected_reason: null, is_added: false, is_active: true, version: 1, values: [], ...o,
});
const seed = (): Col[] => [
  col(1, '#', null, '#', { is_protected: true, protected_reason: 'The row number is calculated.', source: { kind: 'derived', note: null } }),
  col(2, 'RF & DESIGN', 'Identification', 'Site ID', { is_protected: true, protected_reason: 'The Site ID is the key of the site.' }),
  col(14, 'RF & DESIGN', 'Survey', 'SAR Planned Date', { name_ar: 'تاريخ التخطيط لتقرير المسح', value_type: 'date', source: task('A1', 'planned_date', 'Planned date'), values: [{ site_code: 'TRP-0001', value: '2026-03-01' }, { site_code: 'TRP-0002', value: '2026-03-09' }] }),
  col(15, 'RF & DESIGN', 'Survey', 'SAR Status', { name_ar: 'حالة تقرير المسح', value_type: 'list', list_catalogue: 'ActionStatus', source: task('A1', 'v:sar_status', 'SAR status'), sections: ['design_acq', 'sow'], values: [{ site_code: 'TRP-0001', value: 'Done' }, { site_code: 'TRP-0002', value: 'Open' }, { site_code: 'TRP-0003', value: 'Blocked' }] }),
  col(16, 'RF & DESIGN', 'Survey', 'SAR Approved Date', { value_type: 'date', is_protected: true, protected_reason: 'A milestone date: the workflow fills it.', source: task('A1', 'approved_date', 'Approved date', true) }),
  col(17, 'RF & DESIGN', 'Survey', 'SAR Surveyor Notes', { source: task('A1', 'v:surveyor_notes', 'Surveyor notes'), values: [{ site_code: 'TRP-0001', value: 'Access by the north gate' }] }),
  col(18, 'RF & DESIGN', 'TSSR', 'TSSR Planned Date', { value_type: 'date', source: task('A2', 'planned_date', 'Planned date') }),
  col(78, 'TE INSTALLATION', 'TE Access', 'TE Access Date', { value_type: 'date', is_protected: true, protected_reason: 'Fed by the TE register.', source: { kind: 'register', note: null }, sections: ['te'] }),
  col(187, 'STATUS', null, 'Overall Status', { is_protected: true, protected_reason: 'The status columns are calculated.', sections: ['status'], source: { kind: 'derived', note: null } }),
  col(188, 'RF & DESIGN', 'Design', 'LLD Reviewer Notes', { display_order: 15.5, is_added: true, name_ar: 'ملاحظات مراجع التصميم', source: task('A4', 'v:lld_reviewer_notes', 'LLD reviewer notes'), sections: ['design_acq'] }),
  col(189, 'RF & DESIGN', 'Design', 'LLD Vendor Rating', { display_order: 15.6, is_added: true, value_type: 'list', list_catalogue: 'RiskStatus', source: task('A4', 'v:lld_vendor_rating', 'LLD vendor rating'), sections: ['design_acq', 'sow'], values: [{ site_code: 'TRP-0001', value: 'Open' }, { site_code: 'TRP-0002', value: 'Closed' }, { site_code: 'TRP-0003', value: 'Excellent' }] }),
  col(190, 'RF & DESIGN', 'Design', 'LLD Old Remark', { display_order: 15.7, is_added: true, is_active: false, source: task('A4', 'v:lld_old_remark', 'LLD old remark'), values: [{ site_code: 'TRP-0004', value: 'Superseded' }] }),
  col(191, 'PRE-CW', 'Project', 'Near Airport', { display_order: 24.5, is_added: true, source: { kind: 'custom_field', note: null, site_field_id: SITE_FIELD_USED_ID, site_field_code: 'near_airport', site_field_label: 'Near airport' }, sections: ['sow'] }),
];
let cols = seed();
export const resetSiteColumnsMock = () => { cols = seed(); };

const canEdit = () => viewer()?.key === 'pm';
const reasonOk = (b: { reason?: unknown }) => typeof b.reason === 'string' && b.reason.trim().length >= 3;
const fieldErr = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });
const ordered = () => [...cols].sort((a, b) => a.display_order - b.display_order);
const admin = (c: Col) => ({
  ord: c.ord, letter: letterOf(c.ord), display_order: c.display_order, group_top: c.group_top, group_mid: c.group_mid, name_en: c.name_en, name_ar: c.name_ar,
  header: `${c.group_mid ?? c.group_top ?? ''} / ${c.name_en ?? ''}`, value_type: c.value_type, list_catalogue: c.list_catalogue, source: c.source, sections: c.sections,
  is_protected: c.is_protected, protected_reason: c.protected_reason, is_added: c.is_added, is_active: c.is_active, version: c.version,
});
const detail = (c: Col) => ({ ...admin(c), value_count: c.is_protected ? null : c.values.length, delete_mode: c.is_protected ? 'blocked' : c.is_added && c.values.length === 0 ? 'hard' : 'deactivate' });
const one = (c: Col, status = 200) => HttpResponse.json(detail(c), { status, headers: { ETag: `"${c.version}"` } });

/** How many stored values would not fit the new type or list (the rules of the contract: number, date, yes or no, a value of the list). */
const ACTIVE_VALUES: Record<string, string[]> = { ActionStatus: ['Open', 'In Progress', 'Done', 'Cancelled'], RiskStatus: ['Open', 'Monitoring', 'Closed', 'Materialized'], Severity: ['CRITICAL', 'MAJOR', 'MINOR'] };
function preview(c: Col, type: Type, list: string | null) {
  const bad = (v: string): 'not_a_number' | 'not_a_date' | 'not_yes_no' | 'not_in_list' | null => {
    if (type === 'number') return /^[+-]?\d+(\.\d+)?$/.test(v) ? null : 'not_a_number';
    if (type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(v) ? null : 'not_a_date';
    if (type === 'yes_no') return ['yes', 'no', 'true', 'false', 'y', 'n', '1', '0'].includes(v.toLowerCase()) ? null : 'not_yes_no';
    if (type === 'list') return (ACTIVE_VALUES[list ?? ''] ?? []).some((x) => x.toLowerCase() === v.toLowerCase()) ? null : 'not_in_list';
    return null;
  };
  const samples = c.values.flatMap((x) => { const r = bad(x.value); return r ? [{ site_code: x.site_code, value: x.value, reason: r }] : []; });
  return { ord: c.ord, letter: letterOf(c.ord), from_type: c.value_type, to_type: type, from_list: c.list_catalogue, to_list: list, total_values: c.values.length, convertible: c.values.length - samples.length, not_convertible: samples.length, samples };
}

/** The shared gate of every write: signed in, admin, column found, reason, ETag, step-up. */
function gate(params: Record<string, string | readonly string[] | undefined>, request: Request, body: { reason?: unknown }, versioned = true): { c: Col } | { r: Response } {
  const g = guard(); if (g) return { r: g };
  if (!canEdit()) return { r: problem(403, 'action_forbidden', 'You need edit on fields.') };
  const c = cols.find((x) => x.ord === Number(params.ord));
  if (!c) return { r: problem(404, 'not_found', 'The column does not exist.') };
  if (!reasonOk(body)) return { r: fieldErr('/reason', 'required') };
  if (versioned) {
    const m = request.headers.get('If-Match');
    if (!m) return { r: problem(428, 'precondition_required', 'If-Match is required') };
    if (m.replace(/"/g, '') !== String(c.version)) return { r: problem(412, 'precondition_failed', 'The column changed since you read it. Reload and try again.') };
  }
  if (!stepUpValid()) return { r: stepUp() };
  return { c };
}
const readGate = () => { const g = guard(); if (g) return g; if (!canEdit()) return problem(403, 'action_forbidden', 'You need edit on fields.'); return null; };
const MENUS = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'];

export const siteColumnHandlers = [
  http.get(`${B}/site-master/columns`, ({ request }) => {
    const r = readGate(); if (r) return r;
    const all = new URL(request.url).searchParams.get('include_inactive') !== 'false';
    const items = ordered().filter((c) => all || c.is_active);
    const bands: { name: string | null; groups: (string | null)[] }[] = [];
    for (const c of items.filter((x) => x.is_active)) {
      let b = bands.find((x) => x.name === c.group_top);
      if (!b) { b = { name: c.group_top, groups: [] }; bands.push(b); }
      if (!b.groups.includes(c.group_mid)) b.groups.push(c.group_mid);
    }
    return HttpResponse.json({ items: items.map(admin), bands, types: ['text', 'number', 'date', 'list', 'yes_no'] });
  }),
  http.post(`${B}/site-master/columns`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'You need edit on fields.');
    const b = (await request.json()) as { name_en?: string; name_ar?: string | null; group_top?: string; group_mid?: string | null; after_ord?: number; value_type?: Type; list_catalogue?: string | null; sections?: string[]; reason?: string; source?: { kind: string; task_code?: string; field_key?: string; field_id?: string } };
    if (!reasonOk(b)) return fieldErr('/reason', 'required');
    if (!b.name_en?.trim()) return fieldErr('/name_en', 'required');
    if (!b.group_top?.trim()) return fieldErr('/group_top', 'required');
    if (['#', 'Phase Gate', 'STATUS'].includes(b.group_top)) return fieldErr('/group_top', 'reserved_band');
    const after = cols.find((x) => x.ord === b.after_ord);
    if (!after) return fieldErr('/after_ord', 'unknown_column');
    const type = b.value_type ?? 'text';
    if (type === 'list' && !b.list_catalogue) return fieldErr('/list_catalogue', 'list_required');
    if (type !== 'list' && b.list_catalogue) return fieldErr('/list_catalogue', 'list_not_allowed');
    if (b.source?.kind === 'task_input') {
      if (!['A1', 'A2', 'A4', 'B1', 'B2'].includes(b.source.task_code ?? '')) return fieldErr('/source/task_code', 'unknown_task');
      if (b.source.field_key && cols.some((x) => x.source.task_code === b.source!.task_code && x.source.field_key === b.source!.field_key)) return problem(409, 'input_already_mapped', 'This input already feeds a column.');
    } else if (b.source?.kind === 'site_field') {
      if (b.source.field_id === SITE_FIELD_USED_ID) return problem(409, 'field_already_mapped', 'This field already feeds a column.');
      if (b.source.field_id !== SITE_FIELD_ID) return fieldErr('/source/field_id', 'unknown_field');
    } else return fieldErr('/source', 'required');
    if (cols.some((x) => x.group_top === b.group_top && x.group_mid === (b.group_mid ?? null) && (x.name_en ?? '').toLowerCase() === b.name_en!.trim().toLowerCase())) return problem(409, 'duplicate', 'A column with this header exists.');
    if (!stepUpValid()) return stepUp();
    const ord = Math.max(187, ...cols.map((x) => x.ord)) + 1;
    const src = b.source.kind === 'task_input'
      ? { kind: 'task', note: null, task_code: b.source.task_code, field_key: b.source.field_key ?? `v:${b.name_en.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, input_label: b.name_en.trim(), input_read_only: false }
      : { kind: 'custom_field', note: null, site_field_id: b.source.field_id, site_field_code: 'site_field', site_field_label: 'Site field' };
    const c: Col = col(ord, b.group_top, b.group_mid ?? null, b.name_en.trim(), { display_order: after.display_order + 0.01, is_added: true, name_ar: b.name_ar ?? null, value_type: type, list_catalogue: b.list_catalogue ?? null, source: src, sections: b.sections ?? after.sections.filter((s) => s !== 'status') });
    cols.push(c);
    return one(c, 201);
  }),
  http.get(`${B}/site-master/columns/:ord`, ({ params }) => {
    const r = readGate(); if (r) return r;
    const c = cols.find((x) => x.ord === Number(params.ord));
    return c ? one(c) : problem(404, 'not_found', 'The column does not exist.');
  }),
  http.patch(`${B}/site-master/columns/:ord/sections`, async ({ params, request }) => {
    const b = (await request.json()) as { sections?: string[]; reason?: string };
    const k = gate(params, request, b, false); if ('r' in k) return k.r;
    if (k.c.sections.includes('status') || !b.sections?.length || b.sections.some((s) => !MENUS.includes(s))) return fieldErr('/sections', 'invalid');
    k.c.sections = [...b.sections]; k.c.version += 1;
    return HttpResponse.json({ ord: k.c.ord, letter: letterOf(k.c.ord), group_top: k.c.group_top, group_mid: k.c.group_mid, header: admin(k.c).header, sections: k.c.sections, is_phase_gate: false });
  }),
  http.patch(`${B}/site-master/columns/:ord`, async ({ params, request }) => {
    const b = (await request.json()) as { name_en?: string; name_ar?: string | null; value_type?: Type; list_catalogue?: string | null; group_top?: string; group_mid?: string | null; after_ord?: number; confirm_unconvertible?: boolean; reason?: string };
    const k = gate(params, request, b); if ('r' in k) return k.r;
    const c = k.c;
    const keys = Object.keys(b).filter((x) => x !== 'reason' && x !== 'confirm_unconvertible');
    if (keys.length === 0) return problem(409, 'invalid_transition', 'Nothing to change.');
    if (c.is_protected && keys.some((x) => x !== 'name_en' && x !== 'name_ar')) return problem(409, 'system_field', 'This column is protected: only its name and menus can change.');
    const type = b.value_type ?? c.value_type;
    const list = b.list_catalogue !== undefined ? b.list_catalogue : type === 'list' ? c.list_catalogue : null;
    if (type === 'list' && !list) return fieldErr('/list_catalogue', 'list_required');
    if (type !== 'list' && list) return fieldErr('/list_catalogue', 'list_not_allowed');
    if (c.source.input_read_only && type !== 'date' && c.source.field_key !== 'external_party') return fieldErr('/value_type', 'type_follows_source');
    if (b.value_type !== undefined || b.list_catalogue !== undefined) {
      const p = preview(c, type, list);
      if (p.not_convertible > 0 && !b.confirm_unconvertible) return problem(409, 'conversion_unconfirmed', 'Some values do not fit the new type.', { conversion: p } as never);
    }
    if (!stepUpValid()) return stepUp();
    if (b.name_en !== undefined) c.name_en = b.name_en;
    if (b.name_ar !== undefined) c.name_ar = b.name_ar;
    c.value_type = type; c.list_catalogue = type === 'list' ? list : null; c.version += 1;
    return one(c);
  }),
  http.delete(`${B}/site-master/columns/:ord`, ({ params, request }) => {
    const k = gate(params, request, { reason: new URL(request.url).searchParams.get('reason') }); if ('r' in k) return k.r;
    if (!k.c.is_added) return problem(409, 'system_field', 'An original column is never deleted.');
    if (k.c.values.length) return problem(409, 'column_in_use', 'The column holds values: deactivate it.', { why: 'has_values', count: k.c.values.length } as never);
    cols = cols.filter((x) => x.ord !== k.c.ord);
    return HttpResponse.json({ ord: k.c.ord, letter: letterOf(k.c.ord), deleted: true, removed_input: k.c.source.kind === 'task' });
  }),
  http.post(`${B}/site-master/columns/:ord/type-preview`, async ({ params, request }) => {
    const r = readGate(); if (r) return r;
    const c = cols.find((x) => x.ord === Number(params.ord));
    if (!c) return problem(404, 'not_found', 'The column does not exist.');
    const b = (await request.json()) as { value_type?: Type; list_catalogue?: string | null };
    if (!b.value_type) return fieldErr('/value_type', 'required');
    return HttpResponse.json(preview(c, b.value_type, b.list_catalogue ?? null));
  }),
  http.post(`${B}/site-master/columns/:ord/deactivate`, async ({ params, request }) => {
    const k = gate(params, request, (await request.json()) as { reason?: string }); if ('r' in k) return k.r;
    if (k.c.is_protected) return problem(409, 'system_field', 'A protected column cannot be deactivated.');
    if (!k.c.is_active) return problem(409, 'invalid_transition', 'The column is inactive already.');
    k.c.is_active = false; k.c.version += 1;
    return one(k.c);
  }),
  http.post(`${B}/site-master/columns/:ord/reactivate`, async ({ params, request }) => {
    const k = gate(params, request, (await request.json()) as { reason?: string }); if ('r' in k) return k.r;
    if (k.c.is_active) return problem(409, 'invalid_transition', 'The column is active already.');
    k.c.is_active = true; k.c.version += 1;
    return one(k.c);
  }),
  // The site custom fields the Studio offers as a source (one carries a Master column already)
  http.get(`${B}/custom-fields`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (new URL(request.url).searchParams.get('entity_type') !== 'site') return HttpResponse.json({ items: [] });
    const f = (id: string, code: string, en: string, master: string | null) => ({ id, entity_type: 'site', code, label_en: en, label_ar: null, data_type: 'text', master_export_column: master, is_active: true, version: 1 });
    return HttpResponse.json({ items: [f(SITE_FIELD_ID, 'tower_owner', 'Tower owner', null), f(SITE_FIELD_USED_ID, 'near_airport', 'Near airport', 'GH')] });
  }),
];
