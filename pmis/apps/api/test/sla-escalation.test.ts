import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, superDb } from './helpers';
import { addAssignment, makeSite, newRole, taskDef, type Site } from './wf-helpers';

/**
 * Migration 0165: sla_escalation_notify(), the SLA escalation ladder (NOTIFY ONLY). One in-app notification per person and task, only for the
 * escalation role of the SLA rule, only for people who hold that role now and whose assignment covers the task's region and the Sites module.
 */
const REGION = 7;
const OTHER_REGION = 5;
const PREFIX = `SLE${randomBytes(3).toString('hex').toUpperCase()}`;
let db: PgClient;
let calendarId: string;
let adminId: string;
let ruleDay = Math.floor(Math.random() * 8000) + 21000;

beforeAll(async () => {
  db = await superDb();
  const c = await db.query('INSERT INTO work_calendars (code, name, weekend_days) VALUES ($1, $1, $2::int[]) RETURNING id', [`SLE${randomBytes(4).toString('hex')}`, []]);
  calendarId = c.rows[0].id as string;
  adminId = (await makeUser(db, { status: 'active' })).id;
});
afterAll(async () => {
  await db.end();
});

async function ruleWith(taskCode: string, escalationRole: string | null, max = 3): Promise<string> {
  const td = await taskDef(db, taskCode);
  ruleDay += 1;
  const r = await db.query(
    `INSERT INTO sla_rules (task_def_id, min_working_days, max_working_days, start_event, calendar_id, effective_from, effective_to, reason, changed_by, escalation_role)
     VALUES ($1, 1, $2, 'OPEN', $3, DATE '1900-01-01' + $5::int, DATE '1900-01-01' + $5::int + 1, 'SLA escalation test rule', $4, $6) RETURNING id`,
    [td.id, max, calendarId, adminId, ruleDay, escalationRole],
  );
  return r.rows[0].id as string;
}

