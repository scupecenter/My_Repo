// MSW handlers for /warehouse/* and /as-built/items, following contracts/openapi.yaml 0.4.8. Writes need the System Admin account (the mock `pm`).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { db, viewer } from './db';
import { guard, page, problem } from './handlers';
import { uid } from './ids';
import { SITE_COUNT, siteIndex, siteMeta } from './sites';
import { dispatchOf } from './warehouseData';

const B = API_BASE;
const W = () => db().wh;
const tag = (v: number) => ({ headers: { ETag: `"${v}"` } });
const SEQ_EDITS = new Map<string, Record<string, unknown>>();
const VENDORS = new Map<number, { v: string | null; n: number }>();
const admin = () => viewer()?.key === 'pm';
const has = (q: string, ...s: (string | null | undefined)[]) => !q || s.join(' ').toLowerCase().includes(q.toLowerCase());
const stale = (req: Request, v: number) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === v ? null : problem(412, 'precondition_failed', 'The item changed; reload and retry');
};
type Body = Record<string, unknown> & { reason?: string };
const bad = (b: Body) => String(b.reason ?? '').trim().length < 3 ? problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] }) : null;

/** P6: the extra columns of the item master (mock of field_definitions of the warehouse item). */
type MockCol = { code: string; label_en: string; label_ar: string | null; data_type: string; required: boolean; section: string | null; sort_order: number; in_templates: boolean; in_exports: boolean; in_list_filters: boolean; is_active: boolean; version: number; has_values: boolean };
const itemCols: MockCol[] = [];

/** 0565: the entity locks of the Warehouse and the Daily Plan (in memory, reset with the module). */
const ENT_LOCKS: { id: string; kind: string; target_id: string; reason: string; locked_at: string; locked_by: string | null; label: string | null }[] = [];
const ENT_COLS: { id: string; kind: string; field: string; reason: string; locked_at: string; locked_by: string | null }[] = [];

