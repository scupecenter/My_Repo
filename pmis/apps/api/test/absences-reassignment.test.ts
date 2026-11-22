import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeUser, startApp, superDb } from './helpers';
import { Actor, actor, addAssignment, etag, makeSite, newRole, plainAdmin, setCell, taskDef, type Site } from './wf-helpers';

/**
 * Staff absence and the lead decisions (CLAUDE.md B12b, B14; migration 0137, contract 0.15.45). Region 3 (WM), synthetic people and sites only.
 *   LEAD: the reassign grant (overrides.reassign + administer) and the Sites module in region 3. LEAD4: the same in region 4 only (wrong region).
 *   E: a data-entry engineer of region 3 (the absent person). H: a second engineer of the same role (an eligible receiver). OTHER: same region, no lead.
 * The tasks are written straight into the database (state, pin, opening time); every decision goes through the API.
 */
const REGION = 3;
const PREFIX = `ABS${randomBytes(3).toString('hex').toUpperCase()}`;
const LEAD_GRANTS: [string, string][] = [
  ['sites', 'view'], ['sites', 'edit'], ['sites', 'approve'], ['approvals', 'view'], ['approvals', 'approve'], ['overrides.reassign', 'administer'],
];
type J = Record<string, any>;

let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let lead: Actor;
let lead4: Actor;
let e: Actor;
let h: Actor;
let other: Actor;
let approver: Actor;
let roleEng: string;
let today: string;

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  today = (await db.query('SELECT cal_today()::text AS d')).rows[0].d as string;
  lead = await actor(app, db, { level: 'approve', regions: [REGION], grants: LEAD_GRANTS });
  lead4 = await actor(app, db, { level: 'approve', regions: [4], grants: LEAD_GRANTS });
  roleEng = await newRole(db);
  e = await actor(app, db, { level: 'entry', regions: [REGION] });
  h = await actor(app, db, { level: 'entry', regions: [REGION] });
  other = await actor(app, db, { level: 'entry', regions: [REGION] });
  approver = await actor(app, db, { level: 'approve', regions: [REGION] });
  await addAssignment(db, e.user.id, { roleId: roleEng, level: 'entry', regions: [REGION] });
  await addAssignment(db, h.user.id, { roleId: roleEng, level: 'entry', regions: [REGION] });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const site = (): Promise<Site> => makeSite(db, REGION, { prefix: PREFIX });

