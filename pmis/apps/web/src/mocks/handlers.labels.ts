// MSW handlers of the personal labels (contract 0.15.620). Like the real API: everything is the caller's own, a label is hidden and never deleted, names are
// unique per person among the active ones, at most 30 active labels. The state is per mock database and per viewer.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { LABEL_COLOURS, type Label, type LabelColour } from '@/api/labels';
import { db, viewer, type Db } from './db';
import { guard, problem } from './handlers';

const B = API_BASE;
type Link = { label_id: string; kind: string; ref_id: string; context: string | null };
type Row = Label & { owner: string };
type State = { labels: Row[]; links: Link[] };
const states = new WeakMap<Db, State>();
const S = (): State => { const d = db(); let s = states.get(d); if (!s) { s = { labels: [], links: [] }; states.set(d, s); } return s; };
let seq = 0;
const lid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;
const owner = () => viewer()?.key ?? 'anon';
const mine = () => S().labels.filter((l) => l.owner === owner());
const dto = (l: Row): Label => ({ id: l.id, name: l.name, colour: l.colour, is_active: l.is_active, link_count: S().links.filter((k) => k.label_id === l.id).length });
const bad = (path: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code: 'invalid', message: 'invalid' }] });
const own = (id: string) => mine().find((l) => l.id === id && l.is_active);

export const labelsHandlers = [
  http.get(`${B}/labels`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: mine().filter((l) => l.is_active).sort((a, b) => a.name.localeCompare(b.name)).map(dto) }); }),
  http.post(`${B}/labels`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { name?: string; colour?: string };
    const name = (b.name ?? '').trim();
    if (!name || name.length > 40) return bad('/name');
    if (!LABEL_COLOURS.includes(b.colour as LabelColour)) return bad('/colour');
    const act = mine().filter((l) => l.is_active);
    if (act.length >= 30) return bad('/name');
    if (act.some((l) => l.name.toLowerCase() === name.toLowerCase())) return problem(409, 'duplicate', 'Duplicate');
    const l: Row = { id: lid(), name, colour: b.colour as LabelColour, is_active: true, link_count: 0, owner: owner() };
    S().labels.push(l);
    return HttpResponse.json(dto(l), { status: 201 });
  }),
  http.get(`${B}/labels/links`, ({ request }) => {
    const g = guard(); if (g) return g;
    const kind = new URL(request.url).searchParams.get('kind') ?? '';
    if (kind !== 'site' && kind !== 'register_record') return bad('/kind');
    const ids = new Set(mine().filter((l) => l.is_active).map((l) => l.id));
    const by = new Map<string, { ref_id: string; context: string | null; label_ids: string[] }>();
    for (const k of S().links.filter((x) => x.kind === kind && ids.has(x.label_id))) {
      const e = by.get(k.ref_id) ?? { ref_id: k.ref_id, context: k.context, label_ids: [] };
      e.label_ids.push(k.label_id); by.set(k.ref_id, e);
    }
    return HttpResponse.json({ items: [...by.values()] });
  }),
  http.patch(`${B}/labels/:id`, async ({ request, params }) => {
    const g = guard(); if (g) return g;
    const l = own(String(params.id));
    if (!l) return problem(404, 'not_found', 'Not found');
    const b = (await request.json()) as { name?: string; colour?: string };
    if (b.name !== undefined) {
      const n = b.name.trim();
      if (!n || n.length > 40) return bad('/name');
      if (mine().some((x) => x.is_active && x.id !== l.id && x.name.toLowerCase() === n.toLowerCase())) return problem(409, 'duplicate', 'Duplicate');
      l.name = n;
    }
    if (b.colour !== undefined) { if (!LABEL_COLOURS.includes(b.colour as LabelColour)) return bad('/colour'); l.colour = b.colour as LabelColour; }
    return HttpResponse.json(dto(l));
  }),
  http.post(`${B}/labels/:id/archive`, ({ params }) => {
    const g = guard(); if (g) return g;
    const l = own(String(params.id));
    if (!l) return problem(404, 'not_found', 'Not found');
    l.is_active = false;
    return HttpResponse.json(dto(l));
  }),
  ...(['assign', 'unassign'] as const).map((op) => http.post(`${B}/labels/:id/${op}`, async ({ request, params }) => {
    const g = guard(); if (g) return g;
    const l = own(String(params.id));
    if (!l) return problem(404, 'not_found', 'Not found');
    const b = (await request.json()) as { kind?: string; ref_id?: string; context?: string };
    if ((b.kind !== 'site' && b.kind !== 'register_record') || !b.ref_id) return bad('/kind');
    const st = S();
    st.links = st.links.filter((k) => !(k.label_id === l.id && k.kind === b.kind && k.ref_id === b.ref_id));
    if (op === 'assign') st.links.push({ label_id: l.id, kind: b.kind, ref_id: b.ref_id, context: b.context ?? null });
    return HttpResponse.json({ label_id: l.id, kind: b.kind, ref_id: b.ref_id, on: op === 'assign', context: b.context ?? null });
  })),
];
