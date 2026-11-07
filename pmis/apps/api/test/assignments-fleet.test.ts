import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allLocked, approve, q, taskRow, newSite, dbDate } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G, Team, approveFlex, patch, post, recPath, regCell, team } from './reg-helpers';
import { downloadTemplate, load } from './tpl-helpers';
import { Actor, actor } from './wf-helpers';

let seq = 0;
const uniq = (): string => `${process.pid}${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Migration 0076 (owner decisions Q495 to Q516): field assignments in Procurement, the Car Dispatcher, Financial Advances and the MOB tasks.
 * Region 7 and the register-cell lock of the other register suites (770101).
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const R = 7;
const AMOUNT = 4217;

async function globalCell(key: string, level: 1 | 3, users: string[]): Promise<void> {
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id IS NULL', [key, level]);
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ($1, $2, 'any_one'::"MatrixRule", NULL, true, now()) RETURNING id`, [key, level]);
  for (const u of users) await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user'::"AssigneeKind", $2)`, [c.rows[0].id, u]);
}

interface Ctx { proc: Team; car: Team; fin: Team; viewerCar: Actor; viewerFin: Actor; m1: Actor; m2: Actor; cust: Actor }

/** The three registers' holders in region 7, two members (m1 is also a Finance L2 holder: the custodian of the expense test) and two read-only users. */
async function setup(): Promise<Ctx> {
  const proc = await team(app, db, 'procurement', 'procurement', R);
  const carEntry = await actor(app, db, { level: 'entry', grants: G('car_dispatcher', 'view', 'create', 'edit'), regions: [R], modules: null });
  const carApprove = await actor(app, db, { level: 'approve', grants: G('car_dispatcher', 'view', 'approve'), regions: [R], modules: null });
  await globalCell('car_dispatcher', 1, [carEntry.user.id]);
  await globalCell('car_dispatcher', 3, [carApprove.user.id]);
  const car: Team = { entry: carEntry, review: carApprove, approve: carApprove, site: proc.site, region: R, key: 'car_dispatcher' };
  const finEntry = await actor(app, db, { level: 'entry', grants: G('financial_advances', 'view', 'create', 'edit'), regions: [R], modules: null });
  const finApprove = await actor(app, db, { level: 'approve', grants: G('financial_advances', 'view', 'approve'), regions: [R], modules: null });
  const cust = await actor(app, db, { level: 'approve', grants: G('financial_advances', 'view', 'approve'), regions: [R], modules: null });
  await regCell(db, 'financial_advances', R, 'entry', { user: [finEntry.user.id] });
  await regCell(db, 'financial_advances', R, 'approve', { user: [finApprove.user.id, cust.user.id] });
  const fin: Team = { entry: finEntry, review: finApprove, approve: finApprove, site: proc.site, region: R, key: 'financial_advances' };
  const viewerCar = await actor(app, db, { level: 'view', grants: G('car_dispatcher', 'view'), regions: [R], modules: null });
  const viewerFin = await actor(app, db, {
    level: 'view', grants: [...G('financial_advances', 'view'), ...G('templates', 'view', 'download_documents')], regions: [R], modules: null,
  });
  const m1 = await actor(app, db, { regions: [R], modules: null });
  const m2 = await actor(app, db, { regions: [R], modules: null });
  return { proc, car, fin, viewerCar, viewerFin, m1, m2, cust };
}

const members = (...ids: string[]) => ids.map((id, i) => ({ user_id: id, member_role: i === 0 ? 'supervisor' : 'executor', is_lead: i === 0 }));
const ASG = { scope: 'Survey', delivery: 'In-House', order_status: 'Open', planned_start: '2026-11-10', planned_end: '2026-11-12' };

async function mk(t: Team, rt: string | null, data: Record<string, unknown>, site = true): Promise<Record<string, any>> {
  const res = await t.entry.api.call('post', recPath(t.key), { ...(site ? { site_id: t.site.id } : {}), ...(rt ? { record_type: rt } : {}), data });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}

