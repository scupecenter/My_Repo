import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { beginAs, delegate, startApp, superDb } from './helpers';
import { G, Team, approveFlex, post, recPath, regCell } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0071 (technical decision Q473, contract 0.14.1): the identity of a site changes only through a Change Control proposal. L1 proposes, L2 approves,
 * the change is audited with before and after values. The English and Arabic names and the coordinates go through the proposal path of Q225; region and cluster are
 * for a System Admin only; the Site ID never changes; no direct write path is left. Region 6 (GM) is the working region and region 5 (Benghazi) the target region
 * of a move: no other suite sets Change Control cells there (the matrix lock of the register suites is held per test).
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 6;
const TO = 5;
const TAG = randomBytes(2).toString('hex').toUpperCase();
let n = 0;
let lead: Actor;      // a Team Lead: L1 of Change Control, may edit sites in the region, not a System Admin
let l2: Actor;        // a non-admin L2 of Change Control
let adminA: Actor;    // a System Admin, L1
let adminB: Actor;    // a System Admin, L2
let delegated: Actor; // a person with a delegation of sites and Change Control rights, not a System Admin

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  lead = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view', 'edit'), ...G('change_control', 'view', 'create', 'edit')], regions: [R], modules: null });
  l2 = await actor(app, db, { level: 'approve', grants: [...G('sites', 'view'), ...G('change_control', 'view', 'approve')], regions: [R], modules: null });
  adminA = await plainAdmin(app, db);
  adminB = await plainAdmin(app, db);
  delegated = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view'), ...G('change_control', 'view', 'create')], regions: [R], modules: null });
  await delegate(db, delegated.user.id, [['sites', 'administer'], ['sites', 'edit'], ['change_control', 'create'], ['change_control', 'administer']]);
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
  await regCell(db, 'change_control', R, 'entry', { user: [lead.user.id, adminA.user.id, delegated.user.id] });
  await regCell(db, 'change_control', R, 'approve', { user: [l2.user.id, adminB.user.id] });
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const tag = (): string => `SI${TAG}${++n}`;
const SELECT_SITE = `SELECT site_code, name, name_ar, latitude::float8 AS lat, longitude::float8 AS lon, region_id, cluster_id, (SELECT cluster_code FROM clusters c WHERE c.id = s.cluster_id) AS cluster
  FROM sites s WHERE id = $1`;
type SiteCols = { site_code: string; name: string; name_ar: string | null; lat: number | null; lon: number | null; region_id: number; cluster_id: string | null; cluster: string | null };
const siteRow = async (id: string): Promise<SiteCols> => (await q<SiteCols>(db, SELECT_SITE, [id]))[0]!;
const cluster = async (code: string, region: number | null): Promise<string> =>
  (await q<{ id: string }>(db, 'INSERT INTO clusters (cluster_code, region_id, is_global) VALUES ($1, $2, $3) RETURNING id', [code, region, region === null]))[0]!.id;
