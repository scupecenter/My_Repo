import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, addAssignment, plainAdmin, taskDef } from './wf-helpers';

/**
 * My Work > Daily Plan (plan W7, migration 0149, contract 0.15.67). Region 6 (GM), synthetic sites, people and orders only.
 *   L1: the entry holder of the Daily Plan row in region 6 (a region cell names the person). L2: the approve holder there. VIEWER: region 6, no level.
 *   OUTSIDER: region 5 only. ADMIN: a System Admin with a step-up.
 * Day D is a past working day (Sunday 2025-06-15); its next working day is Monday 2025-06-16 (the weekend is Friday and Saturday).
 */
const REGION = 6;
const D = '2025-06-15';
const NEXT = '2025-06-16';
const PREFIX = `DP${randomBytes(3).toString('hex').toUpperCase()}`;
type J = Record<string, any>;

let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let l1: Actor;
let l2: Actor;
let viewer: Actor;
let outsider: Actor;
let noRight: Actor;
let wrongRegionRight: Actor;
let s1: { id: string; code: string };
let s2: { id: string; code: string };
let s3: { id: string; code: string };
let sOther: { id: string; code: string };
let partyName: string;
let seName: string;

async function site(region: number, extra: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const code = `${PREFIX}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const wf = await db.query('SELECT id FROM workflow_definitions WHERE version = 1');
  const r = await db.query(
    `INSERT INTO sites (site_code, owner_site_id, name, region_id, workflow_version_id, delivery_scenario, overall_status, tower_owner, latitude, longitude, site_type,
       scope_tower_erection, scope_te_full, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'new_build', 'in_progress', $6, $7, $8, $9, $10::"ScopeFlag", $11::"ScopeFlag", now()) RETURNING id`,
    [code, `OWN-${code}`, `Site ${code}`, region, wf.rows[0].id, extra.tower_owner ?? 'Tower Co (synthetic)', extra.lat ?? 32.1, extra.lng ?? 20.05,
      extra.type ?? 'Greenfield', 'yes', 'yes'],
  );
  return { id: r.rows[0].id as string, code };
}

async function task(s: { id: string }, code: string, planned: string | null, actual: string | null): Promise<string> {
  const td = await taskDef(db, code);
  const r = await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, planned_date, actual_date, level_opened_at, level_round, updated_at)
     VALUES ($1, $2, $3, $4::"TaskState", 1, 2, $5, $6, now(), 1, now()) RETURNING id`,
    [s.id, REGION, td.id, actual ? 'approved' : 'open', planned, actual],
  );
  return r.rows[0].id as string;
}

async function cell(level: 1 | 3, userId: string): Promise<void> {
  const c = await db.query(
    `INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('daily_plan', $1, 'any_one', $2, false, now()) RETURNING id`, [level, REGION]);
  await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, userId]);
}