/** An approved Procurement assignment (field work). */
async function assignment(c: Ctx, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const rec = await mk(c.proc, null, { ...ASG, members: members(c.m1.user.id, c.m2.user.id), vehicle_required: true, advance_required: true, ...over });
  return approveFlex(c.proc, rec.id, rec.version);
}

const children = async (t: Team, rt: string, asg: Record<string, any>): Promise<Record<string, any>[]> => {
  const res = await t.entry.api.call('get', `${recPath(t.key)}?record_type=${rt}&limit=100`);
  return (res.body.items as Record<string, any>[]).filter((x) => x.data.procurement_record_id === asg.entity_id);
};

async function newVehicle(c: Ctx, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const v = await mk(c.car, 'vehicle', {
    plate_no: `P-${uniq()}`, vehicle_type: 'Van', home_region: 'Tripoli', permit_expiry: '2030-01-01', insurance_expiry: '2030-01-01', vehicle_status: 'available', ...over,
  }, false);
  return approveFlex(c.car, v.id, v.version);
}

/** Sets the vehicle on the draft booking, submits and approves it. */
async function reserve(c: Ctx, booking: Record<string, any>, vehicle: Record<string, any>) {
  const p = await patch(c.car.entry.api, 'car_dispatcher', booking.id, booking.version, { data: { vehicle_id: vehicle.entity_id } });
  expect(p.status).toBe(200);
  return approveFlex(c.car, booking.id, p.body.version);
}

const readiness = async (c: Ctx, asg: Record<string, any>): Promise<Record<string, any>> =>
  (await c.proc.entry.api.call('get', `/registers/procurement/records/${asg.id}/readiness`)).body as Record<string, any>;

async function approveAdvance(c: Ctx, adv: Record<string, any>, amount: number): Promise<Record<string, any>> {
  const p = await patch(c.fin.entry.api, 'financial_advances', adv.id, adv.version, { data: { advance_kind: 'Daily allowance', requested_amount: amount } });
  expect(p.status).toBe(200);
  return approveFlex(c.fin, adv.id, p.body.version);
}

async function disburse(c: Ctx, adv: Record<string, any>, amount: number): Promise<Record<string, any>> {
  const nv = await c.fin.entry.api.call('post', recPath('financial_advances', adv.id, '/versions'), undefined, { 'If-Match': `"${adv.version}"` });
  expect(nv.status).toBe(201);
  const today = await dbDate(db, 'cal_today()');
  const p = await patch(c.fin.entry.api, 'financial_advances', nv.body.id, nv.body.version, {
    data: { advance_state: 'disbursed', disbursed_amount: amount, disbursed_date: today, payment_method: 'Cash', payment_ref: `PAY-${uniq()}` },
  });
  expect(p.status).toBe(200);
  return approveFlex(c.fin, nv.body.id, p.body.version);
}