const proposals = (id: string) => `/sites/${id}/change-proposals`;
const crOf = async (entityId: string) => (await q<Record<string, any>>(db, 'SELECT status::text, applied, change_type, scope_item FROM change_requests WHERE id = $1', [entityId]))[0];
const auditOf = (action: string, siteId: string) => q<{ before: any; after: any; reason: string; region_id: number | null }>(
  db, 'SELECT before, after, reason, region_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, siteId]);

/** The team that proposes (L1) and decides (L2) a change of a site; `admin` = both are System Admins (needed for region and cluster). */
const teamOf = (site: { id: string; code: string; region: number }, admin: boolean): Team => ({
  entry: admin ? adminA : lead, review: admin ? adminA : lead, approve: admin ? adminB : l2, site, region: R, key: 'change_control',
});
async function propose(by: Actor, siteId: string, identity: Record<string, unknown>, reason = 'owner correction'): Promise<any> {
  return by.api.call('post', proposals(siteId), { identity, reason });
}
async function record(by: Actor, id: string): Promise<Record<string, any>> {
  const res = await by.api.call('get', recPath('change_control', id));
  expect(res.status).toBe(200);
  return res.body;
}

describe('Q473: the names and the coordinates change through a proposal', () => {
  it('proposes and approves the English name: the site keeps its name until L2 decides; the change is audited with before and after', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const before = await siteRow(site.id);
    const res = await propose(lead, site.id, { name: `  Corrected ${tag()}  ` });
    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item).toMatchObject({ field: 'name', old_value: before.name });
    expect(item.new_value).toMatch(/^Corrected SI/);
    const rec = await record(lead, item.record_id);
    expect(rec.data).toMatchObject({ change_type: 'Data Correction', change_scope: 'Field', field_item: 'site.name', old_value: before.name, new_value: item.new_value });
    expect((await siteRow(site.id)).name).toBe(before.name);                       // a proposal changes nothing

    await approveFlex(teamOf(site, false), rec.id, rec.version);
    expect((await siteRow(site.id)).name).toBe(item.new_value);
    expect(await crOf(rec.entity_id)).toMatchObject({ status: 'applied', change_type: 'Data Correction', scope_item: 'site.name' });
    const a = (await auditOf('site_change_applied', site.id))[0]!;
    expect(a.before).toMatchObject({ field: 'site.name', value: before.name, columns: { name: before.name } });
    expect(a.after).toMatchObject({ field: 'site.name', before: before.name, after: item.new_value, columns_after: { name: item.new_value } });
    expect(a.reason).toContain('Q473');
    expect((await auditOf('site_change_proposed', site.id)).length).toBe(1);
  });

  it('proposes the Arabic name, then clears it with null', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const set = await propose(lead, site.id, { name_ar: 'موقع تجريبي مصحَّح' });
    expect(set.status).toBe(201);
    expect(set.body.items[0]).toMatchObject({ field: 'name_ar', old_value: '(none)', new_value: 'موقع تجريبي مصحَّح' });
    const rec = await record(lead, set.body.items[0].record_id);
    await approveFlex(teamOf(site, false), rec.id, rec.version);
    expect((await siteRow(site.id)).name_ar).toBe('موقع تجريبي مصحَّح');

    const clear = await propose(lead, site.id, { name_ar: null });
    expect(clear.status).toBe(201);
    expect(clear.body.items[0]).toMatchObject({ old_value: 'موقع تجريبي مصحَّح', new_value: '(none)' });
    const rec2 = await record(lead, clear.body.items[0].record_id);
    await approveFlex(teamOf(site, false), rec2.id, rec2.version);
    expect((await siteRow(site.id)).name_ar).toBeNull();
  });

  it('proposes the coordinates as one pair and checks the ranges as the site creation does', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const bad = await propose(lead, site.id, { latitude: 91, longitude: 13.1 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/identity/latitude', code: 'invalid' });
    const bad2 = await propose(lead, site.id, { latitude: 32.5, longitude: 181 });
    expect(bad2.body.errors[0]).toMatchObject({ path: '/identity/longitude', code: 'invalid' });
    const half = await propose(lead, site.id, { latitude: 32.5 });
    expect(half.status).toBe(422);
    expect(half.body.errors[0]).toMatchObject({ path: '/identity/longitude', code: 'pair_required' });
    const blank = await propose(lead, site.id, { latitude: 32.5, longitude: null });
    expect(blank.body.errors[0]).toMatchObject({ path: '/identity/longitude', code: 'pair_required' });
    const cleared = await propose(lead, site.id, { latitude: null, longitude: null });
    expect(cleared.status).toBe(422);                                                // a pair is replaced, never cleared
    expect((await siteRow(site.id)).lat).toBeNull();

    const ok = await propose(lead, site.id, { latitude: 32.887212345, longitude: 13.191338 });
    expect(ok.status).toBe(201);
    expect(ok.body.items[0]).toMatchObject({ field: 'coordinates', old_value: '(none)', new_value: '32.887212, 13.191338' });
    const rec = await record(lead, ok.body.items[0].record_id);
    await approveFlex(teamOf(site, false), rec.id, rec.version);
    expect(await siteRow(site.id)).toMatchObject({ lat: 32.887212, lon: 13.191338 });
    expect((await auditOf('site_change_applied', site.id))[0]!.after).toMatchObject({ before: '(none)', after: '32.887212, 13.191338' });

    const same = await propose(lead, site.id, { latitude: 32.887212, longitude: 13.191338 });
    expect(same.status).toBe(422);
    expect(same.body.errors[0]).toMatchObject({ code: 'unchanged' });
  });

  it('validates the shape: a reason, at least one field, unknown fields, a name that is not empty or too long', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    expect((await lead.api.call('post', proposals(site.id), { identity: { name: 'X' } })).status).toBe(422);                        // a reason is required
    expect((await lead.api.call('post', proposals(site.id), { reason: 'x' })).status).toBe(422);                                    // custom or identity
    expect((await propose(lead, site.id, {})).status).toBe(422);
    const unk = await propose(lead, site.id, { owner_site_id: 'X1' });
    expect(unk.body.errors[0]).toMatchObject({ path: '/identity/owner_site_id', code: 'unknown_field' });
    expect((await propose(lead, site.id, { name: '   ' })).body.errors[0]).toMatchObject({ path: '/identity/name', code: 'required' });
    expect((await propose(lead, site.id, { name: 'x'.repeat(201) })).body.errors[0]).toMatchObject({ path: '/identity/name', code: 'too_long' });
    expect((await propose(lead, site.id, { name: true })).body.errors[0]).toMatchObject({ path: '/identity/name', code: 'invalid' });
    expect((await propose(lead, site.id, { name: (await siteRow(site.id)).name })).body.errors[0]).toMatchObject({ code: 'unchanged' });
    expect((await lead.api.call('post', proposals('00000000-0000-4000-8000-000000000000'), { identity: { name: 'X' }, reason: 'x' })).status).toBe(404);
  });

  it('a custom field and the identity can be proposed together, one draft each', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const res = await lead.api.call('post', proposals(site.id), { custom: { near_airport: true }, identity: { name: `Both ${tag()}` }, reason: 'both' });
    expect(res.status).toBe(201);
    expect(res.body.items.map((i: { field: string }) => i.field).sort()).toEqual(['name', 'near_airport']);
  });

  it('a stale Old Value of a hand-made record is refused at submit, and the identity items are validated there too', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const t = teamOf(site, false);
    const mk = async (data: Record<string, unknown>) => {
      const r = await lead.api.call('post', recPath('change_control'), { site_id: site.id, data: { change_id: `H-${tag()}`, change_type: 'Data Correction', change_scope: 'Field', reason: 'x', ...data } });
      expect(r.status).toBe(201);
      return r.body as Record<string, any>;
    };
    const cur = (await siteRow(site.id)).name;
    const stale = await mk({ field_item: 'site.name', old_value: 'not the name', new_value: 'Whatever' });
    const s1 = await post(t.entry.api, 'change_control', stale.id, 'submit', stale.version);
    expect(s1.status).toBe(422);
    expect(s1.body.errors[0]).toMatchObject({ path: '/data/old_value', code: 'old_value_changed' });
    const bad = await mk({ field_item: 'site.coordinates', old_value: '(none)', new_value: '95, 10' });
    expect((await post(t.entry.api, 'change_control', bad.id, 'submit', bad.version)).body.errors[0]).toMatchObject({ code: 'invalid' });
    const noop = await mk({ field_item: 'site.name', old_value: cur, new_value: cur });
    expect((await post(t.entry.api, 'change_control', noop.id, 'submit', noop.version)).body.errors[0]).toMatchObject({ path: '/data/new_value', code: 'unchanged' });
    const ok = await mk({ field_item: 'site.name', old_value: cur, new_value: `Hand ${tag()}` });
    const done = await approveFlex(t, ok.id, ok.version);
    expect(done.state).toBe('approved');
    expect((await siteRow(site.id)).name).toMatch(/^Hand SI/);
  });
});

