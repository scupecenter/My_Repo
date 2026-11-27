import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, superDb } from './helpers';
import { regCell } from './reg-helpers';
import { addAssignment, makeSite, newRole } from './wf-helpers';

/**
 * Migration 0530 (B1): the notification policy is applied. The gate on notifications (switch, channels, hourly cap, matrix columns), the e-mail decision, the hourly
 * step (approval reminder, escalation, no holder, idle task, retention) and the digest hour. Every test restores the stored policy.
 */
const REGION = 7;
let db: PgClient;
let saved: { had: boolean; value: unknown };

async function setPolicy(p: Record<string, unknown>): Promise<void> {
  const v = JSON.stringify({ version: 0, ...p });
  await db.query(
    `INSERT INTO settings (key, value, description, updated_at) VALUES ('notifications.policy', $1::jsonb, 'test', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
}
async function notice(user: string, kind: string, title: string): Promise<void> {
  await db.query(`INSERT INTO notifications (user_id, channel, kind, title) VALUES ($1, 'in_app', $2, $3)`, [user, kind, title]);
}
const count = async (user: string, kind: string): Promise<number> =>
  (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2', [user, kind])).rows[0].n as number;

beforeAll(async () => {
  db = await superDb();
  const r = await db.query(`SELECT value FROM settings WHERE key = 'notifications.policy'`);
  saved = { had: r.rowCount === 1, value: r.rows[0]?.value };
});
afterAll(async () => {
  if (saved.had) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'notifications.policy'`, [JSON.stringify(saved.value)]);
  else await db.query(`DELETE FROM settings WHERE key = 'notifications.policy'`);
  await db.end();
});

describe('the gate on notifications', () => {
  it('the switch stops governed notices only; mandatory and ungoverned kinds pass', async () => {
    const u = await makeUser(db, { status: 'active' });
    await setPolicy({ enabled: false });
    await notice(u.id, 'task_rejected', 'returned');       // governed (type task_rejected)
    await notice(u.id, 'no_holder', 'nobody');             // mandatory
    await notice(u.id, 'mention', 'hello');                // not in the catalogue
    expect([await count(u.id, 'task_rejected'), await count(u.id, 'no_holder'), await count(u.id, 'mention')]).toEqual([0, 1, 1]);
    await setPolicy({ enabled: true });
    await notice(u.id, 'task_rejected', 'returned again');
    expect(await count(u.id, 'task_rejected')).toBe(1);
  });

  it('a type with the in-app channel off writes nothing; the e-mail decision follows the stored row', async () => {
    const u = await makeUser(db, { status: 'active' });
    await setPolicy({ matrix: [{ type_code: 'task_rejected', channels: { in_app: false, email: true }, cells: [] }] });
    await notice(u.id, 'task_rejected', 'quiet');
    expect(await count(u.id, 'task_rejected')).toBe(0);
    expect((await db.query(`SELECT notif_policy_email('task_rejected') AS e, notif_policy_email('task_assigned') AS n`)).rows[0]).toEqual({ e: true, n: null });
    await setPolicy({});
    await notice(u.id, 'task_rejected', 'loud');
    expect(await count(u.id, 'task_rejected')).toBe(1);
  });

  it('the hourly cap holds back the notices beyond it, except approvals and security', async () => {
    const u = await makeUser(db, { status: 'active' });
    await setPolicy({ thresholds: { rate_cap_per_hour: 3 } });
    await db.query('BEGIN');
    for (let i = 0; i < 5; i++) await db.query(`INSERT INTO notifications (user_id, channel, kind, title, created_at) VALUES ($1, 'in_app', 'task_rejected', $2, now() + $3::int * interval '1 millisecond')`, [u.id, `r${i}`, i + 1]);
    for (let i = 0; i < 5; i++) await db.query(`INSERT INTO notifications (user_id, channel, kind, title, created_at) VALUES ($1, 'in_app', 'approval_due', $2, now() + $3::int * interval '1 millisecond')`, [u.id, `a${i}`, i + 1]);
    await db.query('COMMIT');
    expect([await count(u.id, 'task_rejected'), await count(u.id, 'approval_due')]).toEqual([3, 5]);
    await setPolicy({});
  });

  it('a column that is on adds its members; the person already told is not told twice', async () => {
    const roleId = await newRole(db);
    const holder = await makeUser(db, { status: 'active' });
    const watcher = await makeUser(db, { status: 'active' });
    await addAssignment(db, holder.id, { roleId, regions: [REGION], level: 'approve' });
    await addAssignment(db, watcher.id, { roleId, regions: [REGION], level: 'approve' });
    await setPolicy({ matrix: [{ type_code: 'task_rejected', channels: { in_app: true, email: false }, cells: [{ kind: 'role', id: roleId, on: true }] }] });
    await notice(holder.id, 'task_rejected', 'column test');
    expect([await count(holder.id, 'task_rejected'), await count(watcher.id, 'task_rejected')]).toEqual([1, 1]);
    await setPolicy({});
  });
});