const get = (a: Actor, date = D) => a.api.call('get', `/daily-plans?date=${date}&region_id=${REGION}`);
const rowOf = (body: J, siteId: string): J | undefined => (body.rows as J[]).find((r) => r.site_id === siteId);
const planOf = (body: J): J => (body.plans as J[]).find((p) => p.region_id === REGION)!;
const ver = async (a: Actor, date = D): Promise<string> => `"${planOf((await get(a, date)).body).version}"`;
const base = `/daily-plans/${D}/regions/${REGION}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  // the Site Register rights (view, edit, approve) and export: the menu, the read and the export of the Daily Plan follow view and export on daily_plan or sites
  l1 = await actor(app, db, { level: 'entry', regions: [REGION], grants: [['sites', 'view'], ['sites', 'edit'], ['sites', 'export'], ['approvals', 'view']] });
  l2 = await actor(app, db, { level: 'approve', regions: [REGION] });
  viewer = await actor(app, db, { level: 'entry', regions: [REGION] });
  outsider = await actor(app, db, { level: 'entry', regions: [5] });
  // region 6 in scope, but no view on daily_plan or sites anywhere; and view on sites only through an assignment of region 5 next to a region-6 one without it
  noRight = await actor(app, db, { level: 'entry', regions: [REGION], grants: [['approvals', 'view']] });
  wrongRegionRight = await actor(app, db, { level: 'entry', regions: [REGION], grants: [['approvals', 'view']] });
  await addAssignment(db, wrongRegionRight.user.id, { level: 'entry', regions: [5], grants: [['sites', 'view'], ['sites', 'export']] });
  await cell(1, l1.user.id);
  await cell(3, l2.user.id);

  s1 = await site(REGION);
  s2 = await site(REGION, { tower_owner: 'Second Owner (synthetic)' });
  s3 = await site(REGION);
  sOther = await site(5);
  // S1: two tasks planned on D, one of them done on D; field work of a CW order covering D
  await task(s1, 'B5', D, null);
  await task(s1, 'B6', D, D);
  partyName = `Contractor ${PREFIX} (synthetic)`;
  const party = await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'cw_contractor') RETURNING id`, [partyName]);
  const se = await db.query('SELECT display_name FROM users WHERE id = $1', [l1.user.id]);
  seName = se.rows[0].display_name as string;
  await db.query(
    `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, current_level, data, external_party_id)
     VALUES (gen_random_uuid(), 1, 'procurement', $1, $2, 'entry', true, 1, $3::jsonb, $4)`,
    [s1.id, REGION, JSON.stringify({ scope: 'CW', delivery: 'Outsourced', po_wo_no: `PO-${PREFIX}`, planned_start: '2025-06-14', planned_end: '2025-06-17',
      members: [{ user_id: l1.user.id, member_role: 'supervisor', is_lead: true }, { user_id: viewer.user.id, member_role: 'executor' }] }), party.rows[0].id],
  );
  await db.query(
    `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, current_level, data)
     VALUES (gen_random_uuid(), 1, 'permits_hse', $1, $2, 'entry', true, 1, $3::jsonb)`,
    [s1.id, REGION, JSON.stringify({ permit_stream: 'CW', status: 'Approved', valid_from: '2025-06-01', valid_to: '2025-07-15' })],
  );
  // S3: one task planned on the next working day
  await task(s3, 'B5', NEXT, null);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('pre-fill from system data', () => {
  it('fills the Daily Progress row of a site from Site Master, the Procurement assignment, the permit and the tasks of the day', async () => {
    const res = await get(l1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ date: D, next_working_day: NEXT, is_workday: true });
    expect(res.body.my_region_ids).toContain(REGION);
    const r = rowOf(res.body, s1.id)!;
    expect(r).toBeTruthy();
    expect(r.origin).toBe('auto');
    expect(r.values).toMatchObject({
      site_code: s1.code, tower_owner: 'Tower Co (synthetic)', owner_id: `OWN-${s1.code}`, latitude: '32.100000', longitude: '20.050000', region: 'GM',
      site_type: 'Greenfield', sow: 'New Build: Tower Erection, TE Full Scope', contractor: partyName, aat_se: seName, access_valid: 'Yes (to 2025-07-15)',
    });
    expect(r.values.planned_work.split('\n')).toHaveLength(3); // B5, B6 and the field work of the order
    expect(r.values.planned_work).toContain(`CW (PO-${PREFIX})`);
    expect(r.values.actual_work.split('\n')).toEqual([expect.stringMatching(/^B6 /)]);
    expect(r).toMatchObject({ planned_count: 3, actual_count: 1, below_target: true, reason_missing: true, overridden: [] });
    // a site without work that day is not in the plan
    expect(rowOf(res.body, s2.id)).toBeUndefined();
    expect(planOf(res.body)).toMatchObject({ version: 0, locked: false, can_edit: true, can_lock: false });
  });

  it('fills the Tomorrow Plan of the next working day the same way', async () => {
    const res = await get(l1, NEXT);
    expect(res.status).toBe(200);
    const r = rowOf(res.body, s3.id)!;
    expect(r.values.planned_work).toMatch(/^B5 /);
    expect(r.values.access_valid).toBe('No');
    expect(r).toMatchObject({ planned_count: 1, actual_count: 0, below_target: true }); // a past day like D: nothing done yet
    // S1's order still covers the next day: field work planned
    expect(rowOf(res.body, s1.id)!.values.planned_work).toContain('CW (');
  });
});