describe('Q473: region and cluster are for a System Admin', () => {
  it('a System Admin moves a site to another region with a cluster of that region: the children follow, the site is recalculated, both regions see the audit', async () => {
    const oldCluster = tag(); const newCluster = tag();
    const oc = await cluster(`OLD-${oldCluster}`, R);
    await cluster(`NEW-${newCluster}`, TO);
    const site = await makeSite(db, R, { prefix: 'SI', cluster: oc });
    const taskId = await makeTask(db, site, 'MS1', 'open');
    const t = teamOf(site, true);
    const sameReg = await adminA.api.call('post', proposals(site.id), { identity: { region_id: TO }, reason: 'wrong region in the Master' });
    expect(sameReg.status).toBe(422);                                                           // the site's cluster belongs to the old region
    expect(sameReg.body.errors[0]).toMatchObject({ path: '/identity/cluster_code', code: 'cluster_other_region' });

    const res = await propose(adminA, site.id, { region_id: TO, cluster_code: `new-${newCluster}` }, 'wrong region in the Master');
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ field: 'region', old_value: `GM / OLD-${oldCluster}`, new_value: `Benghazi / NEW-${newCluster}` });
    const rec = await record(adminA, res.body.items[0].record_id);
    expect(rec.data).toMatchObject({ field_item: 'site.region', change_type: 'Data Correction' });
    expect((await siteRow(site.id)).region_id).toBe(R);                                         // the approved value stays until L2 decides

    await approveFlex(t, rec.id, rec.version);
    expect(await siteRow(site.id)).toMatchObject({ region_id: TO, cluster: `NEW-${newCluster}` });
    expect((await q<{ r: number }>(db, 'SELECT region_id AS r FROM task_instances WHERE id = $1', [taskId]))[0]!.r).toBe(TO);   // the composite key follows
    expect((await q<{ r: number }>(db, 'SELECT region_id AS r FROM register_records WHERE id = $1', [rec.id]))[0]!.r).toBe(TO);
    expect(await crOf(rec.entity_id)).toMatchObject({ status: 'applied' });
    const moved = await auditOf('site_change_applied', site.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ region_id: TO });
    expect(moved[0]!.before).toMatchObject({ columns: { region_id: R, cluster_code: `OLD-${oldCluster}` } });
    expect(moved[0]!.after).toMatchObject({ columns_after: { region_id: TO, cluster_code: `NEW-${newCluster}` } });
    expect(await auditOf('site_region_moved_out', site.id)).toMatchObject([{ region_id: R }]);   // the lead of the old region sees the move too

    // who can see the site follows the region
    const inTo = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [TO], modules: null });
    const inFrom = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
    expect((await inTo.api.call('get', `/sites/${site.id}`)).status).toBe(200);
    expect((await inFrom.api.call('get', `/sites/${site.id}`)).status).toBe(404);
  });

  it('a global cluster may stay; a region change alone keeps it, and "none" clears the cluster', async () => {
    const g = await cluster(`GLB-${tag()}`, null);
    const site = await makeSite(db, R, { prefix: 'SI', cluster: g });
    const t = teamOf(site, true);
    // once the site is in the new region, its records follow that region's cells of the Matrix: the same two System Admins hold them there
    await regCell(db, 'change_control', TO, 'entry', { user: [adminA.user.id] });
    await regCell(db, 'change_control', TO, 'approve', { user: [adminB.user.id] });
    const res = await propose(adminA, site.id, { region_id: TO });
    expect(res.status).toBe(201);
    expect(res.body.items[0].new_value).toMatch(/^Benghazi \/ GLB-/);
    const rec = await record(adminA, res.body.items[0].record_id);
    await approveFlex(t, rec.id, rec.version);
    expect(await siteRow(site.id)).toMatchObject({ region_id: TO, cluster_id: g });

    const clr = await propose(adminA, site.id, { cluster_code: null });
    expect(clr.status).toBe(201);
    expect(clr.body.items[0]).toMatchObject({ field: 'cluster', new_value: '(none)' });
    const rec2 = await record(adminA, clr.body.items[0].record_id);
    await approveFlex(t, rec2.id, rec2.version);
    expect((await siteRow(site.id)).cluster_id).toBeNull();
  });

  it('a cluster in the wrong region, an unknown cluster and the same region are refused; a cluster of the site region or a global one is accepted', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const foreign = `FOR-${tag()}`; const own = `OWN-${tag()}`; const glob = `GLO-${tag()}`;
    await cluster(foreign, TO); await cluster(own, R); await cluster(glob, null);
    const wrong = await propose(adminA, site.id, { cluster_code: foreign });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors[0]).toMatchObject({ path: '/identity/cluster_code', code: 'cluster_other_region' });
    const unknown = await propose(adminA, site.id, { cluster_code: `NOPE-${tag()}` });
    expect(unknown.body.errors[0]).toMatchObject({ path: '/identity/cluster_code', code: 'unknown_cluster' });
    // a new region and a cluster of another region than the new one
    const mixed = await propose(adminA, site.id, { region_id: TO, cluster_code: own });
    expect(mixed.status).toBe(422);
    expect(mixed.body.errors[0]).toMatchObject({ code: 'cluster_other_region' });
    expect((await propose(adminA, site.id, { region_id: 99 })).body.errors[0]).toMatchObject({ path: '/identity/region_id', code: 'unknown_region' });
    expect((await propose(adminA, site.id, { region_id: R })).body.errors[0]).toMatchObject({ path: '/identity/region_id', code: 'unchanged' });
    const okOwn = await propose(adminA, site.id, { cluster_code: own });
    expect(okOwn.status).toBe(201);
    expect((await propose(adminA, site.id, { cluster_code: glob })).status).toBe(201);
    // the cluster of a hand-made record is checked at submit as well, and again at the approval against the site as it is then
    const rec = await record(adminA, okOwn.body.items[0].record_id);
    await approveFlex(teamOf(site, true), rec.id, rec.version);
    expect((await siteRow(site.id)).cluster).toBe(own);
    expect(await auditOf('site_change_applied', site.id)).toHaveLength(1);
  });

  it('a Team Lead and a delegate get 403 for a region or a cluster, before any other check; the site is unchanged', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const c = await cluster(`TL-${tag()}`, R);
    for (const who of [lead, delegated]) {
      for (const identity of [{ region_id: TO }, { cluster_code: `TL-${tag()}` }, { region_id: TO, cluster_code: null }, { region_id: 99 }]) {
        const res = await propose(who, site.id, identity);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('action_forbidden');
      }
    }
    expect((await propose(lead, site.id, { cluster_code: 'x', site_code: 'y' })).status).toBe(403);
    expect(await siteRow(site.id)).toMatchObject({ region_id: R, cluster_id: null });
    expect((await q(db, `SELECT 1 FROM register_records WHERE register_key = 'change_control' AND site_id = $1`, [site.id])).length).toBe(0);
    expect(c).toBeTruthy();
  });

  it('a hand-made Change Control record for the region is refused at submit for a non-admin, and an approval by a non-admin is refused; the site is unchanged', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const own = `OWN-${tag()}`;
    await cluster(own, R);
    const mk = async (by: Actor, data: Record<string, unknown>) => {
      const r = await by.api.call('post', recPath('change_control'), { site_id: site.id, data: { change_id: `H-${tag()}`, change_type: 'Data Correction', change_scope: 'Field', reason: 'x', ...data } });
      expect(r.status).toBe(201);
      return r.body as Record<string, any>;
    };
    const name = (await siteRow(site.id)).name;
    // a non-admin L1 cannot submit it
    const byLead = await mk(lead, { field_item: 'site.cluster', old_value: '(none)', new_value: own });
    const s = await post(lead.api, 'change_control', byLead.id, 'submit', byLead.version);
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('action_forbidden');
    // an admin L1 submits it; a non-admin L2 cannot approve it
    const byAdmin = await mk(adminA, { field_item: 'site.cluster', old_value: '(none)', new_value: own });
    const sub = await post(adminA.api, 'change_control', byAdmin.id, 'submit', byAdmin.version);
    expect(sub.status).toBe(200);
    await l2.api.stepUp(l2.user.password);
    const ap = await post(l2.api, 'change_control', byAdmin.id, 'approve', sub.body.version);
    expect(ap.status).toBe(403);
    expect(ap.body.code).toBe('action_forbidden');
    expect(await siteRow(site.id)).toMatchObject({ cluster_id: null, name, region_id: R });
    expect((await record(adminA, byAdmin.id)).state).toBe('in_approval');
    // the admin L2 can
    await adminB.api.stepUp(adminB.user.password);
    expect((await post(adminB.api, 'change_control', byAdmin.id, 'approve', sub.body.version)).status).toBe(200);
    expect((await siteRow(site.id)).cluster).toBe(own);
  });
});

