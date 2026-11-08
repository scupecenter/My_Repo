// MSW handlers for contract 0.15.0: /fleet/availability, the readiness of a Procurement assignment, and the booking extension / advance top-up (each answers a draft child record).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { db, save } from './db';
import { guard, problem } from './handlers';
import { toRecord } from './handlers.registers';
import { recId, type MockRecord } from './registersData';

const B = API_BASE;
const VEHICLES = [
  { vehicle_id: 'veh-1', plate_no: 'TRP-1001', vehicle_type: 'Pickup', model: 'Hilux', home_region: 'Tripoli', driver_name: 'Salem' },
  { vehicle_id: 'veh-2', plate_no: 'BNG-2002', vehicle_type: 'Van', model: 'Hiace', home_region: 'Benghazi', driver_name: null },
  { vehicle_id: 'veh-3', plate_no: 'TRP-3003', vehicle_type: 'Van', model: 'Hiace', home_region: 'Tripoli', driver_name: 'Omar' },
];
const invalid = (path: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code: 'invalid' }] });
const find = (key: string, id: unknown) => db().reg.records.find((x) => x.id === id && x.register_key === key);

/** A new draft version-1 record that continues `r` (the child booking / the top-up advance). */
function child(r: MockRecord, data: Record<string, unknown>): MockRecord {
  const id = recId(++db().reg.seq), now = new Date().toISOString();
  const c: MockRecord = { ...r, id, entity_id: id, version_no: 1, state: 'entry', current_level: 1, data: { ...r.data, ...data }, version: 1, return_count: 0, last_return_note: null, created_at: now, updated_at: now, steps: [] };
  db().reg.records.unshift(c);
  save();
  return c;
}

export const fleetHandlers = [
  http.get(`${B}/fleet/availability`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, from = u.get('from'), to = u.get('to');
    if (!from || !to || from > to) return invalid(!from ? '/from' : '/to');
    const region = u.get('home_region'), type = u.get('vehicle_type');
    return HttpResponse.json({ items: VEHICLES.filter((v) => (!region || v.home_region === region) && (!type || v.vehicle_type === type)) });
  }),
  http.get(`${B}/registers/procurement/records/:id/readiness`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = find('procurement', params.id);
    return r ? HttpResponse.json({ readiness: r.data.vehicle_required ? 'awaiting_vehicle' : 'ready_to_mobilize', ready_date: null, approved: r.state === 'approved' }) : problem(404, 'not_found', 'Record not found');
  }),
  http.post(`${B}/registers/car_dispatcher/records/:id/extend`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = find('car_dispatcher', params.id);
    if (!r) return problem(404, 'not_found', 'Record not found');
    const to = ((await request.json()) as { to_date?: string }).to_date;
    if (!to || to <= String(r.data.to_date ?? '')) return invalid('/to_date');
    if (r.state !== 'approved') return problem(409, 'invalid_transition', 'Only a reserved booking can be extended');
    const c = child(r, { from_date: r.data.to_date, to_date: to, parent_booking_id: r.entity_id });
    return HttpResponse.json(toRecord(c), { status: 201, headers: { ETag: '"1"' } });
  }),
  http.post(`${B}/registers/financial_advances/records/:id/top-up`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = find('financial_advances', params.id);
    if (!r) return problem(404, 'not_found', 'Record not found');
    const b = (await request.json()) as { requested_amount?: number; period_to?: string };
    if (b.requested_amount !== undefined && !(b.requested_amount > 0)) return invalid('/requested_amount');
    if (r.state !== 'approved') return problem(409, 'invalid_transition', 'Only an approved advance can be topped up');
    const c = child(r, { ...(b.requested_amount ? { requested_amount: b.requested_amount } : {}), ...(b.period_to ? { period_to: b.period_to } : {}) });
    return HttpResponse.json(toRecord(c), { status: 201, headers: { ETag: '"1"' } });
  }),
];