describe('region scope', () => {
  it('the region in scope is not enough: without view on Daily Plan or Sites for the region the read, the export and every write are refused', async () => {
    const r = await noRight.api.call('get', `/daily-plans?date=${D}&region_id=${REGION}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('action_forbidden');
    expect((await noRight.api.call('get', `/daily-plans/export?date=${D}&region_id=${REGION}`)).status).toBe(403);
    expect((await noRight.api.call('patch', `${base}/sites/${s1.id}`, { remark: 'x' }, { 'If-Match': '*' })).status).toBe(403);
    expect((await noRight.api.call('post', `${base}/lock`, undefined, { 'If-Match': '*' })).status).toBe(403);
    // a right held for another region does not open this one (scopes never cross): region 6 is left out, region 5 has no plan rows of this suite
    const w = await wrongRegionRight.api.call('get', `/daily-plans?date=${D}`);
    expect(w.status).toBe(200);
    expect((w.body.plans as J[]).map((p) => p.region_id)).toEqual([5]);
    expect((await wrongRegionRight.api.call('get', `/daily-plans?date=${D}&region_id=${REGION}`)).status).toBe(403);
    expect((await wrongRegionRight.api.call('get', `/daily-plans/export?date=${D}&region_id=${REGION}`)).status).toBe(403);
  });

  it('export needs the export right as well as view (the viewer holds view, not export)', async () => {
    expect((await get(viewer)).status).toBe(200);
    const e = await viewer.api.call('get', `/daily-plans/export?date=${D}&region_id=${REGION}`);
    expect(e.status).toBe(403);
    expect(e.body.code).toBe('action_forbidden');
  });

  it('a person of another region does not see the plan and cannot change it', async () => {
    const res = await outsider.api.call('get', `/daily-plans?date=${D}`);
    expect(res.status).toBe(200);
    expect((res.body.plans as J[]).map((p) => p.region_id)).not.toContain(REGION);
    expect(rowOf(res.body, s1.id)).toBeUndefined();
    const w = await outsider.api.call('patch', `${base}/sites/${s1.id}`, { remark: 'x' }, { 'If-Match': '*' });
    expect(w.status).toBe(404);
  });

  it('a person of the region without the L1 level reads but cannot edit', async () => {
    const res = await get(viewer);
    expect(rowOf(res.body, s1.id)).toBeTruthy();
    expect(planOf(res.body)).toMatchObject({ can_edit: false, can_lock: false, can_unlock: false });
    const w = await viewer.api.call('patch', `${base}/sites/${s1.id}`, { remark: 'x', reason: 'y' }, { 'If-Match': '0' });
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('action_forbidden');
  });
});

describe('save a row', () => {
  it('needs If-Match, refuses a stale version and requires the reason when Actual is below Planned', async () => {
    expect((await l1.api.call('patch', `${base}/sites/${s1.id}`, { remark: 'x' })).status).toBe(428);
    expect((await l1.api.call('patch', `${base}/sites/${s1.id}`, { remark: 'x' }, { 'If-Match': '"7"' })).status).toBe(412);
    const noReason = await l1.api.call('patch', `${base}/sites/${s1.id}`, { overrides: { tower_owner: 'Hand Owner (synthetic)' } }, { 'If-Match': '"0"' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors).toEqual([expect.objectContaining({ path: '/reason', code: 'required' })]);
    const bad = await l1.api.call('patch', `${base}/sites/${s1.id}`, { overrides: { site_code: 'X', latitude: 'north' }, colour: 'red' }, { 'If-Match': '"0"' });
    expect(bad.status).toBe(422);
    expect((bad.body.errors as J[]).map((e) => e.code).sort()).toEqual(['invalid', 'read_only', 'unknown_key']);
  });

  it('saves the manual value over the auto one, with the reason and the remark, and audits before and after', async () => {
    const res = await l1.api.call('patch', `${base}/sites/${s1.id}`,
      { overrides: { tower_owner: 'Hand Owner (synthetic)' }, reason: 'Crane arrived late', remark: 'Second shift tomorrow' }, { 'If-Match': '"0"' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = rowOf(res.body, s1.id)!;
    expect(r).toMatchObject({ reason: 'Crane arrived late', remark: 'Second shift tomorrow', overridden: ['tower_owner'], reason_missing: false });
    expect(r.values.tower_owner).toBe('Hand Owner (synthetic)');
    expect(r.auto.tower_owner).toBe('Tower Co (synthetic)');
    expect(planOf(res.body).version).toBe(1);
    const a = await db.query(`SELECT before, after, actor_id, site_id, region_id FROM audit_log WHERE action = 'daily_plan.row_changed' AND site_id = $1 ORDER BY id DESC LIMIT 1`, [s1.id]);
    expect(a.rows[0]).toMatchObject({ actor_id: l1.user.id, region_id: REGION, before: null });
    expect(a.rows[0].after).toMatchObject({ overrides: { tower_owner: 'Hand Owner (synthetic)' }, reason: 'Crane arrived late', plan_date: D });

    // back to the auto value (null), and a manual Actual Work that reaches the target
    const back = await l1.api.call('patch', `${base}/sites/${s1.id}`, { overrides: { tower_owner: null, actual_work: 'B5 done\nB6 done\nCW done' }, reason: null }, { 'If-Match': '"1"' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const b = rowOf(back.body, s1.id)!;
    expect(b.values.tower_owner).toBe('Tower Co (synthetic)');
    expect(b).toMatchObject({ overridden: ['actual_work'], actual_count: 3, below_target: false, reason: null });
    const a2 = await db.query(`SELECT before FROM audit_log WHERE action = 'daily_plan.row_changed' AND site_id = $1 ORDER BY id DESC LIMIT 1`, [s1.id]);
    expect(a2.rows[0].before.overrides).toEqual({ tower_owner: 'Hand Owner (synthetic)' });
  });
});

describe('add and remove sites', () => {
  it('adds a site of the region by hand, refuses a duplicate or a site of another region, and removes it', async () => {
    let v = await ver(l1);
    const add = await l1.api.call('post', `${base}/sites`, { site_code: s2.code.toLowerCase() }, { 'If-Match': v });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(rowOf(add.body, s2.id)).toMatchObject({ origin: 'added', planned_count: 0 });
    v = `"${planOf(add.body).version}"`;
    expect((await l1.api.call('post', `${base}/sites`, { site_code: s2.code }, { 'If-Match': v })).status).toBe(409);
    const other = await l1.api.call('post', `${base}/sites`, { site_code: sOther.code }, { 'If-Match': v });
    expect(other.status).toBe(422);
    expect(other.body.errors[0]).toMatchObject({ path: '/site_code', code: 'not_in_region' });
    const rm = await l1.api.call('delete', `${base}/sites/${s2.id}`, undefined, { 'If-Match': v });
    expect(rm.status).toBe(200);
    expect(rowOf(rm.body, s2.id)).toBeUndefined();
    const actions = await db.query(`SELECT action FROM audit_log WHERE site_id = $1 AND entity_type = 'daily_plan' ORDER BY id`, [s2.id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['daily_plan.site_added', 'daily_plan.site_removed']);
  });

  it('removes an auto-filled site and brings it back', async () => {
    const t = `/daily-plans/${NEXT}/regions/${REGION}`;
    let v = await ver(l1, NEXT);
    const rm = await l1.api.call('delete', `${t}/sites/${s3.id}`, undefined, { 'If-Match': v });
    expect(rm.status).toBe(200);
    expect(rowOf(rm.body, s3.id)).toBeUndefined();
    v = `"${planOf(rm.body).version}"`;
    const back = await l1.api.call('post', `${t}/sites`, { site_code: s3.code }, { 'If-Match': v });
    expect(back.status).toBe(200);
    expect(rowOf(back.body, s3.id)).toMatchObject({ origin: 'auto' });
  });
});

describe('lock by L2', () => {
  it('L1 cannot lock; L2 cannot lock while a row below target has no reason; then locks and the day is frozen', async () => {
    let v = await ver(l1);
    expect((await l1.api.call('post', `${base}/lock`, undefined, { 'If-Match': v })).body.code).toBe('action_forbidden');
    // a second site below target without a reason
    const s4 = await site(REGION);
    await task(s4, 'B5', D, null);
    const refused = await l2.api.call('post', `${base}/lock`, undefined, { 'If-Match': v });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: `/rows/${s4.code}/reason`, code: 'required' })]);
    const fix = await l1.api.call('patch', `${base}/sites/${s4.id}`, { reason: 'Access refused by the landlord' }, { 'If-Match': v });
    expect(fix.status).toBe(200);
    v = `"${planOf(fix.body).version}"`;
    const lock = await l2.api.call('post', `${base}/lock`, undefined, { 'If-Match': v });
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    expect(planOf(lock.body)).toMatchObject({ locked: true, lock_kind: 'manual', locked_by: { id: l2.user.id }, can_edit: false });
    expect(rowOf(lock.body, s1.id)!.frozen).toBe(true);
    v = `"${planOf(lock.body).version}"`;

    // a locked day is read-only and keeps its frozen values when the data changes later
    const w = await l1.api.call('patch', `${base}/sites/${s1.id}`, { remark: 'late' }, { 'If-Match': v });
    expect(w.status).toBe(409);
    expect(w.body.code).toBe('plan_locked');
    await task(s1, 'B7', D, null);
    expect(rowOf((await get(l1)).body, s1.id)!.planned_count).toBe(3);

    // the unlock is an admin override: not for L2, a reason and a step-up for the System Admin
    expect((await l2.api.call('post', `${base}/unlock`, { reason: 'Reopen it' }, { 'If-Match': v })).status).toBe(403);
    expect((await admin.api.call('post', `${base}/unlock`, {}, { 'If-Match': v })).status).toBe(422);
    const un = await admin.api.call('post', `${base}/unlock`, { reason: 'A row was wrong' }, { 'If-Match': v });
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    expect(planOf(un.body)).toMatchObject({ locked: false, unlocked_by: { id: admin.user.id } });
    expect(rowOf(un.body, s1.id)!.planned_count).toBe(4); // live again: B7 counts now
    const a = await db.query(`SELECT is_admin_override, reason FROM audit_log WHERE action = 'daily_plan.unlocked' AND region_id = $1 ORDER BY id DESC LIMIT 1`, [REGION]);
    expect(a.rows[0]).toEqual({ is_admin_override: true, reason: 'A row was wrong' });
  });
});

describe('export', () => {
  it('downloads both tables in the column order of the owner sheet', async () => {
    const res = await l1.api.call('get', `/daily-plans/export?date=${D}&region_id=${REGION}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ExcelJS.Buffer);
    const ws = wb.worksheets[0]!;
    const values = (n: number) => (ws.getRow(n).values as unknown[]).slice(1).map((x) => (x == null ? '' : String(x)));
    expect(values(1)[0]).toBe(`Daily Progress ${D}`);
    expect(values(2)).toEqual(['No', 'Site ID', 'Tower Owner', 'Owner ID', 'Latitude', 'Longitude', 'Region', 'Site Type', 'SOW', 'Vendor / Contractor Name', 'AAT SE',
      'Planned Work', 'Actual Work', 'Reason (if not reach target)']);
    let r = 3;
    const codes: string[] = [];
    while (values(r).length && values(r)[0] !== '') { codes.push(values(r)[1]!); r++; }
    expect(codes).toContain(s1.code);
    const t = r + 1;
    expect(values(t)[0]).toBe(`Tomorrow Plan ${NEXT}`);
    expect(values(t + 1)).toEqual(['No', 'Site ID', 'Tower Owner', 'Owner ID', 'Latitude', 'Longitude', 'Region', 'Site Type', 'SOW', 'Vendor / Contractor Name', 'AAT SE',
      'Access Valid', 'Planned Work', 'Remark']);
    const a = await db.query(`SELECT after FROM audit_log WHERE action = 'daily_plan.exported' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [l1.user.id]);
    expect(a.rows[0].after).toMatchObject({ date: D, next_working_day: NEXT });
  });
});

describe('settings and the job', () => {
  it('Settings > My Work > Daily Plan: defaults, closed body, rights, If-Match and audit', async () => {
    const g = await l1.api.call('get', '/settings/daily-plan');
    expect(g.status).toBe(200);
    expect(g.body.columns.progress).toEqual(['no', 'site_code', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se',
      'planned_work', 'actual_work', 'reason']);
    expect(g.body.columns.tomorrow.slice(-3)).toEqual(['access_valid', 'planned_work', 'remark']);
    const tag = String(g.headers.etag);
    const body = { columns: { progress: ['site_code', 'planned_work', 'actual_work', 'reason', 'remark'], tomorrow: g.body.columns.tomorrow }, default_region_scope: 'all',
      auto_lock_time: null, reminder_hour: null, reason: 'Shorter progress table' };
    expect((await l1.api.call('put', '/settings/daily-plan', body, { 'If-Match': tag })).status).toBe(403);
    const bad = await admin.api.call('put', '/settings/daily-plan', { ...body, colour: 1, columns: { progress: ['planned_work', 'planned_work'], tomorrow: ['x'] },
      auto_lock_time: '25:00', reminder_hour: 30 }, { 'If-Match': tag });
    expect(bad.status).toBe(422);
    expect((bad.body.errors as J[]).map((e) => e.code).sort()).toEqual(['duplicate', 'invalid', 'out_of_range', 'site_code_required', 'site_code_required', 'unknown_column', 'unknown_key']);
    const ok = await admin.api.call('put', '/settings/daily-plan', body, { 'If-Match': tag });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ default_region_scope: 'all', columns: { progress: body.columns.progress } });
    expect((await admin.api.call('put', '/settings/daily-plan', body, { 'If-Match': tag })).status).toBe(412);
    const a = await db.query(`SELECT before, after, reason FROM audit_log WHERE action = 'daily_plan_settings_update' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0].reason).toBe('Shorter progress table');
    expect(a.rows[0].after.default_region_scope).toBe('all');
    // the setting changes only through its door
    await expect(viewer.api.call('get', '/settings/daily-plan').then((r) => r.status)).resolves.toBe(200);
  });

  it('the job locks today after the set time and reminds the L1 holders of an empty next working day (rolled back)', async () => {
    await db.query('BEGIN');
    try {
      await db.query(`UPDATE settings SET value = value || '{"auto_lock_time": "00:00", "reminder_hour": 0}'::jsonb WHERE key = 'daily_plan.settings'`);
      const today = (await db.query('SELECT cal_today()::text AS d, cal_is_workday(cal_today()) AS w, cal_add_workdays(cal_today(), 1)::text AS n')).rows[0];
      const n = (await db.query('SELECT dp_tick() AS n')).rows[0].n as number;
      expect(n).toBeGreaterThan(0);
      if (today.w) {
        const p = await db.query('SELECT lock_kind FROM daily_plans WHERE region_id = $1 AND plan_date = $2', [REGION, today.d]);
        expect(p.rows[0].lock_kind).toBe('auto');
        const rem = await db.query(`SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND kind = 'daily_plan_reminder'`, [l1.user.id]);
        // the reminder goes only when the next working day of the region is empty
        const empty = (await db.query('SELECT jsonb_array_length(dp_rows($1, $2::date)) = 0 AS e', [REGION, today.n])).rows[0].e as boolean;
        expect(rem.rows[0].c).toBe(empty ? 1 : 0);
        // a second run sends nothing more and locks nothing more
        expect((await db.query('SELECT dp_tick() AS n')).rows[0].n).toBe(0);
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

/** Migration 0566 (hardening layer 1b): locks of a plan, a row and a column of the rows, on the model of the register locks. */
describe('Daily Plan entity locks (0566)', () => {
  const DL = '2025-06-22'; // a Sunday, its own plan so no other test depends on it
  it('a locked plan refuses the entry holder and not a System Admin; unlock restores it; every change is audited', async () => {
    const dayBase = `/daily-plans/${DL}/regions/${REGION}`;
    const first = await l1.api.call('post', `${dayBase}/sites`, { site_code: s2.code }, { 'If-Match': '"0"' });
    expect(first.status).toBe(200);
    const head = planOf((await get(l1, DL)).body);
    expect(head.plan_id).toBeTruthy();
    const lock = await admin.api.call('post', `/entity-locks/daily_plan/${head.plan_id}`, { reason: 'Frozen for review' });
    expect(lock.status).toBe(200);
    const locked = planOf((await get(l1, DL)).body);
    expect(locked.entity_locked).toBe(true);
    expect(locked.can_edit).toBe(false);
    const refused = await l1.api.call('patch', `${dayBase}/sites/${s2.id}`, { remark: 'second' }, { 'If-Match': `"${locked.version}"` });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toMatch(/register_locked/);
    const exempt = await admin.api.call('patch', `${dayBase}/sites/${s2.id}`, { remark: 'admin edit' }, { 'If-Match': `"${locked.version}"` });
    expect(exempt.status).toBe(200);
    expect((await admin.api.call('delete', `/entity-locks/daily_plan/${head.plan_id}`, { reason: 'Review done' })).status).toBe(200);
    const after = planOf((await get(l1, DL)).body);
    expect((await l1.api.call('patch', `${dayBase}/sites/${s2.id}`, { remark: 'third' }, { 'If-Match': `"${after.version}"` })).status).toBe(200);
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('entity_lock','entity_unlock') ORDER BY id`, [head.plan_id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['entity_lock', 'entity_unlock']);
  });

  it('a locked column refuses a body that names it; a row lock refuses edits of that row', async () => {
    const dayBase = `/daily-plans/${DL}/regions/${REGION}`;
    const head0 = planOf((await get(l1, DL)).body);
    const rowId = rowOf((await get(l1, DL)).body, s2.id)?.row_id as string;
    expect(rowId).toBeTruthy();
    try {
      expect((await admin.api.call('post', '/entity-locks/columns/daily_plan_row/remark', { reason: 'Remarks closed' })).status).toBe(200);
      const v = planOf((await get(l1, DL)).body).version;
      const r = await l1.api.call('patch', `${dayBase}/sites/${s2.id}`, { remark: 'blocked' }, { 'If-Match': `"${v}"` });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/register_locked/);
    } finally {
      await admin.api.call('delete', '/entity-locks/columns/daily_plan_row/remark', { reason: 'Remarks open again' });
    }
    expect((await admin.api.call('post', `/entity-locks/daily_plan_row/${rowId}`, { reason: 'Row frozen' })).status).toBe(200);
    try {
      const v = planOf((await get(l1, DL)).body).version;
      expect((await l1.api.call('patch', `${dayBase}/sites/${s2.id}`, { remark: 'row blocked' }, { 'If-Match': `"${v}"` })).status).toBe(403);
      expect((await l1.api.call('delete', `${dayBase}/sites/${s2.id}`, undefined, { 'If-Match': `"${v}"` })).status).toBe(403);
    } finally {
      await admin.api.call('delete', `/entity-locks/daily_plan_row/${rowId}`, { reason: 'Row open again' });
    }
    expect(head0.plan_id).toBeTruthy();
  });
});