/** A two-level task (L1 entry, L2 approve) on its own new site (or on `s` when `shared`), its current level opened `openedAgo` days ago, optionally pinned. */
async function task(s0: Site, code: string, state: 'entry' | 'in_approval', o: { pinned?: string; openedAgo?: number; actual?: boolean; shared?: boolean } = {}): Promise<string> {
  const s = o.shared ? s0 : await site();
  const td = await taskDef(db, code);
  const ago = o.openedAgo ?? 0;
  const r = await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, ball_in_court_user_id, actual_date, sla_start_date,
       level_opened_at, level_round, path_frozen_at, updated_at)
     VALUES ($1, $2, $3, $4::"TaskState", $5, 2, $6, CASE WHEN $7 THEN cal_today() - 1 END, cal_today() - 6, now() - make_interval(days => $8), 1,
       CASE WHEN $4 = 'in_approval' THEN now() END, now() - make_interval(days => $8)) RETURNING id`,
    [s.id, s.region, td.id, state, state === 'entry' ? 1 : 2, o.pinned ?? null, o.actual ?? false, ago],
  );
  return r.rows[0].id as string;
}

const snapshot = async (id: string): Promise<J> => (await db.query(
  `SELECT state::text, current_level, levels_required, sla_start_date::text, sla_rule_id, due_date::text, actual_date::text, level_opened_at, path_frozen_at,
     values, return_count FROM task_instances WHERE id = $1`, [id])).rows[0];

async function absence(by: Actor, body: J): Promise<J> {
  const res = await by.api.call('post', '/absences', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as J;
}

describe('absence records (informational, B12b)', () => {
  it('an employee records only their own annual leave; the lead records sick leave of the people they lead', async () => {
    const own = await absence(other, { kind: 'annual', from_date: addDays(today, 30), to_date: addDays(today, 34), note: 'Family trip' });
    expect(own).toMatchObject({ kind: 'annual', self_recorded: true, user: { id: other.user.id }, recorded_by: { id: other.user.id }, version: 1 });
    expect(typeof own.open_task_count).toBe('number');

    const sick = await other.api.call('post', '/absences', { kind: 'sick', from_date: addDays(today, 40), to_date: addDays(today, 41) });
    expect(sick.status).toBe(403);
    expect(sick.body.code).toBe('action_forbidden');
    const forOther = await other.api.call('post', '/absences', { user_id: h.user.id, kind: 'annual', from_date: addDays(today, 40), to_date: addDays(today, 41) });
    expect(forOther.status).toBe(403);

    const byLead = await absence(lead, { user_id: other.user.id, kind: 'sick', from_date: addDays(today, 50), to_date: addDays(today, 51) });
    expect(byLead).toMatchObject({ self_recorded: false, recorded_by: { id: lead.user.id } });
    // the lead of another region does not lead this person
    const wrong = await lead4.api.call('post', '/absences', { user_id: other.user.id, kind: 'sick', from_date: addDays(today, 60), to_date: addDays(today, 61) });
    expect(wrong.status).toBe(403);

    // the person sees both, the lead sees both, the lead of another region and a colleague see none
    const mine = await other.api.call('get', '/absences', undefined).query({ user_id: other.user.id });
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: J) => x.id).sort()).toEqual([own.id, byLead.id].sort());
    const asLead = await lead.api.call('get', '/absences').query({ user_id: other.user.id });
    expect(asLead.body.items).toHaveLength(2);
    expect((await lead4.api.call('get', '/absences').query({ user_id: other.user.id })).body.items).toHaveLength(0);
    expect((await h.api.call('get', '/absences').query({ user_id: other.user.id })).body.items).toHaveLength(0);
    expect((await h.api.call('get', `/absences/${own.id}`)).status).toBe(404);

    // the lead was told when the employee recorded their leave
    const n = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'absence_alert' AND body LIKE $2`, [lead.user.id, `%${own.from_date}%`]);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('refuses overlapping or reversed dates and checks If-Match; removal is audited with the values', async () => {
    const a = await absence(lead, { user_id: h.user.id, kind: 'emergency', from_date: addDays(today, 70), to_date: addDays(today, 72) });
    const clash = await lead.api.call('post', '/absences', { user_id: h.user.id, kind: 'sick', from_date: addDays(today, 72), to_date: addDays(today, 73) });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('duplicate');
    const reversed = await lead.api.call('post', '/absences', { user_id: h.user.id, kind: 'sick', from_date: addDays(today, 80), to_date: addDays(today, 79) });
    expect(reversed.status).toBe(422);

    const patched = await lead.api.call('patch', `/absences/${a.id}`, { note: 'Called in' }, { 'If-Match': '"1"' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ note: 'Called in', version: 2 });
    expect(patched.headers.etag).toBe('"2"');

    // the person cannot remove what the lead recorded
    expect((await h.api.call('delete', `/absences/${a.id}`, undefined, { 'If-Match': '"2"' })).body.code).toBe('action_forbidden');
    expect((await lead.api.call('delete', `/absences/${a.id}`)).status).toBe(428);
    expect((await lead.api.call('delete', `/absences/${a.id}`, undefined, { 'If-Match': '"1"' })).status).toBe(412);
    expect((await lead.api.call('delete', `/absences/${a.id}`, undefined, { 'If-Match': '"2"' })).status).toBe(204);

    const audit = await db.query(`SELECT action, before, after, actor_id FROM audit_log WHERE entity_type = 'absence' AND entity_id = $1 ORDER BY id`, [a.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['absence.recorded', 'absence.changed', 'absence.removed']);
    expect(audit.rows[1].before.note).toBeNull();
    expect(audit.rows[1].after.note).toBe('Called in');
    expect(audit.rows[2].before).toMatchObject({ kind: 'emergency', user_id: h.user.id });
    expect(audit.rows[2].after).toBeNull();
    expect(audit.rows.every((r) => r.actor_id === lead.user.id)).toBe(true);
  });

  it('the employee removes their own annual leave', async () => {
    const a = await absence(e, { kind: 'annual', from_date: addDays(today, 90), to_date: addDays(today, 91) });
    expect((await e.api.call('delete', `/absences/${a.id}`, undefined, { 'If-Match': etag({ headers: { etag: `"${a.version}"` } }) })).status).toBe(204);
  });
});