describe('Q473: the Site ID never changes', () => {
  it('the proposal names the Site ID and gets the field error immutable, for a Team Lead and for a System Admin', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    for (const who of [lead, adminA]) {
      const res = await propose(who, site.id, { site_code: `NEW-${tag()}` });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ path: '/identity/site_code', code: 'immutable' })]);
    }
    const mixed = await propose(lead, site.id, { name: `Fine ${tag()}`, site_code: 'X1' });
    expect(mixed.status).toBe(422);                                                             // nothing is proposed when one field is refused
    expect((await q(db, `SELECT 1 FROM register_records WHERE register_key = 'change_control' AND site_id = $1`, [site.id])).length).toBe(0);
    expect((await siteRow(site.id)).site_code).toBe(site.code);
  });

  it('a hand-made Change Control record that names site.site_code is refused at submit with immutable', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const r = await lead.api.call('post', recPath('change_control'), { site_id: site.id, data: { change_id: `H-${tag()}`, change_type: 'Scope Change', change_scope: 'Field', field_item: 'site.site_code',
      old_value: site.code, new_value: 'ZZ999', reason: 'x' } });
    expect(r.status).toBe(201);
    const s = await post(lead.api, 'change_control', r.body.id, 'submit', r.body.version);
    expect(s.status).toBe(422);
    expect(s.body.errors[0]).toMatchObject({ path: '/data/field_item', code: 'immutable' });
    expect((await siteRow(site.id)).site_code).toBe(site.code);
  });

  it('the database refuses an update of the Site ID for the application role and for the definer functions', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    await db.query('BEGIN');
    try {
      await beginAs(db, adminA.user.id);                                                         // the signed context of a System Admin: the policy lets every row through
      await db.query('SET LOCAL ROLE pmis_definer');
      await expect(db.query('UPDATE sites SET site_code = $1 WHERE id = $2', [`X-${tag()}`, site.id])).rejects.toThrow(/never changes/);
    } finally {
      await db.query('ROLLBACK');
    }
    expect((await siteRow(site.id)).site_code).toBe(site.code);
  });
});