describe('the link rule', () => {
  it('opens one draft booking and one draft individual advance per member, once', async () => {
    const c = await setup();
    const asg = await assignment(c);
    const b = await children(c.car, 'booking', asg);
    const a = await children(c.fin, 'advance', asg);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ state: 'entry' });
    expect(b[0]!.data).toMatchObject({ booking_state: 'requested', from_date: '2026-11-10', to_date: '2026-11-12' });
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.data.custodian_user_id).sort()).toEqual([c.m1.user.id, c.m2.user.id].sort());
    expect(a.every((x) => x.data.advance_scope === 'individual' && x.site_id === c.proc.site.id)).toBe(true);
    // a correction of the assignment, approved again: nothing is opened twice
    const nv = await c.proc.entry.api.call('post', recPath('procurement', asg.id, '/versions'), undefined, { 'If-Match': `"${asg.version}"` });
    expect(nv.status).toBe(201);
    await approveFlex(c.proc, nv.body.id, nv.body.version);
    expect(await children(c.car, 'booking', asg)).toHaveLength(1);
    expect(await children(c.fin, 'advance', asg)).toHaveLength(2);
  });

  it('a "not required" answer needs a reason, and then opens nothing', async () => {
    const c = await setup();
    const rec = await mk(c.proc, null, { ...ASG, members: members(c.m1.user.id), vehicle_required: false, advance_required: false });
    const bad = await post(c.proc.entry.api, 'procurement', rec.id, 'submit', rec.version);
    expect(bad.status).toBe(422);
    const codes = (bad.body.errors as { path: string; code: string }[]).map((e) => `${e.path}:${e.code}`).sort();
    expect(codes).toEqual(['/data/advance_not_required_reason:reason_required', '/data/vehicle_not_required_reason:reason_required']);
    const fixed = await patch(c.proc.entry.api, 'procurement', rec.id, rec.version, {
      data: { vehicle_not_required_reason: 'Site next to the office', advance_not_required_reason: 'Paid by the contractor' },
    });
    expect(fixed.status).toBe(200);
    const done = await approveFlex(c.proc, rec.id, fixed.body.version);
    expect(done.state).toBe('approved');
    expect(await children(c.car, 'booking', done)).toHaveLength(0);
    expect(await children(c.fin, 'advance', done)).toHaveLength(0);
    expect((await readiness(c, done)).readiness).toBe('ready_to_mobilize');
  });
});

describe('the Car Dispatcher', () => {
  it('refuses a vehicle reserved twice for overlapping dates (409), at the API and in the database', async () => {
    const c = await setup();
    const veh = await newVehicle(c);
    const a1 = await assignment(c, { advance_required: false, advance_not_required_reason: 'none' });
    const a2 = await assignment(c, { planned_start: '2026-11-11', planned_end: '2026-11-13', advance_required: false, advance_not_required_reason: 'none' });
    const b1 = (await children(c.car, 'booking', a1))[0]!;
    const b2 = (await children(c.car, 'booking', a2))[0]!;
    const done = await reserve(c, b1, veh);
    expect(done.data.booking_state).toBe('reserved');
    const p = await patch(c.car.entry.api, 'car_dispatcher', b2.id, b2.version, { data: { vehicle_id: veh.entity_id } });
    const res = await post(c.car.entry.api, 'car_dispatcher', b2.id, 'submit', p.body.version);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('vehicle_already_reserved');
    // the constraint itself
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE pmis_definer');
      await expect(db.query(
        `INSERT INTO vehicle_reservations (vehicle_entity_id, booking_entity_id, booking_record_id, period) VALUES ($1, gen_random_uuid(), $2, daterange('2026-11-12', '2026-11-14'))`,
        [veh.entity_id, done.id],
      )).rejects.toThrow(/vehicle_reservations_no_overlap/);
    } finally {
      await db.query('ROLLBACK');
    }
    // the free vehicles of a range
    const busy = await c.car.entry.api.call('get', '/fleet/availability?from=2026-11-11&to=2026-11-12');
    expect(busy.status).toBe(200);
    expect((busy.body.items as { vehicle_id: string }[]).some((x) => x.vehicle_id === veh.entity_id)).toBe(false);
    const free = await c.car.entry.api.call('get', '/fleet/availability?from=2026-12-01&to=2026-12-03');
    expect((free.body.items as { vehicle_id: string }[]).some((x) => x.vehicle_id === veh.entity_id)).toBe(true);
  });

  it('a vehicle with an expired permit is not bookable', async () => {
    const c = await setup();
    const veh = await newVehicle(c, { permit_expiry: '2026-11-11' });
    const a1 = await assignment(c, { advance_required: false, advance_not_required_reason: 'none' });
    const b1 = (await children(c.car, 'booking', a1))[0]!;
    const p = await patch(c.car.entry.api, 'car_dispatcher', b1.id, b1.version, { data: { vehicle_id: veh.entity_id } });
    const res = await post(c.car.entry.api, 'car_dispatcher', b1.id, 'submit', p.body.version);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('vehicle_not_bookable');
  });

  it('a booking of another site\'s assignment is refused when its site differs', async () => {
    const c = await setup();
    const a1 = await assignment(c, { advance_required: false, advance_not_required_reason: 'none' });
    const b1 = (await children(c.car, 'booking', a1))[0]!;
    const other = await newSite(db, R);
    const p = await patch(c.car.entry.api, 'car_dispatcher', b1.id, b1.version, { data: { site_id: other.id, waiting_reason: 'no vehicle yet' } });
    const res = await post(c.car.entry.api, 'car_dispatcher', b1.id, 'submit', p.body.version);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toContain('site_mismatch');
  });

  it('extends a reserved booking with a child, and a read-only user is refused (403)', async () => {
    const c = await setup();
    const veh = await newVehicle(c);
    const a1 = await assignment(c, { advance_required: false, advance_not_required_reason: 'none' });
    const done = await reserve(c, (await children(c.car, 'booking', a1))[0]!, veh);
    const denied = await c.viewerCar.api.call('post', `/registers/car_dispatcher/records/${done.id}/extend`, { to_date: '2026-11-15' });
    expect(denied.status).toBe(403);
    const ok = await c.car.entry.api.call('post', `/registers/car_dispatcher/records/${done.id}/extend`, { to_date: '2026-11-15' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ parent_booking_id: done.entity_id, from_date: '2026-11-13', to_date: '2026-11-15', vehicle_id: veh.entity_id });
    expect(ok.body.state).toBe('entry');
  });
});