describe('alerts, the absent badge and the eligible people', () => {
  let s: Site;
  let pinnedToE: string;
  let idleTask: string;
  let deactivatedTask: string;
  let deactivated: string;

  beforeAll(async () => {
    s = await site();
    // D2: L1 held by the engineers' role (E and H), L2 by the lead's own user
    await setCell(db, 'D2', REGION, 'entry', { role: [roleEng] });
    await setCell(db, 'D2', REGION, 'approve', { user: [lead.user.id] });
    pinnedToE = await task(s, 'D2', 'entry', { pinned: e.user.id });
    // D4b: L1 held by OTHER alone (the only eligible holder), idle for ten days
    await setCell(db, 'D4b', REGION, 'entry', { user: [other.user.id] });
    idleTask = await task(s, 'D4b', 'entry', { openedAgo: 10 });
    // D5: L1 pinned to a disabled account (B14)
    const g = await makeUser(db, { status: 'disabled' });
    deactivated = g.id;
    await addAssignment(db, g.id, { roleId: roleEng, level: 'entry', regions: [REGION] });
    await setCell(db, 'D5', REGION, 'entry', { role: [roleEng] });
    deactivatedTask = await task(s, 'D5', 'entry', { pinned: g.id });
    await absence(lead, { user_id: e.user.id, kind: 'sick', from_date: today, to_date: addDays(today, 3), note: 'Flu' });
  });

  it('shows the absent badge on the task and lists it for the lead of the region only', async () => {
    const t = await lead.api.call('get', `/tasks/${pinnedToE}`);
    expect(t.status).toBe(200);
    expect(t.body.holder_absent).toBe(true);
    expect((await lead.api.call('get', `/tasks/${idleTask}`)).body.holder_absent).toBe(false);

    const res = await lead.api.call('get', '/reassignments/alerts').query({ cause: 'absent' });
    expect(res.status).toBe(200);
    const mine = (res.body.items as J[]).find((a) => a.task.id === pinnedToE);
    expect(mine).toMatchObject({ cause: 'absent', holder: { id: e.user.id }, holder_account_status: 'active', absence: { kind: 'sick', user: { id: e.user.id } } });
    expect(mine!.absence.open_task_count).toBeGreaterThanOrEqual(1);
    expect(mine!.task.holder_absent).toBe(true);

    expect((await other.api.call('get', '/reassignments/alerts')).status).toBe(403);
    const r4 = await lead4.api.call('get', '/reassignments/alerts').query({ cause: 'absent' });
    expect(r4.status).toBe(200);
    expect((r4.body.items as J[]).some((a) => a.task.id === pinnedToE)).toBe(false);
    expect((await lead.api.call('get', '/reassignments/alerts').query({ cause: 'bogus' })).status).toBe(422);
  });

  it('lists an idle task (default 2 working days) and a task on a deactivated account', async () => {
    const idle = await lead.api.call('get', '/reassignments/alerts').query({ cause: 'idle', region_id: String(REGION) });
    const it1 = (idle.body.items as J[]).find((a) => a.task.id === idleTask);
    expect(it1).toMatchObject({ cause: 'idle', holder: { id: other.user.id }, absence: null });
    expect(it1!.idle_working_days).toBeGreaterThanOrEqual(2);
    expect((idle.body.items as J[]).some((a) => a.task.id === pinnedToE)).toBe(false);

    const dz = await lead.api.call('get', '/reassignments/alerts').query({ cause: 'holder_deactivated', user_id: deactivated });
    expect(dz.body.items.map((a: J) => a.task.id)).toEqual([deactivatedTask]);
    expect(dz.body.items[0]).toMatchObject({ holder_account_status: 'deactivated', holder: { id: deactivated } });
  });

  it('offers only eligible, present people other than the holder', async () => {
    const res = await lead.api.call('get', '/reassignments/eligible-users').query({ task_id: pinnedToE });
    expect(res.status).toBe(200);
    const ids = (res.body.items as J[]).map((x) => x.id);
    expect(ids).toContain(h.user.id);
    expect(ids).not.toContain(e.user.id); // the holder, absent today
    expect(ids).not.toContain(deactivated); // not active
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['display_name', 'employee_id', 'id']);
    const byPerson = await lead.api.call('get', '/reassignments/eligible-users').query({ from_user_id: e.user.id });
    expect((byPerson.body.items as J[]).map((x) => x.id)).toContain(h.user.id);
    expect((await lead.api.call('get', '/reassignments/eligible-users')).status).toBe(422);
    expect((await other.api.call('get', '/reassignments/eligible-users').query({ task_id: pinnedToE })).status).toBe(403);
    expect((await lead4.api.call('get', '/reassignments/eligible-users').query({ task_id: pinnedToE })).status).toBe(404);
  });
});