describe('Q473: no direct write path is left', () => {
  let appDb: Client;
  beforeAll(async () => {
    appDb = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await appDb.connect();
  });
  afterAll(async () => { await appDb.end(); });

  it('pmis_app cannot update the identity columns of a site, and cannot call the old region-transfer function', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const before = await siteRow(site.id);
    for (const col of ['site_code', 'name', 'name_ar', 'region_id', 'cluster_id', 'latitude', 'longitude']) {
      const value = col === 'region_id' ? TO : col === 'cluster_id' ? null : col === 'latitude' || col === 'longitude' ? 1.5 : 'direct';
      await expect(appDb.query(`UPDATE sites SET ${col} = $1 WHERE id = $2`, [value, site.id]), col).rejects.toThrow(/permission denied/);
    }
    await expect(appDb.query('SELECT admin_transfer_site_region($1, $2, $3)', [site.id, TO, 'direct'])).rejects.toThrow(/does not exist/);
    expect(await siteRow(site.id)).toEqual(before);
    // the other columns keep their update right (the calculation and the other approved paths write them)
    expect(((await db.query(`SELECT has_column_privilege('pmis_app', 'sites', 'overall_status', 'UPDATE') AS ok`)).rows[0] as { ok: boolean }).ok).toBe(true);
    expect(((await db.query(`SELECT has_table_privilege('pmis_app', 'sites', 'UPDATE') AS ok`)).rows[0] as { ok: boolean }).ok).toBe(false);
  });

  it('PATCH /sites/{id} and site_save_custom write the custom values only', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const before = await siteRow(site.id);
    const got = await lead.api.call('get', `/sites/${site.id}`);
    expect(got.status).toBe(200);
    const headers = { 'If-Match': String(got.headers.etag) };
    for (const body of [{ name: 'X' }, { name_ar: 'X' }, { latitude: 1, longitude: 2 }, { region_id: TO }, { cluster_code: 'X' }, { site_code: 'X' }, { custom: { name_ar: 'X' }, name: 'X' }]) {
      const res = await lead.api.call('patch', `/sites/${site.id}`, body, headers);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const viaCustom = await lead.api.call('patch', `/sites/${site.id}`, { custom: { name: 'X', name_ar: 'X', latitude: 1, region_id: 5 } }, headers);
    expect(viaCustom.status).toBe(422);
    expect(viaCustom.body.errors.map((e: { code: string }) => e.code)).toEqual(['unknown_field', 'unknown_field', 'unknown_field', 'unknown_field']);
    expect(await siteRow(site.id)).toEqual(before);
  });

  it('the application role cannot call the writers of the approved path', async () => {
    for (const fn of ['si_apply_identity(uuid)', 'p4a_apply_site_change(uuid)', 'si_check_item(uuid,text,text,text)', 'p4a_site_parse(uuid,text,text)', 'si_require_admin(text)', 'sites_identity_guard()']) {
      const ok = (await db.query(`SELECT has_function_privilege('pmis_app', '${fn}', 'EXECUTE') AS ok`)).rows[0] as { ok: boolean };
      expect(ok.ok, fn).toBe(false);
    }
    expect(((await db.query(`SELECT has_function_privilege('pmis_app', 'site_propose_identity(uuid,jsonb,text)', 'EXECUTE') AS ok`)).rows[0] as { ok: boolean }).ok).toBe(true);
    const owners = await q<{ f: string; o: string; sd: boolean; cfg: string[] | null }>(db, `SELECT p.proname AS f, pg_get_userbyid(p.proowner) AS o, p.prosecdef AS sd, p.proconfig AS cfg FROM pg_proc p
      WHERE p.proname IN ('si_apply_identity', 'si_check_item', 'site_propose_identity', 'si_require_admin', 'p4a_site_parse', 'p4a_site_current', 'p4a_site_change_errors', 'p4a_apply_site_change') AND p.pronamespace = 'public'::regnamespace`);
    expect(owners.length).toBeGreaterThanOrEqual(8);
    for (const o of owners) {
      expect(o.o, o.f).toBe('pmis_definer');
      expect(o.sd, o.f).toBe(true);
      expect(o.cfg, o.f).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });
});