async function task(s: Site, code: string, state: string, rule: string, startAgo: number): Promise<string> {
  const td = await taskDef(db, code);
  const level = state === 'open' || state === 'entry' ? 1 : state === 'in_review' ? 2 : state === 'in_approval' ? 3 : 0;
  const r = await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, sla_rule_id, sla_start_date, level_round, updated_at)
     VALUES ($1, $2, $3, $4::"TaskState", $5, 3, $6, cal_today() - $7::int, 1, now()) RETURNING id`,
    [s.id, s.region, td.id, state, level, rule, startAgo],
  );
  return r.rows[0].id as string;
}

const notified = async (taskId: string): Promise<string[]> =>
  (await db.query(`SELECT user_id::text AS u FROM notifications WHERE kind = 'sla_escalation' AND task_id = $1 ORDER BY 1`, [taskId])).rows.map((x) => x.u as string);

describe('sla_escalation_notify', () => {
  it('notifies the escalation role about an overdue task: only people who hold it now and may see the task; once; and changes no task', async () => {
    const roleId = await newRole(db);
    const roleCode = (await db.query('SELECT code FROM roles WHERE id = $1', [roleId])).rows[0].code as string;
    const otherRole = await newRole(db);
    const site = await makeSite(db, REGION, { prefix: PREFIX });
    const rule = await ruleWith('D6', roleCode);
    const overdue = await task(site, 'D6', 'entry', rule, 10);

    const inScope = await makeUser(db, { status: 'active' });
    const allRegions = await makeUser(db, { status: 'active' });
    const wrongRegion = await makeUser(db, { status: 'active' });
    const wrongModule = await makeUser(db, { status: 'active' });
    const expired = await makeUser(db, { status: 'active' });
    const deleted = await makeUser(db, { status: 'active' });
    const otherRoleUser = await makeUser(db, { status: 'active' });
    await addAssignment(db, inScope.id, { roleId, regions: [REGION], modules: ['sites'] });
    await addAssignment(db, allRegions.id, { roleId, regions: null, modules: null });
    await addAssignment(db, wrongRegion.id, { roleId, regions: [OTHER_REGION], modules: ['sites'] });
    await addAssignment(db, wrongModule.id, { roleId, regions: [REGION], modules: ['quality'] });
    const exp = await addAssignment(db, expired.id, { roleId, regions: [REGION], modules: ['sites'] });
    await db.query(`UPDATE user_role_assignments SET valid_from = now() - interval '10 days', valid_to = now() - interval '1 day' WHERE id = $1`, [exp]);
    await addAssignment(db, deleted.id, { roleId, regions: [REGION], modules: ['sites'] });
    await db.query('UPDATE users SET deleted_at = now(), status = 'disabled' WHERE id = $1', [deleted.id]);
    await addAssignment(db, otherRoleUser.id, { roleId: otherRole, regions: [REGION], modules: ['sites'] });

    const before = (await db.query('SELECT state::text AS s, updated_at FROM task_instances WHERE id = $1', [overdue])).rows[0];
    const n1 = (await db.query('SELECT sla_escalation_notify() AS n')).rows[0].n as number;
    expect(n1).toBeGreaterThanOrEqual(2);
    expect(await notified(overdue)).toEqual([inScope.id, allRegions.id].sort());
    // the notification points at the site and carries the task region and the Sites module
    const row = (await db.query(`SELECT link, region_id, module_key, channel::text AS channel FROM notifications WHERE kind = 'sla_escalation' AND task_id = $1 AND user_id = $2`, [overdue, inScope.id])).rows[0];
    expect(row).toMatchObject({ link: `/sites/${site.id}`, region_id: REGION, module_key: 'sites', channel: 'in_app' });
    // safe to repeat: nothing new
    await db.query('SELECT sla_escalation_notify()');
    expect(await notified(overdue)).toEqual([inScope.id, allRegions.id].sort());
    // notify only: the task is untouched
    const after = (await db.query('SELECT state::text AS s, updated_at FROM task_instances WHERE id = $1', [overdue])).rows[0];
    expect(after).toEqual(before);
  });

  it('does nothing for a task inside its SLA, an approved task, a rule without an escalation role, or a role name that matches nobody', async () => {
    const roleId = await newRole(db);
    const roleCode = (await db.query('SELECT code FROM roles WHERE id = $1', [roleId])).rows[0].code as string;
    const u = await makeUser(db, { status: 'active' });
    await addAssignment(db, u.id, { roleId, regions: [REGION], modules: ['sites'] });
    const withRole = await ruleWith('D6', roleCode);
    const noRole = await ruleWith('D6', null);
    const ghost = await ruleWith('D6', `NO_SUCH_ROLE_${randomBytes(3).toString('hex')}`);
    const inside = await task(await makeSite(db, REGION, { prefix: PREFIX }), 'D6', 'entry', withRole, 1);
    const approved = await task(await makeSite(db, REGION, { prefix: PREFIX }), 'D6', 'approved', withRole, 10);
    const noEsc = await task(await makeSite(db, REGION, { prefix: PREFIX }), 'D6', 'entry', noRole, 10);
    const nobody = await task(await makeSite(db, REGION, { prefix: PREFIX }), 'D6', 'entry', ghost, 10);
    await db.query('SELECT sla_escalation_notify()');
    for (const t of [inside, approved, noEsc, nobody]) expect(await notified(t)).toEqual([]);
  });

  it('the role is matched by its English name too, ignoring case; an inactive role notifies nobody', async () => {
    const roleId = await newRole(db);
    const u = await makeUser(db, { status: 'active' });
    await addAssignment(db, u.id, { roleId, regions: [REGION], modules: ['sites'] });
    const name = (await db.query('SELECT name_en FROM roles WHERE id = $1', [roleId])).rows[0].name_en as string;
    const site = await makeSite(db, REGION, { prefix: PREFIX });
    const byName = await ruleWith('D6', name.toLowerCase());
    const t1 = await task(site, 'D6', 'in_review', byName, 10);
    await db.query('SELECT sla_escalation_notify()');
    expect(await notified(t1)).toEqual([u.id]);
    const roleOff = await newRole(db);
    const u2 = await makeUser(db, { status: 'active' });
    await addAssignment(db, u2.id, { roleId: roleOff, regions: [REGION], modules: ['sites'] });
    await db.query('UPDATE roles SET is_active = false WHERE id = $1', [roleOff]);
    const code2 = (await db.query('SELECT code FROM roles WHERE id = $1', [roleOff])).rows[0].code as string;
    const t2 = await task(await makeSite(db, REGION, { prefix: PREFIX }), 'D6', 'entry', await ruleWith('D6', code2), 10);
    await db.query('SELECT sla_escalation_notify()');
    expect(await notified(t2)).toEqual([]);
  });
});