describe('POST /tasks/reassign', () => {
  let s: Site;
  beforeAll(async () => {
    s = await site();
    await setCell(db, 'D3', REGION, 'entry', { role: [roleEng] });
    await setCell(db, 'D3', REGION, 'approve', { user: [admin.user.id] });
  });

  it('refuses without the grant, in another region, without a reason, and to a person who cannot hold the level', async () => {
    const t = await task(s, 'D3', 'entry', { pinned: e.user.id });
    const body = { scope: 'task', task_id: t, decision: 'reassign', to_user_id: h.user.id, reason: 'Sick leave this week' };
    expect((await other.api.call('post', '/tasks/reassign', body)).body.code).toBe('action_forbidden');
    expect((await lead4.api.call('post', '/tasks/reassign', body)).status).toBe(404);
    const noReason = await lead.api.call('post', '/tasks/reassign', { ...body, reason: undefined });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('validation_failed');
    expect((await lead.api.call('post', '/tasks/reassign', { ...body, reason: 'ok' })).status).toBe(422);
    const notHolder = await lead.api.call('post', '/tasks/reassign', { ...body, to_user_id: other.user.id });
    expect(notHolder.status).toBe(422);
    expect(notHolder.body.code).toBe('not_eligible_holder');
    expect((await db.query('SELECT ball_in_court_user_id FROM task_instances WHERE id = $1', [t])).rows[0].ball_in_court_user_id).toBe(e.user.id);
  });

  it('moves the task to an eligible person and keeps the SLA, the level, the data and the Matrix; audited, with a step and a notice', async () => {
    const t = await task(s, 'D3', 'entry', { pinned: e.user.id, openedAgo: 1 });
    const before = await snapshot(t);
    const cells = (await db.query('SELECT count(*)::int AS n FROM matrix_cell_assignees a JOIN matrix_cells c ON c.id = a.cell_id WHERE c.region_id = $1', [REGION])).rows[0].n;
    const v0 = (await db.query('SELECT version FROM task_instances WHERE id = $1', [t])).rows[0].version;

    const dry = await lead.api.call('post', '/tasks/reassign', { scope: 'task', task_id: t, decision: 'reassign', to_user_id: h.user.id, reason: 'Preview only', dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, done: [{ id: t }] });
    expect((await db.query('SELECT version FROM task_instances WHERE id = $1', [t])).rows[0].version).toBe(v0);

    const res = await lead.api.call('post', '/tasks/reassign', { scope: 'task', task_id: t, decision: 'reassign', to_user_id: h.user.id, reason: 'E is on sick leave' },
      { 'Idempotency-Key': `reassign-${t}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dry_run: false, done: [{ id: t }], skipped: [], failed: [] });
    expect(typeof res.body.bulk_action_id).toBe('string');

    expect(await snapshot(t)).toEqual(before);
    const row = (await db.query('SELECT ball_in_court_user_id, version FROM task_instances WHERE id = $1', [t])).rows[0];
    expect(row.ball_in_court_user_id).toBe(h.user.id);
    expect(row.version).toBe(v0 + 1);
    expect((await db.query('SELECT count(*)::int AS n FROM matrix_cell_assignees a JOIN matrix_cells c ON c.id = a.cell_id WHERE c.region_id = $1', [REGION])).rows[0].n).toBe(cells);

    const step = await db.query(`SELECT acted_by, note, level FROM workflow_steps WHERE task_id = $1 AND action = 'reassign'`, [t]);
    expect(step.rows).toEqual([{ acted_by: lead.user.id, note: 'E is on sick leave', level: 1 }]);
    const audit = await db.query(`SELECT before, after, reason, actor_id FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action = 'task_reassign'`, [t]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ reason: 'E is on sick leave', actor_id: lead.user.id });
    expect(audit.rows[0].before).toMatchObject({ pinned_to: e.user.id, holder: e.user.id });
    expect(audit.rows[0].after).toMatchObject({ pinned_to: h.user.id, holder: h.user.id, bulk_action_id: res.body.bulk_action_id, matrix_changed: false });
    const notice = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'reassigned' AND task_id = $2`, [h.user.id, t]);
    expect(notice.rows[0].n).toBe(1);

    // the replay with the same key answers the first result and writes nothing
    const again = await lead.api.call('post', '/tasks/reassign', { scope: 'task', task_id: t, decision: 'reassign', to_user_id: h.user.id, reason: 'E is on sick leave' },
      { 'Idempotency-Key': `reassign-${t}` });
    expect(again.body.bulk_action_id).toBe(res.body.bulk_action_id);
    // the new holder is not absent: no absent alert for the task, and the badge is gone
    expect((await lead.api.call('get', `/tasks/${t}`)).body.holder_absent).toBe(false);
    const view = await h.api.call('get', `/tasks/${t}`);
    expect(view.body.ball_in_court.claimed_by.id).toBe(h.user.id);
  });

  it('decides for all of a person\'s open tasks on one site; keep silences the alert and records the decision', async () => {
    const s2 = await site();
    const t1 = await task(s2, 'D3', 'entry', { pinned: e.user.id, shared: true });
    const t2 = await task(s2, 'D2', 'entry', { pinned: h.user.id, shared: true });
    const res = await lead.api.call('post', '/tasks/reassign', { scope: 'site', site_id: s2.id, from_user_id: e.user.id, decision: 'keep', reason: 'Back on Thursday' });
    expect(res.status).toBe(200);
    expect(res.body.done).toEqual([{ id: t1 }]);
    const alerts = await lead.api.call('get', '/reassignments/alerts').query({ cause: 'absent' });
    expect((alerts.body.items as J[]).some((a) => a.task.id === t1)).toBe(false);
    expect((await db.query('SELECT ball_in_court_user_id FROM task_instances WHERE id = $1', [t1])).rows[0].ball_in_court_user_id).toBe(e.user.id);
    expect((await db.query('SELECT ball_in_court_user_id FROM task_instances WHERE id = $1', [t2])).rows[0].ball_in_court_user_id).toBe(h.user.id);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'task_cover_keep'`, [t1]);
    expect(audit.rows[0].n).toBe(1);
  });
});

describe('POST /tasks/{id}/act-on-behalf', () => {
  let s: Site;
  beforeAll(async () => {
    s = await site();
    // D6: L1 = the engineers' role, L2 = the lead (so a lead submitting on behalf holds the next level: B5)
    await setCell(db, 'D6', REGION, 'entry', { role: [roleEng] });
    await setCell(db, 'D6', REGION, 'approve', { user: [lead.user.id] });
    // D7: L2 = a regional approver (the lead does not hold it)
    await setCell(db, 'D7', REGION, 'entry', { role: [roleEng] });
    await setCell(db, 'D7', REGION, 'approve', { user: [approver.user.id] });
  });

  it('validates the call: reason, note for a reject, the current level, If-Match, the grant and the region', async () => {
    const t = await task(s, 'D7', 'entry', { pinned: e.user.id, actual: true });
    const v = { 'If-Match': '"1"' };
    const call = (a: Actor, body: J, headers: Record<string, string> = v) => a.api.call('post', `/tasks/${t}/act-on-behalf`, body, headers);
    expect((await call(lead, { action: 'submit', level: 1 })).body.code).toBe('validation_failed');
    expect((await call(lead, { action: 'reject', level: 1, reason: 'because' })).body.code).toBe('note_required');
    expect((await call(lead, { action: 'submit', level: 2, reason: 'because' })).body.code).toBe('invalid_transition');
    expect((await call(lead, { action: 'submit', level: 1, reason: 'because' }, {})).status).toBe(428);
    expect((await call(lead, { action: 'submit', level: 1, reason: 'because' }, { 'If-Match': '"7"' })).status).toBe(412);
    expect((await call(other, { action: 'submit', level: 1, reason: 'because' })).body.code).toBe('action_forbidden');
    expect((await call(lead4, { action: 'submit', level: 1, reason: 'because' })).status).toBe(404);
    expect((await db.query('SELECT state::text FROM task_instances WHERE id = $1', [t])).rows[0].state).toBe('entry');
  });

  it('submits for the assignee: logged "lead on behalf of the assignee", SLA and data kept', async () => {
    const t = await task(s, 'D7', 'entry', { pinned: e.user.id, actual: true });
    const before = await snapshot(t);
    const res = await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'submit', level: 1, reason: 'E is on sick leave' }, { 'If-Match': '"1"' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.task.state).toBe('in_approval');
    expect(res.headers.etag).toBe(`"${res.body.task.version}"`);
    const after = await snapshot(t);
    expect(after.sla_start_date).toBe(before.sla_start_date);
    expect(after.sla_rule_id).toBe(before.sla_rule_id);
    expect(after.actual_date).toBe(before.actual_date);

    const hist = await lead.api.call('get', `/tasks/${t}/history`);
    const submit = (hist.body.items as J[]).find((x) => x.action === 'submit');
    expect(submit).toMatchObject({ acted_by: { id: lead.user.id }, on_behalf_of: { id: e.user.id }, on_behalf_kind: 'assignee', self_approval: false });
    const audit = await db.query(`SELECT action, actor_id, on_behalf_of, after, reason FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action IN ('task_submit', 'task_act_on_behalf') ORDER BY id`, [t]);
    expect(audit.rows.map((r) => r.action)).toEqual(['task_submit', 'task_act_on_behalf']);
    expect(audit.rows.every((r) => r.actor_id === lead.user.id && r.on_behalf_of === e.user.id && r.after.on_behalf_kind === 'assignee')).toBe(true);
    expect(audit.rows[1].reason).toBe('E is on sick leave');
    // informational: the holder's state when the lead acted (B12b sets no precondition)
    expect(audit.rows[1].after).toMatchObject({ holder: e.user.id, holder_absent: true, holder_deactivated: false, idle_limit: 2 });
    expect(typeof audit.rows[1].after.idle_working_days).toBe('number');

    // the audit reader shows the kind
    const log = await admin.api.call('get', '/audit-log').query({ entity_type: 'task', entity_id: t });
    expect(log.status).toBe(200);
    const row = (log.body.items as J[]).find((x) => x.action === 'task_act_on_behalf');
    expect(row).toMatchObject({ on_behalf_kind: 'assignee', on_behalf_of: { id: e.user.id }, actor: { id: lead.user.id } });
    // the marker of the transaction is gone
    expect((await db.query(`SELECT count(*)::int AS n FROM hgd_marks WHERE kind = 'rsn_cover'`)).rows[0].n).toBe(0);
  });

  it('a lead who also holds L2 makes a self-approval (B5): step-up needed, then approved and flagged', async () => {
    const t = await task(s, 'D6', 'entry', { pinned: e.user.id, actual: true });
    const noStep = await actor(app, db, { level: 'approve', regions: [REGION], grants: LEAD_GRANTS, stepUp: false });
    await setCell(db, 'D6', REGION, 'approve', { user: [lead.user.id, noStep.user.id] });
    const refused = await noStep.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'submit', level: 1, reason: 'Covering for E' }, { 'If-Match': '"1"' });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('step_up_required');
    expect((await db.query('SELECT state::text FROM task_instances WHERE id = $1', [t])).rows[0].state).toBe('entry');

    const res = await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'submit', level: 1, reason: 'Covering for E' }, { 'If-Match': '"1"' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.task.state).toBe('approved');
    expect(res.body.skipped_levels).toEqual([2]);
    const row = (await db.query('SELECT self_approval FROM task_instances WHERE id = $1', [t])).rows[0];
    expect(row.self_approval).toBe(true);
    const steps = await db.query(`SELECT action::text, self_approval, on_behalf_of, stepup_verified FROM workflow_steps WHERE task_id = $1 ORDER BY created_at`, [t]);
    expect(steps.rows.map((r) => r.action)).toEqual(['submit', 'auto_skip']);
    expect(steps.rows.every((r) => r.self_approval && r.on_behalf_of === e.user.id)).toBe(true);
    expect(steps.rows[0].stepup_verified).toBe(true);
    const audit = await db.query(`SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'task_submit'`, [t]);
    expect(audit.rows[0].after.self_approval_flag).toBe(true);
  });

  it('rejects at L2 for its holder with a note', async () => {
    const t = await task(s, 'D7', 'in_approval', { actual: true });
    const res = await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'reject', level: 2, reason: 'Approver away', note: 'The date is before the permit' }, { 'If-Match': '"1"' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.task.state).toBe('entry');
    const step = await db.query(`SELECT on_behalf_of FROM workflow_steps WHERE task_id = $1 AND action = 'reject'`, [t]);
    expect(step.rows[0].on_behalf_of).toBe(approver.user.id);
  });

  it('refuses a level that is on nobody (shared by several eligible people): the no-holder path is the System Admins\'', async () => {
    const t = await task(s, 'D7', 'entry', { actual: true });
    const res = await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'submit', level: 1, reason: 'Nobody to cover' }, { 'If-Match': '"1"' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
  });

  it('a cover is bound to its level: a marker granted at L1 is refused at L2, honoured at L2 only when granted there', async () => {
    const t = await task(s, 'D7', 'in_approval', { actual: true });
    const q = async (level: number): Promise<string> => {
      await db.query('BEGIN');
      try {
        await beginAs(db, lead.user.id);
        await db.query(`INSERT INTO hgd_marks (xid, kind, key) VALUES (txid_current(), 'rsn_cover', $1)`, [`${t}|${lead.user.id}|${level}|${approver.user.id}`]);
        const r = await db.query(`SELECT wf_require_actor($1::uuid, 'approve', $2::uuid) AS m`, [t, lead.user.id]);
        return r.rows[0].m as string;
      } catch (err) {
        return String((err as Error).message);
      } finally {
        await db.query('ROLLBACK');
      }
    };
    expect(await q(1)).toMatch(/not_eligible_holder/);
    expect(await q(2)).toBe('cover');
  });

  it('one person completing two levels through a cover is a self-approval (B5): covered L1, then approves L2 as a holder', async () => {
    const t = await task(s, 'D8', 'entry', { pinned: e.user.id, actual: true });
    await setCell(db, 'D8', REGION, 'entry', { role: [roleEng] });
    await setCell(db, 'D8', REGION, 'approve', { user: [approver.user.id] });
    const sub = await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'submit', level: 1, reason: 'E is away' }, { 'If-Match': '"1"' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.task.state).toBe('in_approval');
    // the lead becomes an L2 holder afterwards and approves as a holder
    await setCell(db, 'D8', REGION, 'approve', { user: [lead.user.id] });
    const ok = await lead.api.call('post', `/tasks/${t}/approve`, {}, { 'If-Match': `"${sub.body.task.version}"` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.task.state).toBe('approved');
    const step = await db.query(`SELECT self_approval, stepup_verified FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [t]);
    expect(step.rows).toEqual([{ self_approval: true, stepup_verified: true }]);
    expect((await db.query('SELECT self_approval FROM task_instances WHERE id = $1', [t])).rows[0].self_approval).toBe(true);
    const audit = await db.query(`SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'task_approve'`, [t]);
    expect(audit.rows[0].after.self_approval_flag).toBe(true);
  });

  it('the reverse: submitted L1 as a holder, then covers L2 for its holder: a self-approval (approve needs the step-up)', async () => {
    const t = await task(s, 'D9', 'entry', { pinned: lead.user.id, actual: true });
    await setCell(db, 'D9', REGION, 'entry', { user: [lead.user.id, h.user.id] });
    await setCell(db, 'D9', REGION, 'approve', { user: [approver.user.id] });
    const sub = await lead.api.call('post', `/tasks/${t}/submit`, {}, { 'If-Match': '"1"' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.task.state).toBe('in_approval');
    const v = `"${sub.body.task.version}"`;
    const res = await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'approve', level: 2, reason: 'Approver away' }, { 'If-Match': v });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.task.state).toBe('approved');
    const step = await db.query(`SELECT self_approval, on_behalf_of FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [t]);
    expect(step.rows).toEqual([{ self_approval: true, on_behalf_of: approver.user.id }]);
  });
});

describe('lead scope: every region of the person must be the lead\'s', () => {
  it('a regional lead neither sees, records nor removes absences of a System Admin, an all-regions user or a person with a region outside theirs', async () => {
    const wide = await actor(app, db, { level: 'entry', regions: null });
    const twoRegions = await actor(app, db, { level: 'entry', regions: [REGION, 4] });
    for (const p of [admin, wide, twoRegions]) {
      const rec = await lead.api.call('post', '/absences', { user_id: p.user.id, kind: 'sick', from_date: addDays(today, 100), to_date: addDays(today, 101) });
      expect(rec.status, `record for ${p.user.id}`).toBe(403);
      const own = await absence(p, { kind: 'annual', from_date: addDays(today, 110), to_date: addDays(today, 111) });
      expect((await lead.api.call('get', '/absences').query({ user_id: p.user.id })).body.items).toHaveLength(0);
      expect((await lead.api.call('get', `/absences/${own.id}`)).status).toBe(404);
      expect((await lead.api.call('delete', `/absences/${own.id}`, undefined, { 'If-Match': '"1"' })).status).toBe(404);
      // a System Admin leads everyone
      expect((await admin.api.call('get', `/absences/${own.id}`)).status).toBe(200);
    }
    // nor reassigns or covers their tasks, nor lists the eligible people for them
    const t = await task(await site(), 'D2', 'entry', { pinned: twoRegions.user.id });
    await addAssignment(db, twoRegions.user.id, { roleId: roleEng, level: 'entry', regions: [REGION, 4] });
    expect((await lead.api.call('post', '/tasks/reassign', { scope: 'task', task_id: t, decision: 'keep', reason: 'Not my person' })).status).toBe(403);
    expect((await lead.api.call('post', '/tasks/reassign', { scope: 'person', from_user_id: twoRegions.user.id, decision: 'keep', reason: 'Not my person' })).status).toBe(403);
    expect((await lead.api.call('get', '/reassignments/eligible-users').query({ task_id: t })).status).toBe(403);
    expect((await lead.api.call('post', `/tasks/${t}/act-on-behalf`, { action: 'submit', level: 1, reason: 'Not my person' }, { 'If-Match': '"1"' })).status).toBe(403);
  });
});
