// Mock of the structure proposals (contract 0.15.401, migration 0560), synthetic data only. Two proposals are seeded for the register `gecol`: a pending one with a
// rename and a new column, and a pending one with a blocked item. `POST /structure-proposals/:id/decision` applies a pending proposal (approve needs the step-up
// and refuses a blocked one with 409), `POST /structure-proposals/upload` makes a pending one, `POST /structure-proposals/:id/revert` the opposite one.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { StructureProposal } from '@/api/structureProposals';
import { db, stepUpValid } from './db';
import { guard, problem, stepUp } from './handlers';

const B = API_BASE;
const states = new WeakMap<object, StructureProposal[]>();
const who = { id: '00000000-0000-4000-8000-000000009002', display_name: 'Second Admin (synthetic)' };

function seed(): StructureProposal[] {
  const base = { register_key: 'gecol', source: 'excel' as const, template_version: 3, submitted_by: who, submitted_at: '2026-11-27T08:00:00Z', reason: 'Names from the site team', needs_two_people: false, reverts_id: null, decided_by: null, decided_at: null, decide_note: null, applied_at: null, version: 1 };
  return [
    { ...base, id: '00000000-0000-4000-8000-0000000000a1', status: 'pending', summary: { rename: 1, add: 1 }, blocked_count: 0,
      items: [
        { code: 'contractor', create: false, changes: ['rename'], patch: { label_en: 'Contractor company' }, from: { label_en: 'GECOL Contractor' }, blocked: null, impact: { usage: { records_with_value: 12 }, conversion: null } },
        { code: 'x_new', create: true, changes: ['add'], patch: { label_en: 'Permit ref', field_type: 'text' }, from: null, blocked: null, impact: null },
      ] },
    { ...base, id: '00000000-0000-4000-8000-0000000000a2', status: 'pending', summary: { type: 1 }, blocked_count: 1, needs_two_people: true,
      items: [{ code: 'pr_no', create: false, changes: ['type'], patch: { field_type: 'number' }, from: { type: 'text' }, blocked: 'conversion_blocked', impact: { usage: { records_with_value: 8 }, conversion: { failed: 3, convertible: 5 } } }] },
  ] as StructureProposal[];
}
const list = (): StructureProposal[] => { const k = db() as unknown as object; let s = states.get(k); if (!s) { s = seed(); states.set(k, s); } return s; };

export const structureHandlers = [
  http.get(`${B}/structure-proposals`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: list() }); }),
  http.post(`${B}/structure-proposals/upload`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const fd = await request.formData();
    if (!fd.get('file')) return problem(422, 'validation_failed', 'Validation failed');
    const p: StructureProposal = { ...seed()[0]!, id: `00000000-0000-4000-8000-${String(list().length + 1).padStart(12, '0')}`, reason: String(fd.get('reason') ?? '') };
    list().unshift(p);
    return HttpResponse.json(p, { status: 201 });
  }),
  http.post(`${B}/structure-proposals/:id/decision`, async ({ request, params }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { action: 'approve' | 'reject'; note?: string };
    const p = list().find((x) => x.id === params.id);
    if (!p) return problem(404, 'not_found', 'Not found');
    if (p.status !== 'pending') return problem(409, 'invalid_transition', 'The proposal is not waiting for review.');
    if (b.action === 'approve') {
      if (!stepUpValid()) return stepUp();
      if (p.blocked_count > 0) return problem(409, 'invalid_transition', 'The proposal has a blocked item.');
      p.status = 'applied';
    } else {
      if ((b.note ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed');
      p.status = 'rejected'; p.decide_note = b.note ?? null;
    }
    p.version += 1;
    return HttpResponse.json(p);
  }),
  http.post(`${B}/structure-proposals/:id/revert`, ({ params }) => {
    const g = guard(); if (g) return g;
    const p = list().find((x) => x.id === params.id);
    if (!p || p.status !== 'applied') return problem(409, 'invalid_transition', 'Only an applied proposal can be undone.');
    const r: StructureProposal = { ...p, id: `00000000-0000-4000-8000-0000000000b${list().length}`, status: 'pending', reverts_id: p.id, source: 'system' };
    list().unshift(r);
    return HttpResponse.json(r, { status: 201 });
  }),
  http.get(`${B}/structure-proposals/:id/differences`, () => new HttpResponse(new Uint8Array([80, 75]), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="structure-differences-gecol.xlsx"' } })),
];