describe('readiness and the MOB task', () => {
  it('approval without disbursement does not count; ready_date feeds MOB-1', async () => {
    const c = await setup();
    await allLocked(db, c.proc.site);
    const veh = await newVehicle(c);
    const asg = await assignment(c);
    expect((await readiness(c, asg)).readiness).toBe('awaiting_both');
    await reserve(c, (await children(c.car, 'booking', asg))[0]!, veh);
    expect((await readiness(c, asg)).readiness).toBe('awaiting_advance');
    const advs = await children(c.fin, 'advance', asg);
    const approved: Record<string, any>[] = [];
    for (const a of advs) approved.push(await approveAdvance(c, a, 300));
    expect(approved.every((x) => x.data.advance_state === 'approved_for_disbursement')).toBe(true);
    expect((await readiness(c, asg)).readiness).toBe('awaiting_advance');            // approved, not disbursed
    await disburse(c, approved[0]!, 300);
    expect((await readiness(c, asg)).readiness).toBe('awaiting_advance');            // one of two
    expect((await taskRow(db, c.proc.site, 'MOB-1')).state).not.toBe('approved');
    await disburse(c, approved[1]!, 300);
    const r = await readiness(c, asg);
    const today = await dbDate(db, 'cal_today()');
    expect(r.readiness).toBe('ready_to_mobilize');
    expect(r.ready_date).toBe(today);
    const rec = await c.proc.entry.api.call('get', recPath('procurement', asg.id));
    expect(rec.body.data).toMatchObject({ readiness: 'ready_to_mobilize', ready_date: today });
    const mob = await taskRow(db, c.proc.site, 'MOB-1');
    expect(mob.state).toBe('approved');
    expect(mob.actual_date).toBe(today);
  });

  it('flags the advances still open after the work closed', async () => {
    const c = await setup();
    const asg = await assignment(c, { vehicle_required: false, vehicle_not_required_reason: 'none', actual_end: '2026-11-01', members: members(c.m1.user.id) });
    const [a] = await children(c.fin, 'advance', asg);
    const ap = await approveAdvance(c, a!, 100);
    await disburse(c, ap, 100);
    const r = await readiness(c, asg);
    expect(r.open_advances_after_close).toBe(true);
    expect(r.readiness).toBe('ready_to_mobilize');
  });
});

