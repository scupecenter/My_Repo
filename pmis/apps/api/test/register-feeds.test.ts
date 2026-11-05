import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G, Team, approveFlex, post, recPath, regCell, team } from './reg-helpers';
import { actor, makeTask } from './wf-helpers';

/**
 * Migration 0062 (P4a, owner answers 2026-11-04 Q103, Q108, Q113, Q225): an approved register record feeds the calculation layer.
 * Change Control -> change_requests (both dates: effective and approval) and the gate follows; drafts, rejected and voided versions feed nothing;
 * a new version updates the same row (idempotent) and a withdrawal stops it counting. Site fields that change rules go through Change Control.
 * RF & Design, Acquisition, Readiness, Issues and Risks fill their typed tables; As-Built has a CW and a TE part (BU / EF from the submissions).
 * Region 3 is used by this suite only (the matrix suite writes cells of region 4); the matrix lock of the register suites is held per test.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 3;
const U = randomBytes(3).toString('hex');
let n = 0;
const cid = (p: string): string => `${p}-${U}-${++n}`;

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

const today = async (): Promise<string> => (await q<{ d: string }>(db, 'SELECT current_date::text AS d'))[0]!.d;
const daysAgo = async (k: number): Promise<string> => (await q<{ d: string }>(db, 'SELECT (current_date - $1::int)::text AS d', [k]))[0]!.d;
const gate = async (siteId: string, code: string) =>
  (await q<{ status: string; gate_date: string | null }>(db, 'SELECT status, gate_date::text AS gate_date FROM gate_eval($1, $2)', [siteId, code]))[0]!;
const cr = async (entityId: string) =>
  (await q<Record<string, any>>(db, `SELECT kind::text, status::text, suspension_start::text, resumption_date::text, approval_date::text, paired_change_id, record_version,
    register_record_id, withdrawn, effective_from_approval, change_type, applied FROM change_requests WHERE id = $1`, [entityId]))[0];

async function create(t: Team, key: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await t.entry.api.call('post', recPath(key), { site_id: t.site.id, data, ...extra });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
async function newVersion(t: Team, key: string, rec: Record<string, any>, data: Record<string, unknown>): Promise<Record<string, any>> {
  const nv = await t.entry.api.call('post', recPath(key, rec.id, '/versions'), undefined, { 'If-Match': `"${rec.version}"` });
  if (nv.status !== 201) throw new Error(`new version failed: ${nv.status} ${JSON.stringify(nv.body)}`);
  const up = await t.entry.api.call('patch', recPath(key, nv.body.id), { data }, { 'If-Match': `"${nv.body.version}"` });
  if (up.status !== 200) throw new Error(`patch failed: ${up.status} ${JSON.stringify(up.body)}`);
  return up.body as Record<string, any>;
}

describe('Change Control feeds change_requests and the gates (Q103, Q180 coordination)', () => {
  it('an approved suspension and resumption write both dates, pair up, and the gate follows', async () => {
    const t = await team(app, db, 'change_control', 'change_control', R);
    const now = await today();
    await makeTask(db, t.site, 'MS1', 'approved', { actualDate: now });
    expect((await gate(t.site.id, 'G2')).status).toBe('open');

    const s = await create(t, 'change_control', { change_id: cid('SUS'), change_type: 'Suspension', suspension_start: now, request_date: now });
    expect(await cr(s.entity_id)).toBeUndefined();                                        // a draft feeds nothing
    const sDone = await approveFlex(t, s.id, s.version);
    expect(await cr(s.entity_id)).toMatchObject({ kind: 'suspension', status: 'approved', suspension_start: now, approval_date: now, resumption_date: null,
      register_record_id: sDone.id, record_version: 1, effective_from_approval: false, change_type: 'Suspension' });
    expect((await gate(t.site.id, 'G2')).status).toBe('blocked');                          // suspended on the candidate date
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'change_request_fed' AND entity_id = $1`, [s.entity_id])).length).toBe(1);

    // a resumption before the suspension start is refused at submit
    const early = await create(t, 'change_control', { change_id: cid('RES'), change_type: 'Resumption', resumption_date: await daysAgo(30) });
    const bad = await post(t.entry.api, 'change_control', early.id, 'submit', early.version);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/data/resumption_date', code: 'before_suspension' });

    const r = await create(t, 'change_control', { change_id: cid('RES'), change_type: 'Resumption' });   // no effective date: the approval date counts
    await approveFlex(t, r.id, r.version);
    expect(await cr(r.entity_id)).toMatchObject({ kind: 'resumption', status: 'approved', resumption_date: now, approval_date: now, effective_from_approval: true,
      paired_change_id: s.entity_id });
    expect((await cr(s.entity_id))!.paired_change_id).toBe(r.entity_id);
    expect((await gate(t.site.id, 'G2')).status).toBe('open');

    // a second resumption has no open suspension left
    const again = await create(t, 'change_control', { change_id: cid('RES'), change_type: 'Resumption' });
    const res = await post(t.entry.api, 'change_control', again.id, 'submit', again.version);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toContain('no_open_suspension');
  });

  it('a rejected, a voided or a draft record does nothing', async () => {
    const t = await team(app, db, 'change_control', 'change_control', R);
    const now = await today();
    await makeTask(db, t.site, 'MS1', 'approved', { actualDate: now });
    const s = await create(t, 'change_control', { change_id: cid('SUS'), change_type: 'Suspension', suspension_start: now });
    let res = await post(t.entry.api, 'change_control', s.id, 'submit', s.version);
    expect(res.status).toBe(200);
    if (res.body.state === 'in_review') res = await post(t.review.api, 'change_control', s.id, 'review', res.body.version);
    res = await post(t.approve.api, 'change_control', s.id, 'reject', res.body.version, { note: 'Wrong site' });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('entry');
    expect(await cr(s.entity_id)).toBeUndefined();
    const voider = await actor(app, db, { level: 'entry', grants: G('change_control', 'view', 'delete'), regions: [R], modules: null });
    const v = await voider.api.call('post', recPath('change_control', s.id, '/void'), { reason: 'entered by mistake' }, { 'If-Match': `"${res.body.version}"` });
    expect([200, 204]).toContain(v.status);
    expect(await cr(s.entity_id)).toBeUndefined();
    expect((await q(db, 'SELECT 1 FROM change_requests WHERE site_id = $1', [t.site.id])).length).toBe(0);
    expect((await gate(t.site.id, 'G2')).status).toBe('open');
  });

  it('is idempotent on a new version, keeps the approved row while a correction is open or voided, and a withdrawal stops it counting', async () => {
    const t = await team(app, db, 'change_control', 'change_control', R);
    const now = await today();
    await makeTask(db, t.site, 'MS1', 'approved', { actualDate: now });
    const s = await create(t, 'change_control', { change_id: cid('SUS'), change_type: 'Suspension', suspension_start: now });
    const v1 = await approveFlex(t, s.id, s.version);

    // a correction in progress, then voided: the approved row is unchanged
    const draft = await newVersion(t, 'change_control', v1, { reason: 'typo' });
    expect((await cr(s.entity_id))!.record_version).toBe(1);
    const voider = await actor(app, db, { level: 'entry', grants: G('change_control', 'view', 'delete'), regions: [R], modules: null });
    const vd = await voider.api.call('post', recPath('change_control', draft.id, '/void'), { reason: 'not needed' }, { 'If-Match': `"${draft.version}"` });
    expect([200, 204]).toContain(vd.status);
    expect((await cr(s.entity_id))!.record_version).toBe(1);

    // a corrected start, approved: the same row (no second one)
    const cur = (await t.entry.api.call('get', recPath('change_control', s.id))).body;
    const fix = await newVersion(t, 'change_control', cur, { suspension_start: await daysAgo(1) });
    const v2 = await approveFlex(t, fix.id, fix.version);
    expect(await cr(s.entity_id)).toMatchObject({ kind: 'suspension', status: 'approved', suspension_start: await daysAgo(1), record_version: 3, register_record_id: v2.id });
    expect((await q(db, 'SELECT 1 FROM change_requests WHERE site_id = $1', [t.site.id])).length).toBe(1);
    expect((await gate(t.site.id, 'G2')).status).toBe('blocked');

    // withdrawn with a third version: the row stays, marked, and no reader counts it
    const wd = await newVersion(t, 'change_control', v2, { withdrawn: 'Yes', reason: 'suspension cancelled by the client' });
    await approveFlex(t, wd.id, wd.version);
    expect(await cr(s.entity_id)).toMatchObject({ status: 'rejected', withdrawn: true, record_version: 4 });
    expect((await q(db, 'SELECT 1 FROM change_requests WHERE site_id = $1', [t.site.id])).length).toBe(1);
    expect((await gate(t.site.id, 'G2')).status).toBe('open');
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'change_request_refed' AND entity_id = $1`, [s.entity_id])).length).toBe(2);

    // withdrawn on a first version is refused
    const first = await create(t, 'change_control', { change_id: cid('SUS'), change_type: 'Suspension', withdrawn: 'Yes' });
    const res = await post(t.entry.api, 'change_control', first.id, 'submit', first.version);
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ path: '/data/withdrawn', code: 'not_applicable' });
  });

  it('a suspension that a resumption ends cannot be withdrawn first', async () => {
    const t = await team(app, db, 'change_control', 'change_control', R);
    const s = await create(t, 'change_control', { change_id: cid('SUS'), change_type: 'Suspension', suspension_start: await daysAgo(5) });
    const v1 = await approveFlex(t, s.id, s.version);
    const r = await create(t, 'change_control', { change_id: cid('RES'), change_type: 'Resumption', resumption_date: await daysAgo(2) });
    await approveFlex(t, r.id, r.version);
    const wd = await newVersion(t, 'change_control', v1, { withdrawn: 'Yes' });
    const res = await post(t.entry.api, 'change_control', wd.id, 'submit', wd.version);
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ code: 'resumed_already' });
  });

  it('an approved cancellation cancels the site; its withdrawal restores the status', async () => {
    const t = await team(app, db, 'change_control', 'change_control', R);
    const c = await create(t, 'change_control', { change_id: cid('CAN'), change_type: 'Cancellation', reason: 'client dropped the site' });
    const v1 = await approveFlex(t, c.id, c.version);
    expect((await q<{ s: string }>(db, 'SELECT overall_status::text AS s FROM sites WHERE id = $1', [t.site.id]))[0]!.s).toBe('cancelled');
    expect(await cr(c.entity_id)).toMatchObject({ kind: 'other', change_type: 'Cancellation', status: 'approved' });
    const wd = await newVersion(t, 'change_control', v1, { withdrawn: 'Yes' });
    await approveFlex(t, wd.id, wd.version);
    expect((await q<{ s: string }>(db, 'SELECT overall_status::text AS s FROM sites WHERE id = $1', [t.site.id]))[0]!.s).toBe('in_progress');
  });
});

describe('Q225: a site field that changes rules goes through Change Control', () => {
  it('refuses the direct edit, opens a proposal, applies it on approval and refuses a stale one', async () => {
    const t = await team(app, db, 'change_control', 'change_control', R);
    const proposer = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view', 'edit'), ...G('change_control', 'view', 'create', 'edit')], regions: [R], modules: null });
    await regCell(db, 'change_control', R, 'entry', { user: [t.entry.user.id, proposer.user.id] });
    const site = (await proposer.api.call('get', `/sites/${t.site.id}`));
    expect(site.status).toBe(200);
    expect(site.body.custom_fields.find((f: { code: string }) => f.code === 'near_airport')).toMatchObject({ requires_approval: true, can_edit: true });
    const direct = await proposer.api.call('patch', `/sites/${t.site.id}`, { custom: { near_airport: true } }, { 'If-Match': String(site.headers.etag) });
    expect(direct.status).toBe(422);
    expect(direct.body.errors[0]).toMatchObject({ path: '/custom/near_airport', code: 'approval_required' });

    expect((await proposer.api.call('post', `/sites/${t.site.id}/change-proposals`, { custom: { near_airport: true } })).status).toBe(422);   // a reason is required
    const prop = await proposer.api.call('post', `/sites/${t.site.id}/change-proposals`, { custom: { near_airport: true }, reason: 'new airport survey' });
    expect(prop.status).toBe(201);
    expect(prop.body.items[0]).toMatchObject({ field: 'near_airport', old_value: '(none)', new_value: 'Yes' });
    const rec = (await proposer.api.call('get', recPath('change_control', prop.body.items[0].record_id))).body;
    expect(rec.data).toMatchObject({ change_type: 'Scope Change', field_item: 'site.custom.near_airport', old_value: '(none)', new_value: 'Yes' });
    // the approved value stays until the decision
    expect((await q<{ c: Record<string, unknown> }>(db, 'SELECT custom AS c FROM sites WHERE id = $1', [t.site.id]))[0]!.c.near_airport).toBeUndefined();
    await approveFlex({ ...t, entry: proposer }, rec.id, rec.version);
    expect((await q<{ c: Record<string, unknown> }>(db, 'SELECT custom AS c FROM sites WHERE id = $1', [t.site.id]))[0]!.c.near_airport).toBe(true);
    expect(await cr(rec.entity_id)).toMatchObject({ kind: 'scope_change', status: 'applied' });
    expect((await cr(rec.entity_id))!.applied).toMatchObject({ field: 'site.custom.near_airport', before: '(none)', after: 'Yes' });
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'site_change_applied' AND entity_id = $1`, [t.site.id])).length).toBe(1);

    // a stale Old Value is refused at submit; a scope flag is changed the same way
    const stale = await create({ ...t, entry: proposer }, 'change_control', { change_id: cid('SC'), change_type: 'Scope Change', field_item: 'site.custom.near_airport', old_value: 'No', new_value: 'No' });
    const res = await post(proposer.api, 'change_control', stale.id, 'submit', stale.version);
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ path: '/data/old_value', code: 'old_value_changed' });
    const flag = await create({ ...t, entry: proposer }, 'change_control', { change_id: cid('SC'), change_type: 'Scope Change', field_item: 'site.scope_tower_erection', old_value: 'N/A', new_value: 'Yes' });
    await approveFlex({ ...t, entry: proposer }, flag.id, flag.version);
    expect((await q<{ f: string }>(db, 'SELECT scope_tower_erection::text AS f FROM sites WHERE id = $1', [t.site.id]))[0]!.f).toBe('yes');
    const unknown = await create({ ...t, entry: proposer }, 'change_control', { change_id: cid('SC'), change_type: 'Scope Change', field_item: 'site.nothing', old_value: 'a', new_value: 'b' });
    expect((await post(proposer.api, 'change_control', unknown.id, 'submit', unknown.version)).body.errors[0]).toMatchObject({ code: 'unknown_site_field' });
  });
});

describe('the other register feeds (Q103)', () => {
  it('RF & Design fills rf_design_records and the site identity; Acquisition fills its candidates and Master T', async () => {
    const t = await team(app, db, 'rf_design', 'rf_design', R);
    const rf = await create(t, 'rf_design', { site_owner_id: `OWN-${U}`, latitude: 32.5, longitude: 13.1, site_scenario: 'Indoor', tower_height: 30, antenna_height: 28, sectors: 3 });
    expect((await q(db, 'SELECT 1 FROM rf_design_records WHERE id = $1', [rf.entity_id])).length).toBe(0);
    await approveFlex(t, rf.id, rf.version);
    expect((await q<Record<string, unknown>>(db, 'SELECT antenna_height_m::float AS a, sectors, record_version FROM rf_design_records WHERE id = $1', [rf.entity_id]))[0])
      .toMatchObject({ a: 28, sectors: 3, record_version: 1 });
    expect((await q<Record<string, unknown>>(db, `SELECT owner_site_id, latitude::float AS lat, site_scenario, delivery_scenario::text AS ds, tower_height_m::float AS th FROM sites WHERE id = $1`, [t.site.id]))[0])
      .toMatchObject({ owner_site_id: `OWN-${U}`, lat: 32.5, site_scenario: 'Indoor', ds: 'new_build', th: 30 });   // 0070 (G8): the RF Site Scenario is Indoor / Outdoor, it no longer moves the Delivery Scenario
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'site_identity_fed' AND entity_id = $1`, [t.site.id])).length).toBe(1);
    // Q476 (0072): the site had no coordinates, so the feed filled them, and the audit says so
    const fed = await q<{ before: any; after: any; reason: string; region_id: number }>(db, `SELECT before, after, reason, region_id FROM audit_log WHERE action = 'site_coordinates_fed' AND entity_id = $1`, [t.site.id]);
    expect(fed).toHaveLength(1);
    expect(fed[0]).toMatchObject({ before: { latitude: null, longitude: null }, after: { latitude: 32.5, longitude: 13.1, record_id: rf.id }, region_id: R });
    expect(fed[0]!.reason).toMatch(/Q476/);

    const a = await team(app, db, 'acquisition', 'acquisition', R);
    const signed = await daysAgo(3);
    const cand = await create(a, 'acquisition', { candidate: 'A', selected: 'Yes', selection_date: await daysAgo(10), contract_signoff_date: signed, owner_landlord: 'Owner One' });
    await approveFlex(a, cand.id, cand.version);
    expect((await q<Record<string, unknown>>(db, 'SELECT selected, contract_signoff_date::text AS d, owner_name FROM acquisition_candidates WHERE id = $1', [cand.entity_id]))[0])
      .toMatchObject({ selected: true, d: signed, owner_name: 'Owner One' });
    expect((await q<{ d: string }>(db, 'SELECT acquisition_date::text AS d FROM sites WHERE id = $1', [a.site.id]))[0]!.d).toBe(signed);
    expect((await q(db, `SELECT 1 FROM register_task_sources WHERE register_key = 'acquisition' AND task_code = 'A3'`)).length).toBe(1);
  });

  it('Readiness, Issues and Risks fill their typed tables; Readiness is the source of D17 and Z1', async () => {
    const t = await team(app, db, 'readiness_handover', 'readiness', R);
    const rd = await create(t, 'readiness_handover', { commissioning_power_safe_date: await daysAgo(9), om_checklist: 'Done', om_acceptance_date: await daysAgo(4) });
    await approveFlex(t, rd.id, rd.version);
    expect((await q<Record<string, unknown>>(db, 'SELECT commissioning_power_safe AS p, om_acceptance_date::text AS d, closure_ready FROM readiness_handover WHERE id = $1', [rd.entity_id]))[0])
      .toMatchObject({ p: true, d: await daysAgo(4), closure_ready: false });
    expect((await q<{ c: string }>(db, `SELECT task_code AS c FROM register_task_sources WHERE register_key = 'readiness_handover' ORDER BY sort_order`)).map((r) => r.c)).toEqual(['D17', 'Z1']);

    const i = await team(app, db, 'issues', 'issues', R);
    const iss = await create(i, 'issues', { pending_issue: 'Landlord blocks access', owner_user: i.entry.user.id, raised_date: await daysAgo(6), issue_status: 'Open', blocked_gate_or_task: 'G3' });
    await approveFlex(i, iss.id, iss.version);
    expect((await q<Record<string, unknown>>(db, 'SELECT title, status::text AS s, blocked_gate_or_task AS b FROM issues WHERE id = $1', [iss.entity_id]))[0])
      .toMatchObject({ title: 'Landlord blocks access', s: 'open', b: 'G3' });
    const site = await i.entry.api.call('get', `/sites/${i.site.id}`);
    if (site.status === 200) expect(site.body.counts.open_issues).toBe(1);
  });

  it('a risk is projected with its assessment; a risk without one is not (never a 0 score)', async () => {
    // Risks are global rows whose Matrix cells belong to other suites: the feed function is run directly on approved records (as the migration role)
    const mk = async (data: Record<string, unknown>): Promise<string> => (await q<{ id: string }>(db,
      `INSERT INTO register_records (entity_id, register_key, is_global, state, is_current, version_no, data, approved_at) VALUES (gen_random_uuid(), 'risks', true, 'approved', true, 1, $1, now()) RETURNING id`,
      [JSON.stringify(data)]))[0]!.id;
    const full = await mk({ risk_id: cid('RSK'), risk_statement: 'Fuel shortage', probability: 3, impact: 4, status: 'Open' });
    const bare = await mk({ risk_id: cid('RSK'), risk_statement: 'No assessment yet' });
    await db.query('SELECT p4a_feed_issue_risk($1), p4a_feed_issue_risk($2)', [full, bare]);
    const rows = await q<Record<string, unknown>>(db, `SELECT r.register_record_id AS rid, r.probability, r.impact, r.status::text AS s, r.is_global FROM risks r WHERE r.register_record_id IN ($1, $2)`, [full, bare]);
    expect(rows).toEqual([{ rid: full, probability: 3, impact: 4, s: 'open', is_global: true }]);
  });
});

describe('Q113 / Q108: the As-Built CW and TE parts', () => {
  it('BU and EF come from the submissions of the parts, one record per site and part, values stay in their part', async () => {
    const t = await team(app, db, 'as_built', 'as_built', R);
    const cw = await create(t, 'as_built', { q_tower: 30 }, { record_type: 'cw_part' });
    expect(cw.record_type).toBe('cw_part');
    const typed = await t.entry.api.call('post', recPath('as_built'), { site_id: t.site.id, record_type: 'te_part', data: { cw_as_built_submitted: 'Yes' } });
    expect(typed.status).toBe(422);                                                    // BU is never typed
    const dup = await t.entry.api.call('post', recPath('as_built'), { site_id: t.site.id, record_type: 'cw_part', data: {} });
    expect(dup.status).toBe(409);
    const cwDone = await approveFlex(t, cw.id, cw.version);
    expect(cwDone.data).toMatchObject({ cw_as_built_submitted: 'Yes', cw_submitted_date: await today() });

    // no record type named: inferred from the values (a TE value = the TE part)
    const te = await create(t, 'as_built', { wl_vendor: 'Cambium', rf_height: 31.5, q_tower: 5 });
    expect(te.record_type).toBe('te_part');
    const bad = await post(t.entry.api, 'as_built', te.id, 'submit', te.version);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/data/q_tower', code: 'not_applicable' });
    const wrong = await t.entry.api.call('patch', recPath('as_built', te.id), { data: { router_type: 'NOT-A-ROUTER' } }, { 'If-Match': `"${te.version}"` });
    expect(wrong.status).toBe(422);                                                   // Q108: only an item of the Warehouse group IP
    expect(wrong.body.errors[0]).toMatchObject({ path: '/data/router_type', code: 'not_in_list' });
    const ok = await t.entry.api.call('patch', recPath('as_built', te.id), { data: { q_tower: null, router_type: 'S9500' } }, { 'If-Match': `"${te.version}"` });
    expect(ok.status).toBe(200);
    const teDone = await approveFlex(t, te.id, ok.body.version);
    expect(teDone.data.as_built_date).toBe(await today());                            // EF = the submission date, never the approval date

    const ab = (await q<Record<string, any>>(db, `SELECT cw_as_built_submitted, cw_submitted_date::text AS cwd, te_submitted_date::text AS ted, quantities, rf_height_m::float AS rh
      FROM as_built_records WHERE site_id = $1`, [t.site.id]))[0]!;
    expect(ab).toMatchObject({ cw_as_built_submitted: 'Yes', cwd: await today(), ted: await today(), rh: 31.5 });
    expect(ab.quantities).toMatchObject({ TOWER: 30 });

    // a typed vendor submission date is kept as EF; an N/A part needs a reason and gives BU N/A
    const t2 = await team(app, db, 'as_built', 'as_built', R);
    const vendor = await daysAgo(20);
    const te2 = await create(t2, 'as_built', { as_built_date: vendor }, { record_type: 'te_part' });
    expect((await approveFlex(t2, te2.id, te2.version)).data.as_built_date).toBe(vendor);
    const na = await create(t2, 'as_built', { part_not_applicable: 'Yes' }, { record_type: 'cw_part' });
    expect((await post(t2.entry.api, 'as_built', na.id, 'submit', na.version)).body.errors[0]).toMatchObject({ path: '/data/na_reason', code: 'required' });
    const na2 = await t2.entry.api.call('patch', recPath('as_built', na.id), { data: { na_reason: 'no civil works' } }, { 'If-Match': `"${na.version}"` });
    expect((await approveFlex(t2, na.id, na2.body.version)).data.cw_as_built_submitted).toBe('N/A');
  });

  it('the item-type fields list the active Warehouse items of their group (Q108)', async () => {
    const f = (await q<{ options: string[] | null }>(db, `SELECT options FROM register_fields WHERE register_key = 'as_built' AND code = 'router_type'`))[0]!;
    expect(f.options).toEqual(expect.arrayContaining(['S9500', 'S9501', 'S9700']));
    expect((await q<{ rt: string[] }>(db, `SELECT record_types AS rt FROM register_definitions WHERE register_key = 'as_built'`))[0]!.rt).toEqual(['cw_part', 'te_part']);
  });
});

describe('Q476 (migration 0072): the RF & Design feed fills the coordinates only while the site has none', () => {
  const coords = async (siteId: string) => (await q<{ lat: number | null; lon: number | null }>(db, 'SELECT latitude::float8 AS lat, longitude::float8 AS lon FROM sites WHERE id = $1', [siteId]))[0]!;
  const audit = (action: string, siteId: string) => q<{ before: any; after: any; reason: string; region_id: number }>(
    db, 'SELECT before, after, reason, region_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, siteId]);

  it('fills an empty site once, audits it, and a later version with other coordinates changes nothing about them (the other fields still follow)', async () => {
    const t = await team(app, db, 'rf_design', 'rf_design', R);
    expect(await coords(t.site.id)).toEqual({ lat: null, lon: null });
    const v1 = await create(t, 'rf_design', { site_owner_id: `OWN-${U}-1`, latitude: 32.5, longitude: 13.1, tower_height: 30 });
    const v1done = await approveFlex(t, v1.id, v1.version);
    expect(await coords(t.site.id)).toEqual({ lat: 32.5, lon: 13.1 });
    expect(await audit('site_coordinates_fed', t.site.id)).toHaveLength(1);
    expect(await audit('site_coordinates_kept', t.site.id)).toHaveLength(0);

    const v2 = await newVersion(t, 'rf_design', v1done, { site_owner_id: `OWN-${U}-2`, latitude: 33.9, longitude: 14.2, tower_height: 36 });
    await approveFlex(t, v2.id, v2.version);
    expect(await coords(t.site.id)).toEqual({ lat: 32.5, lon: 13.1 });                          // not overwritten
    expect((await q<Record<string, unknown>>(db, 'SELECT owner_site_id, tower_height_m::float AS th FROM sites WHERE id = $1', [t.site.id]))[0])
      .toMatchObject({ owner_site_id: `OWN-${U}-2`, th: 36 });                                  // everything else is as before 0072
    expect(await audit('site_coordinates_fed', t.site.id)).toHaveLength(1);                     // no second "fed"
    const kept = await audit('site_coordinates_kept', t.site.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ before: { latitude: 32.5, longitude: 13.1 }, after: { latitude: 33.9, longitude: 14.2, applied: false }, region_id: R });
    expect(kept[0]!.reason).toMatch(/Change Control proposal/);
  });

  it('a site that already has coordinates keeps them when its first RF & Design record is approved', async () => {
    const t = await team(app, db, 'rf_design', 'rf_design', R);
    await db.query('UPDATE sites SET latitude = 30.25, longitude = 11.5 WHERE id = $1', [t.site.id]);
    const rf = await create(t, 'rf_design', { site_owner_id: `OWN-${U}-3`, latitude: 32.5, longitude: 13.1 });
    const rfDone = await approveFlex(t, rf.id, rf.version);
    expect(await coords(t.site.id)).toEqual({ lat: 30.25, lon: 11.5 });
    expect(await audit('site_coordinates_fed', t.site.id)).toHaveLength(0);
    expect(await audit('site_coordinates_kept', t.site.id)).toHaveLength(1);
    // the same coordinates are not reported as a difference
    const same = await newVersion(t, 'rf_design', rfDone, { latitude: 30.25, longitude: 11.5 });
    await approveFlex(t, same.id, same.version);
    expect(await audit('site_coordinates_kept', t.site.id)).toHaveLength(1);
  });

  it('a record with only one of the pair, or with no coordinates, fills nothing', async () => {
    const t = await team(app, db, 'rf_design', 'rf_design', R);
    const half = await create(t, 'rf_design', { site_owner_id: `OWN-${U}-4`, latitude: 32.5 });
    const halfDone = await approveFlex(t, half.id, half.version);
    expect(await coords(t.site.id)).toEqual({ lat: null, lon: null });
    const none = await newVersion(t, 'rf_design', halfDone, { site_owner_id: `OWN-${U}-5` });
    await approveFlex(t, none.id, none.version);
    expect(await coords(t.site.id)).toEqual({ lat: null, lon: null });
    expect(await audit('site_coordinates_fed', t.site.id)).toHaveLength(0);
  });
});
