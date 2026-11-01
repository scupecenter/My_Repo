// MSW handlers for /warehouse/* and /as-built/items, following contracts/openapi.yaml 0.4.8. Writes need the System Admin account (the mock `pm`).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { db, viewer } from './db';
import { guard, page, problem } from './handlers';
import { uid } from './ids';

const B = API_BASE;
const W = () => db().wh;
const tag = (v: number) => ({ headers: { ETag: `"${v}"` } });
const admin = () => viewer()?.key === 'pm';
const has = (q: string, ...s: (string | null | undefined)[]) => !q || s.join(' ').toLowerCase().includes(q.toLowerCase());
const stale = (req: Request, v: number) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === v ? null : problem(412, 'precondition_failed', 'The item changed; reload and retry');
};
type Body = Record<string, unknown> & { reason?: string };
const bad = (b: Body) => String(b.reason ?? '').trim().length < 3 ? problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] }) : null;

export const warehouseHandlers = [
  http.get(`${B}/warehouse/items`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, q = u.get('q') ?? '', cat = u.get('category');
    return page(W().items.filter((x) => (u.get('include_inactive') === 'true' || x.is_active) && (!cat || x.category === cat) && has(q, x.code, x.name_en, x.name_ar)));
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
    const { reason: _r, ...rest } = b; void _r;
    Object.assign(it, rest, { version: it.version + 1 });
    return HttpResponse.json(it, tag(it.version));
  }),
  http.get(`${B}/warehouse/stock`, ({ request }) => {
    const g = guard(); if (g) return g;
    const q = new URL(request.url).searchParams.get('q') ?? '';
    return page(W().stock.filter((s) => has(q, s.item_code, s.item_name)));
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