describe('Q473: a rejection leaves the site unchanged', () => {
  it('L2 returns a name change with a note: the site keeps its name, nothing is applied or audited as applied', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const before = await siteRow(site.id);
    const res = await propose(lead, site.id, { name: `Rejected ${tag()}`, name_ar: 'اسم مرفوض' });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    for (const it of res.body.items) {
      const rec = await record(lead, it.record_id);
      const sub = await post(lead.api, 'change_control', rec.id, 'submit', rec.version);
      expect(sub.status).toBe(200);
      await l2.api.stepUp(l2.user.password);
      const rej = await post(l2.api, 'change_control', rec.id, 'reject', sub.body.version, { note: 'The Master spelling is the right one' });
      expect(rej.status).toBe(200);
      expect(rej.body.state).toBe('entry');
      expect(await crOf(rec.entity_id)).toBeUndefined();
    }
    expect(await siteRow(site.id)).toEqual(before);
    expect(await auditOf('site_change_applied', site.id)).toHaveLength(0);
  });

  it('a rejected region move keeps the region, the cluster and the children where they were', async () => {
    const site = await makeSite(db, R, { prefix: 'SI' });
    const taskId = await makeTask(db, site, 'MS1', 'open');
    const res = await propose(adminA, site.id, { region_id: TO });
    expect(res.status).toBe(201);
    const rec = await record(adminA, res.body.items[0].record_id);
    const sub = await post(adminA.api, 'change_control', rec.id, 'submit', rec.version);
    await adminB.api.stepUp(adminB.user.password);
    expect((await post(adminB.api, 'change_control', rec.id, 'reject', sub.body.version, { note: 'Wrong region again' })).status).toBe(200);
    expect((await siteRow(site.id)).region_id).toBe(R);
    expect((await q<{ r: number }>(db, 'SELECT region_id AS r FROM task_instances WHERE id = $1', [taskId]))[0]!.r).toBe(R);
    expect(await auditOf('site_region_moved_out', site.id)).toHaveLength(0);
  });
});