describe('Financial Advances', () => {
  it('the custodian never approves their own expense (403), the Finance L2 does', async () => {
    const c = await setup();
    const asg = await assignment(c, { vehicle_required: false, vehicle_not_required_reason: 'none', members: members(c.cust.user.id) });
    const [a] = await children(c.fin, 'advance', asg);
    expect(a!.data.custodian_user_id).toBe(c.cust.user.id);
    const dis = await disburse(c, await approveAdvance(c, a!, AMOUNT), AMOUNT);
    const today = await dbDate(db, 'cal_today()');
    const exp = await mk(c.fin, 'expense', { advance_id: dis.entity_id, expense_date: today, expense_kind: 'Fuel', amount: 50 });
    const sub = await post(c.fin.entry.api, 'financial_advances', exp.id, 'submit', exp.version);
    expect(sub.status).toBe(200);
    await c.cust.api.stepUp(c.cust.user.password);
    const own = await post(c.cust.api, 'financial_advances', exp.id, 'approve', sub.body.version);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('self_approval_forbidden');
    await c.fin.approve.api.stepUp(c.fin.approve.user.password);
    const ok = await post(c.fin.approve.api, 'financial_advances', exp.id, 'approve', sub.body.version);
    expect(ok.status).toBe(200);
    // the derived balance: disbursed - approved expenses - returned
    const adv = await c.fin.entry.api.call('get', recPath('financial_advances', dis.id));
    expect(adv.body.data.balance).toBe(AMOUNT - 50);
  });

  it('refuses an expense on an advance of another site', async () => {
    const c = await setup();
    const asg = await assignment(c, { vehicle_required: false, vehicle_not_required_reason: 'none', members: members(c.m1.user.id) });
    const [a] = await children(c.fin, 'advance', asg);
    const dis = await disburse(c, await approveAdvance(c, a!, 100), 100);
    const other = await newSite(db, R);
    const today = await dbDate(db, 'cal_today()');
    const res = await c.fin.entry.api.call('post', recPath('financial_advances'), { site_id: other.id, record_type: 'expense', data: { advance_id: dis.entity_id, expense_date: today, expense_kind: 'Fuel', amount: 5 } });
    expect(res.status).toBe(201);
    const sub = await post(c.fin.entry.api, 'financial_advances', res.body.id, 'submit', res.body.version);
    expect(sub.status).toBe(422);
    expect(sub.body.errors[0].code).toBe('advance_not_disbursed');
  });

  it('hides the amounts from users outside Finance, in the record, the search and the template (Q512)', async () => {
    const c = await setup();
    const asg = await assignment(c, { vehicle_required: false, vehicle_not_required_reason: 'none', members: members(c.m1.user.id) });
    const [a] = await children(c.fin, 'advance', asg);
    const ap = await approveAdvance(c, a!, AMOUNT);
    const mine = await c.fin.entry.api.call('get', recPath('financial_advances', ap.id));
    expect(mine.body.data.requested_amount).toBe(AMOUNT);
    const seen = await c.viewerFin.api.call('get', recPath('financial_advances', ap.id));
    expect(seen.status).toBe(200);
    expect(seen.body.data.amounts_hidden).toBe(true);
    expect(seen.body.data.requested_amount).toBeUndefined();
    expect(seen.body.data.approved_amount).toBeUndefined();
    const search = await c.viewerFin.api.call('get', `${recPath('financial_advances')}?q=${AMOUNT}`);
    expect(search.body.items).toHaveLength(0);
    const own = await c.fin.entry.api.call('get', `${recPath('financial_advances')}?q=${AMOUNT}`);
    expect((own.body.items as unknown[]).length).toBeGreaterThan(0);
    const cells = async (api: Actor['api']): Promise<string[]> => {
      const dl = await downloadTemplate(api, 'TPL-ADV', '?prefill=true');
      expect(dl.status).toBe(200);
      const wb = await load(dl.buffer);
      const out: string[] = [];
      wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value ?? '')))));
      return out;
    };
    expect((await cells(c.viewerFin.api)).some((x) => x.includes(String(AMOUNT)))).toBe(false);
    // the top-up needs the entry holder: a read-only user is refused (403)
    const dis = await disburse(c, ap, AMOUNT);
    const denied = await c.viewerFin.api.call('post', `/registers/financial_advances/records/${dis.id}/top-up`, { requested_amount: 10 });
    expect(denied.status).toBe(403);
    const top = await c.fin.entry.api.call('post', `/registers/financial_advances/records/${dis.id}/top-up`, { requested_amount: 10 });
    expect(top.status).toBe(201);
    expect(top.body.data).toMatchObject({ parent_advance_id: dis.entity_id, advance_state: 'requested' });
  });
});