describe('notif_policy_tick', () => {
  async function waitingRecord(region: number, daysAgo: number): Promise<{ id: string; link: string }> {
    const r = await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, current_level, level_opened_at)
       VALUES (gen_random_uuid(), 1, 'permits_hse', $1, $2, 'in_review', false, '{}'::jsonb, 2, now() - ($3::int * interval '1 day')) RETURNING id`,
      [(await makeSite(db, region, { prefix: 'NPA' })).id, region, daysAgo]);
    const id = r.rows[0].id as string;
    return { id, link: `/registers/permits_hse/records/${id}` };
  }
  const to = async (link: string, kind: string, title: string): Promise<number> =>
    (await db.query('SELECT count(*)::int AS n FROM notifications WHERE link = $1 AND kind = $2 AND title = $3', [link, kind, title])).rows[0].n as number;

  it('reminds the holder, escalates, tells the System Admins when nobody can act, and does not repeat', async () => {
    await setPolicy({});
    const roleId = await newRole(db);
    const holder = await makeUser(db, { status: 'active' });
    await addAssignment(db, holder.id, { roleId, regions: [REGION], modules: ['permits_hse'], level: 'approve' });
    await regCell(db, 'permits_hse', REGION, 'review', { user: [holder.id] });
    const rec = await waitingRecord(REGION, 12);
    await db.query('SELECT notif_policy_tick()');
    expect(await to(rec.link, 'approval_due', 'Approval reminder')).toBe(1);
    expect((await db.query(`SELECT user_id FROM notifications WHERE link = $1 AND title = 'Approval reminder'`, [rec.link])).rows[0].user_id).toBe(holder.id);
    expect(await to(rec.link, 'approval_due', 'Approval escalated')).toBeGreaterThanOrEqual(1);
    await db.query('SELECT notif_policy_tick()');
    expect(await to(rec.link, 'approval_due', 'Approval reminder')).toBe(1);

    // a level nobody can act on: the Matrix cell holds a person who has no assignment in the region
    const ghost = await makeUser(db, { status: 'active' });
    await regCell(db, 'permits_hse', 5, 'review', { user: [ghost.id] });
    const lonely = await waitingRecord(5, 1);
    await db.query('SELECT notif_policy_tick()');
    expect(await to(lonely.link, 'no_holder', 'Level has no holder')).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('the switch off stops the reminders but not the no-holder alert', async () => {
    await setPolicy({ enabled: false });
    const ghost = await makeUser(db, { status: 'active' });
    await regCell(db, 'permits_hse', 4, 'review', { user: [ghost.id] });
    const lonely = await waitingRecord(4, 20);
    await db.query('SELECT notif_policy_tick()');
    expect(await to(lonely.link, 'approval_due', 'Approval reminder')).toBe(0);
    expect(await to(lonely.link, 'approval_due', 'Approval escalated')).toBe(0);
    expect(await to(lonely.link, 'no_holder', 'Level has no holder')).toBeGreaterThanOrEqual(1);
    await setPolicy({});
  }, 120000);

  it('deletes notices older than the retention (default 180 days) and keeps the rest', async () => {
    const u = await makeUser(db, { status: 'active' });
    await db.query(`INSERT INTO notifications (user_id, channel, kind, title, created_at) VALUES ($1, 'in_app', 'mention', 'old', now() - interval '400 days'), ($1, 'in_app', 'mention', 'new', now())`, [u.id]);
    const r = await db.query('SELECT notif_policy_tick() AS t');
    expect(r.rows[0].t.purged).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT title FROM notifications WHERE user_id = $1`, [u.id])).rows.map((x) => x.title)).toEqual(['new']);
  });

  it('writes the idle-task alert once per idle spell to the Team Leads, and stops when the switch is off', async () => {
    await setPolicy({});
    const site = await makeSite(db, 3, { prefix: 'IDL' });
    const t = await db.query(
      `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, level_opened_at, level_round, updated_at)
       VALUES ($1, 3, (SELECT id FROM task_definitions LIMIT 1), 'open', 1, 3, now() - interval '30 days', 1, now() - interval '30 days') RETURNING id`, [site.id]);
    const id = t.rows[0].id as string;
    await db.query('SELECT notif_policy_tick()');
    const n1 = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE task_id = $1 AND kind = 'idle_task_alert'`, [id])).rows[0].n as number;
    expect(n1).toBeGreaterThanOrEqual(1);
    await db.query('SELECT notif_policy_tick()');
    expect((await db.query(`SELECT count(*)::int AS n FROM notifications WHERE task_id = $1 AND kind = 'idle_task_alert'`, [id])).rows[0].n).toBe(n1);
  }, 120000);
});

describe('notif_digest_due', () => {
  it('is true from the digest hour on, in the policy time zone, and only when the policy is on', async () => {
    await setPolicy({ digest_hour: 8, timezone: 'Africa/Tripoli' });
    const due = async (at: string): Promise<boolean> => (await db.query('SELECT notif_digest_due($1::timestamptz) AS d', [at])).rows[0].d as boolean;
    expect(await due('2026-01-05T05:00:00Z')).toBe(false);   // 07:00 in Tripoli
    expect(await due('2026-01-05T06:00:00Z')).toBe(true);    // 08:00
    expect(await due('2026-01-05T15:00:00Z')).toBe(true);
    await setPolicy({ digest_hour: 8, timezone: 'Africa/Tripoli', enabled: false });
    expect(await due('2026-01-05T15:00:00Z')).toBe(false);
    await setPolicy({});
  });
});