export const warehouseHandlers = [
  http.get(`${B}/entity-locks`, ({ request }) => {
    const g = guard(); if (g) return g;
    const kind = new URL(request.url).searchParams.get('kind');
    return HttpResponse.json({ records: ENT_LOCKS.filter((l) => !kind || l.kind === kind), columns: ENT_COLS.filter((c) => !kind || c.kind === kind) });
  }),
  http.post(`${B}/entity-locks/columns/:kind/:field`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body; const e = bad(b); if (e) return e;
    if (ENT_COLS.some((c) => c.kind === params.kind && c.field === params.field)) return problem(409, 'invalid_transition', 'This column is already locked.');
    ENT_COLS.push({ id: crypto.randomUUID(), kind: String(params.kind), field: String(params.field), reason: String(b.reason), locked_at: new Date().toISOString(), locked_by: null });
    return HttpResponse.json({ kind: params.kind, field: params.field, locked: true });
  }),
  http.delete(`${B}/entity-locks/columns/:kind/:field`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body; const e = bad(b); if (e) return e;
    const i = ENT_COLS.findIndex((c) => c.kind === params.kind && c.field === params.field);
    if (i < 0) return problem(409, 'invalid_transition', 'This column is not locked.');
    ENT_COLS.splice(i, 1);
    return HttpResponse.json({ kind: params.kind, field: params.field, locked: false });
  }),
  http.post(`${B}/entity-locks/:kind/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body; const e = bad(b); if (e) return e;
    if (ENT_LOCKS.some((l) => l.kind === params.kind && l.target_id === params.id)) return problem(409, 'invalid_transition', 'This record is already locked.');
    ENT_LOCKS.push({ id: crypto.randomUUID(), kind: String(params.kind), target_id: String(params.id), reason: String(b.reason), locked_at: new Date().toISOString(), locked_by: null, label: null });
    return HttpResponse.json({ kind: params.kind, id: params.id, locked: true });
  }),
  http.delete(`${B}/entity-locks/:kind/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body; const e = bad(b); if (e) return e;
    const i = ENT_LOCKS.findIndex((l) => l.kind === params.kind && l.target_id === params.id);
    if (i < 0) return problem(409, 'invalid_transition', 'This record is not locked.');
    ENT_LOCKS.splice(i, 1);
    return HttpResponse.json({ kind: params.kind, id: params.id, locked: false });
  }),
  http.get(`${B}/warehouse/item-columns`, ({ request }) => {
    const g = guard(); if (g) return g;
    const all = new URL(request.url).searchParams.get('include_inactive') === 'true';
    if (all && !admin()) return problem(403, 'forbidden', 'Not allowed');
    return HttpResponse.json({ items: itemCols.filter((c) => all || c.is_active).sort((a, b) => a.sort_order - b.sort_order) });
  }),
  http.post(`${B}/warehouse/item-columns`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body & { code: string; label_en: string; data_type: string };
    const e = bad(b); if (e) return e;
    if (itemCols.some((c) => c.code === b.code)) return problem(409, 'duplicate', 'A column with this code exists already.');
    const { reason: _r, ...rest } = b; void _r;
    const row = { label_ar: null, required: false, section: null, in_templates: true, in_exports: true, in_list_filters: false, is_active: true, ...rest, sort_order: Math.max(0, ...itemCols.map((c) => c.sort_order)) + 10, version: 1, has_values: false } as MockCol;
    itemCols.push(row);
    return HttpResponse.json(row, { status: 201, ...tag(1) });
  }),
  http.patch(`${B}/warehouse/item-columns/:code`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const c = itemCols.find((x) => x.code === params.code);
    if (!c) return problem(404, 'not_found', 'No column has this code.');
    const s = stale(request, c.version); if (s) return s;
    const b = (await request.json()) as Body;
    const e = bad(b); if (e) return e;
    const { reason: _r, ...rest } = b; void _r;
    Object.assign(c, rest, { version: c.version + 1 });
    return HttpResponse.json(c, tag(c.version));
  }),
  http.get(`${B}/warehouse/items`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, q = u.get('q') ?? '', cat = u.get('category');
    return page(W().items.filter((x) => (u.get('include_inactive') === 'true' || x.is_active) && (!cat || x.category === cat) && has(q, x.code, x.name_en, x.name_ar)).map((x) => ({ ...x, deletable: !W().inUse.includes(x.code) && !W().stock.some((s) => s.item_code === x.code) && !x.as_built_item_code })));
  }),
  http.post(`${B}/warehouse/items`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body & { code: string };
    const e = bad(b); if (e) return e;
    if (W().items.some((x) => x.code === b.code)) return problem(409, 'duplicate', 'Item code already exists');
    const row = { is_active: true, serial_tracked: false, as_built_item_code: null, ...b, id: uid(`wh-${b.code}`), version: 1 } as never as (typeof W extends () => infer R ? R : never)['items'][number];
    delete (row as Body).reason;
    W().items.push(row);
    return HttpResponse.json(row, { status: 201, ...tag(1) });
  }),
  http.patch(`${B}/warehouse/items/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const it = W().items.find((x) => x.id === params.id);
    if (!it) return problem(404, 'not_found', 'Item not found');
    const s = stale(request, it.version); if (s) return s;
    const b = (await request.json()) as Body;
    const e = bad(b); if (e) return e;
    // Unit and serial tracking of an item with movements are fixed; an item with a pending movement cannot be deactivated.
    const used = W().inUse.includes(it.code);
    if (used && (('uom' in b && b.uom !== it.uom) || ('serial_tracked' in b && b.serial_tracked !== it.serial_tracked))) return problem(422, 'item_in_use', 'Item is in use');
    if (used && b.is_active === false) return problem(422, 'item_in_use', 'Item has a pending movement');
    const { reason: _r, custom, ...rest } = b; void _r;
    Object.assign(it, rest, { version: it.version + 1 });
    if (custom && typeof custom === 'object') {
      const cur = ((it as { custom?: Record<string, unknown> }).custom ??= {});
      Object.entries(custom as Record<string, unknown>).forEach(([k, v]) => { if (v === null) delete cur[k]; else cur[k] = v; });
    }
    return HttpResponse.json(it, tag(it.version));
  }),
  http.delete(`${B}/warehouse/items/:id`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const it = W().items.find((x) => x.id === params.id);
    if (!it) return problem(404, 'not_found', 'Item not found');
    const s = stale(request, it.version); if (s) return s;
    if ((new URL(request.url).searchParams.get('reason') ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Reason is required');
    // 0565: hide, never delete (is_active false, the version moves)
    if (ENT_LOCKS.some((l) => l.kind === 'wh_item' && l.target_id === it.id)) return problem(403, 'register_locked', 'This record is locked');
    it.is_active = false; it.version += 1;
    return HttpResponse.json({ id: it.id, deleted: true, hidden: true });
  }),
  http.get(`${B}/warehouse/stock`, ({ request }) => {
    const g = guard(); if (g) return g;
    const q = new URL(request.url).searchParams.get('q') ?? '';
    return page(W().stock.filter((s) => has(q, s.item_code, s.item_name)));
  }),
  // Contract 0.12.1 (P7): the TE dispatch (D6) and the owner data still missing (Q107).
  http.get(`${B}/warehouse/dispatch-status`, ({ request }) => {
    const g = guard(); if (g) return g;
    const st = new URL(request.url).searchParams.get('need_status');
    // Q281 (0.13.1): a site whose overall status is Cancelled is left out of the list; its own page (below) still answers
    const rows = Array.from({ length: Math.min(SITE_COUNT, 12) }, (_, i) => i).filter((i) => siteMeta(i).status !== 'cancelled').map((i) => dispatchOf(i)).filter((d) => !st || d.need_status === st);
    return page(rows.map(({ lines: _l, ...d }) => { void _l; return d; }));
  }),
  http.get(`${B}/warehouse/dispatch-status/:siteId`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(String(params.siteId));
    if (i < 0 || i >= SITE_COUNT) return problem(404, 'not_found', 'The site does not exist or is not visible to you.');
    return HttpResponse.json(dispatchOf(i));
  }),
  http.get(`${B}/warehouse/config-gaps`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json(W().gaps);
  }),
  http.get(`${B}/warehouse/region-vendors`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json({ items: [1, 2, 3, 4, 5, 6, 7].map((r) => ({ region_id: r, region_name: `Region ${r}`, wl_vendor: VENDORS.get(r)?.v ?? null, version: VENDORS.get(r)?.n ?? 0 })) });
  }),
  http.put(`${B}/warehouse/region-vendors/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as { wl_vendor?: string | null; reason?: string };
    if (!b.reason || b.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    if (b.wl_vendor !== null && b.wl_vendor !== 'Cambium' && b.wl_vendor !== 'Intracom') return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/wl_vendor', code: 'not_in_list' }] });
    const id = Number(params.id), cur = VENDORS.get(id);
    VENDORS.set(id, { v: (b.wl_vendor ?? null) as string | null, n: (cur?.n ?? 0) + 1 });
    const gaps = W().gaps.regions_without_wl_vendor.filter((r: number) => r !== id);
    W().gaps.regions_without_wl_vendor = b.wl_vendor ? gaps : [...gaps, id].sort();
    return HttpResponse.json({ region_id: id, wl_vendor: b.wl_vendor ?? null, version: (cur?.n ?? 0) + 1 });
  }),
  http.get(`${B}/number-sequences`, () => {
    const g = guard(); if (g) return g;
    const seq = (key: string, record_type: string | null, form_kind: string | null, region_id: number | null, pattern: string) =>
      ({ key, record_type, form_kind, region_id, region_code: region_id ? 'TR' : null, pattern, reset: 'yearly', next_value: 1, next_preview: pattern.replace('{REGION}', 'TR').replace('{YYYY}', '2026').replace('{SEQ:4}', '0001'), last_issued: null, last_issued_at: null, is_active: true, version: 1, updated_at: '2026-11-04T08:00:00Z' });
    const base = [seq('DN-CW-TR', 'cw_dn', 'dn', 1, 'DN-CW-{REGION}-{YYYY}-{SEQ:4}'), seq('RN-CW-TR', 'cw_rn', 'rn', 1, 'RN-CW-{REGION}-{YYYY}-{SEQ:4}'), seq('PL-WH', 'pl', null, null, 'PL-WH-{YYYY}-{SEQ:4}')];
    return HttpResponse.json({ items: base.map((s) => ({ ...s, ...(SEQ_EDITS.get(s.key) ?? {}) })) });
  }),
  http.patch(`${B}/number-sequences/:key`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Record<string, unknown>;
    if (typeof b.reason !== 'string' || b.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    if (b.pattern !== undefined && !/\{SEQ:[1-9]\}/.test(String(b.pattern))) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/pattern', code: 'invalid' }] });
    const { reason: _r, ...rest } = b; void _r;
    const key = String(params.key), cur = SEQ_EDITS.get(key) ?? {};
    const version = ((cur.version as number | undefined) ?? 1) + 1;
    const next = { ...cur, ...rest, version };
    if (rest.pattern !== undefined) (next as Record<string, unknown>).next_preview = String(rest.pattern).replace('{REGION}', 'TR').replace('{YYYY}', '2026').replace('{SEQ:4}', '0001');
    SEQ_EDITS.set(key, next);
    return HttpResponse.json({ key, ...next });
  }),
  // Contract 0.13.1 (Q270): a quarantine exit is a pending document that holds its quantity; L2 approves it in the register (not mocked here).
  http.post(`${B}/warehouse/quarantine-exits`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as { exit_kind?: string; reason?: string; lines?: { item_id: string; qty: number; serials?: string[] }[] };
    if (!['repaired', 'written_off', 'returned_to_supplier'].includes(b.exit_kind ?? '')) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/exit_kind', code: 'not_in_list' }] });
    const e = bad(b as Body); if (e) return e;
    const lines = b.lines ?? [];
    if (!lines.length) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/lines', code: 'required' }] });
    for (const [i, l] of lines.entries()) {
      const s = W().stock.find((x) => x.item_id === l.item_id);
      if (!s) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: `/lines/${i}/item_id`, code: 'unknown_item' }] });
      if (!(l.qty > 0)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: `/lines/${i}/qty`, code: 'not_positive' }] });
      const free = (s.quarantine ?? 0) - (s.quarantine_pending ?? 0);
      if (l.qty > free) return problem(422, 'insufficient_stock', `Not enough quarantined stock: ${free} can leave quarantine.`, { errors: [{ path: `/lines/${i}/qty`, code: 'insufficient_quarantine', message: `In quarantine: ${free}` }] });
    }
    for (const l of lines) { const s = W().stock.find((x) => x.item_id === l.item_id)!; s.quarantine_pending = (s.quarantine_pending ?? 0) + l.qty; }
    const n = W().movements.length + 1;
    const mvt = {
      id: uid(`wh-exit-${n}`), doc_no: `${b.exit_kind === 'returned_to_supplier' ? 'DN-SUP-WH' : 'ADJ-WH'}-2026-${String(n).padStart(4, '0')}`, record_type: b.exit_kind === 'returned_to_supplier' ? 'sup_dn' : 'adj',
      kind: 'quarantine_exit', exit_kind: b.exit_kind, exit_reason: b.reason, status: 'pending', site_id: null, site_code: null, register_record_id: uid(`wh-exit-rec-${n}`), reserved: false, version: 1, doc_no_locked: false, sequence_key: null, doc_date: '2026-11-04',
      lines: lines.map((l) => ({ item_id: l.item_id, item_code: W().stock.find((x) => x.item_id === l.item_id)!.item_code, qty: l.qty })), created_by: { id: uid('user-pm'), display_name: 'Demo User 01' }, created_at: '2026-11-04T08:00:00Z', posted_at: null,
    } as never as (typeof W extends () => infer R ? R : never)['movements'][number];
    W().movements.push(mvt);
    return HttpResponse.json(mvt, { status: 201, ...tag(1) });
  }),
  http.get(`${B}/warehouse/movements`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, status = u.get('status'), kind = u.get('kind');
    return page(W().movements.filter((m) => (!status || m.status === status) && (!kind || m.kind === kind)));
  }),

  http.get(`${B}/as-built/items`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, sec = u.get('section'), q = u.get('q') ?? '';
    return HttpResponse.json({ items: W().asBuilt.filter((x) => (u.get('include_inactive') === 'true' || x.is_active) && (!sec || x.section === sec) && has(q, x.code, x.name_en)) });
  }),
  http.post(`${B}/as-built/items`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const b = (await request.json()) as Body & { code: string; section: 'cw' | 'te'; name_en: string; unit?: string };
    const e = bad(b); if (e) return e;
    if (W().asBuilt.some((x) => x.code === b.code)) return problem(409, 'duplicate', 'Item code already exists');
    const { reason: _r, ...rest } = b; void _r;
    const row = { sort_order: 99, is_active: true, unit: 'pcs', ...rest, id: uid(`asb-${b.code}`), field_code: `q_${b.code.toLowerCase()}`, version: 1 } as (typeof W extends () => infer R ? R : never)['asBuilt'][number];
    W().asBuilt.push(row);
    return HttpResponse.json(row, { status: 201, ...tag(1) });
  }),
  http.patch(`${B}/as-built/items/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!admin()) return problem(403, 'forbidden', 'Not allowed');
    const it = W().asBuilt.find((x) => x.id === params.id);
    if (!it) return problem(404, 'not_found', 'Item not found');
    const s = stale(request, it.version); if (s) return s;
    const b = (await request.json()) as Body;
    const e = bad(b); if (e) return e;
    if (it.code === 'TE_ANT' && 'unit' in b && b.unit !== it.unit) return problem(422, 'item_in_use', 'Records already hold values for this item');
    const { reason: _r, ...rest } = b; void _r;
    Object.assign(it, rest, { version: it.version + 1 });
    return HttpResponse.json(it, tag(it.version));
  }),
];