describe('milestones and gates do not change with the MOB tasks', () => {
  it('the MOB tasks count toward no milestone and sit in no gate condition', async () => {
    const rows = await q<{ code: string; counts_toward_milestone: boolean; has_documents: boolean }>(
      db, `SELECT code, counts_toward_milestone, has_documents FROM task_definitions WHERE code LIKE 'MOB-%'`);
    expect(rows.map((r) => r.code).sort()).toEqual(['MOB-1', 'MOB-2', 'MOB-5']);
    expect(rows.every((r) => !r.counts_toward_milestone && !r.has_documents)).toBe(true);
    const gates = await q<{ n: string }>(db, `SELECT count(*) AS n FROM phase_gate_rules WHERE conditions::text ILIKE '%MOB%'`);
    expect(Number(gates[0]!.n)).toBe(0);
    const sla = await q<{ code: string; min_working_days: number; max_working_days: number; start_ref: string }>(
      db, `SELECT td.code, r.min_working_days, r.max_working_days, r.start_ref FROM sla_rules r JOIN task_definitions td ON td.id = r.task_def_id WHERE td.code LIKE 'MOB-%' ORDER BY td.code`);
    expect(sla.map((s) => [s.min_working_days, s.max_working_days, s.start_ref])).toEqual([[2, 3, 'REC:procurement'], [2, 3, 'REC:procurement'], [2, 3, 'REC:procurement']]);
  });

  it('the same approvals give the same milestone and gate dates with or without the MOB tasks, also when a MOB task is approved', async () => {
    const withMob = await newSite(db);
    const without = await newSite(db);
    await allLocked(db, withMob);
    await allLocked(db, without);
    await db.query(`DELETE FROM task_instances WHERE site_id = $1 AND task_def_id IN (SELECT id FROM task_definitions WHERE code LIKE 'MOB-%')`, [without.id]);
    const days = [-9, -8, -7, -6];
    for (const [i, code] of ['A2', 'A3', 'A4', 'A5'].entries()) {
      const d = await dbDate(db, `cal_add_workdays(cal_today(), ${days[i]})`);
      await approve(db, withMob, code, d);
      await approve(db, without, code, d);
    }
    await approve(db, withMob, 'MOB-1', await dbDate(db, 'cal_today()'));
    const snap = async (s: { id: string }) => ({
      ms1: (await q(db, `SELECT ti.state::text AS state, ti.actual_date::text AS actual_date FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id WHERE ti.site_id = $1 AND td.code = 'MS1'`, [s.id]))[0],
      gates: await q(db, `SELECT g.link_code, e.status, e.gate_date::text AS gate_date FROM phase_gate_rules g, gate_eval($1, g.link_code) e WHERE g.workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1) ORDER BY g.link_code`, [s.id]),
    });
    expect(await snap(withMob)).toEqual(await snap(without));
    expect((await snap(withMob)).ms1!.state).toBe('approved');
  });
});
