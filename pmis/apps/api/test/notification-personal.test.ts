import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0583 (contract 0.15.531): the personal layer on top of the applied policy. Own type choices, scheduled do-not-disturb and snooze, the cross-transaction
 * dedupe, the decisions the person can read, the test notice, the org switches (audited), and the data reset classes. Every test restores the org switches.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let a: Actor;
let b: Actor;
let savedOrg: { had: boolean; value: unknown };

const notice = (user: string, kind: string, title: string, link: string | null = null) =>
  db.query(`INSERT INTO notifications (user_id, channel, kind, title, link) VALUES ($1, 'in_app', $2, $3, $4)`, [user, kind, title, link]);
const count = async (user: string, kind: string): Promise<number> =>
  (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2', [user, kind])).rows[0].n as number;
const setOrg = (v: Record<string, unknown>) =>
  db.query(`INSERT INTO settings (key, value, description, updated_at) VALUES ('notifications.personal', $1::jsonb, 'test', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ version: 0, ...v })]);

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  a = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  b = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  const r = await db.query(`SELECT value FROM settings WHERE key = 'notifications.personal'`);
  savedOrg = { had: r.rowCount === 1, value: r.rows[0]?.value };
});
afterAll(async () => {
  if (savedOrg.had) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'notifications.personal'`, [JSON.stringify(savedOrg.value)]);
  else await db.query(`DELETE FROM settings WHERE key = 'notifications.personal'`);
  await db.end();
  await app.close();
});

describe('own type choices', () => {
  it('lists the catalogue, keeps a mandatory type on, and stops a type the person turned off (with a decision)', async () => {
    const g = await a.api.call('get', '/me/notification-prefs');
    expect(g.status).toBe(200);
    expect((g.body.types as unknown[]).length).toBeGreaterThan(5);
    // a System Admin also sees the admin-only types; a mandatory one is listed as on
    const ag = (await admin.api.call('get', '/me/notification-prefs')).body.types as { code: string; mandatory: boolean; in_app: boolean }[];
    expect(ag.find((t) => t.code === 'no_holder')).toMatchObject({ mandatory: true, in_app: true });
    expect((g.body.types as { code: string }[]).some((t) => t.code === 'no_holder')).toBe(false);
    const put = await a.api.call('put', '/me/notification-prefs', { types: { task_rejected: { in_app: false }, no_holder: { in_app: false, email: false } } }, { 'If-Match': `"${g.body.version}"` });
    expect(put.status).toBe(200);
    const after = put.body.types as { code: string; in_app: boolean; email: boolean }[];
    expect(after.find((t) => t.code === 'task_rejected')).toMatchObject({ in_app: false, email: true });
    expect((await db.query('SELECT types FROM notification_user_prefs WHERE user_id = $1', [a.user.id])).rows[0].types).toEqual({ task_rejected: { in_app: false, email: true } });   // a mandatory type is never stored
    await notice(a.user.id, 'task_rejected', 'returned');
    await notice(a.user.id, 'no_holder', 'nobody');                                                                 // mandatory passes
    expect([await count(a.user.id, 'task_rejected'), await count(a.user.id, 'no_holder')]).toEqual([0, 1]);
    const d = await a.api.call('get', '/me/notification-prefs/decisions');
    expect(d.body.items[0]).toMatchObject({ kind: 'task_rejected', channel: 'in_app', reason: 'type_off' });
    expect((await b.api.call('get', '/me/notification-prefs/decisions')).body.items).toEqual([]);                  // own rows only
    await notice(b.user.id, 'task_rejected', 'returned');
    expect(await count(b.user.id, 'task_rejected')).toBe(1);                                                        // another person is not affected
  });

  it('refuses a stale version, an unknown type and a bad window', async () => {
    expect((await a.api.call('put', '/me/notification-prefs', { types: {} }, { 'If-Match': '"999"' })).status).toBe(412);
    const v = (await a.api.call('get', '/me/notification-prefs')).body.version;
    expect((await a.api.call('put', '/me/notification-prefs', { types: { nope: { in_app: false } } }, { 'If-Match': `"${v}"` })).status).toBe(422);
    expect((await a.api.call('put', '/me/notification-prefs', { dnd: { start: 1500 } }, { 'If-Match': `"${v}"` })).status).toBe(422);
    expect((await a.api.call('put', '/me/notification-prefs', { dnd: { timezone: 'Not/AZone' } }, { 'If-Match': `"${v}"` })).status).toBe(422);
    expect((await a.api.call('put', '/me/notification-prefs', { types: {} })).status).toBe(428);
  });
});

describe('the same unread notice twice (across transactions)', () => {
  it('is written once inside the window, again after it is read, and never for a mandatory kind; 0 turns it off', async () => {
    await setOrg({ dedupe_minutes: 10 });
    const u = await makeUser(db, { status: 'active' });
    await notice(u.id, 'task_assigned', 'new task', '/tasks/1');
    await notice(u.id, 'task_assigned', 'new task', '/tasks/1');
    expect(await count(u.id, 'task_assigned')).toBe(1);
    await notice(u.id, 'task_assigned', 'new task', '/tasks/2');                                                    // another link
    expect(await count(u.id, 'task_assigned')).toBe(2);
    await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1`, [u.id]);
    await notice(u.id, 'task_assigned', 'new task', '/tasks/1');
    expect(await count(u.id, 'task_assigned')).toBe(3);
    await notice(u.id, 'no_holder', 'nobody', '/x');
    await notice(u.id, 'no_holder', 'nobody', '/x');
    expect(await count(u.id, 'no_holder')).toBe(2);
    expect((await db.query(`SELECT count(*)::int AS n FROM notification_decisions WHERE user_id = $1 AND reason = 'duplicate'`, [u.id])).rows[0].n).toBe(1);
    await setOrg({ dedupe_minutes: 0 });
    await notice(u.id, 'task_assigned', 'again', '/tasks/9');
    await notice(u.id, 'task_assigned', 'again', '/tasks/9');
    expect(await count(u.id, 'task_assigned')).toBe(5);
  });
});

describe('do-not-disturb and snooze', () => {
  it('the window may cross midnight (its day is the day it starts); a snooze holds until it ends; the org switch turns the schedule off', async () => {
    await setOrg({});
    const u = await makeUser(db, { status: 'active' });
    await db.query(`INSERT INTO notification_user_prefs (user_id, dnd_enabled, dnd_start, dnd_end, dnd_days, dnd_timezone) VALUES ($1, true, 1320, 420, ARRAY[5]::smallint[], 'UTC')`, [u.id]);
    const q = async (at: string) => (await db.query(`SELECT notif_user_quiet($1, $2::timestamptz) AS q`, [u.id, at])).rows[0].q as boolean;
    expect(await q('2026-11-27T23:00:00Z')).toBe(true);          // Friday 23:00
    expect(await q('2026-11-28T02:00:00Z')).toBe(true);          // Saturday 02:00, the window that started on Friday
    expect(await q('2026-11-28T08:00:00Z')).toBe(false);         // after 07:00
    expect(await q('2026-11-28T23:00:00Z')).toBe(false);         // Saturday 23:00: Saturday is not a chosen day
    expect(await q('2026-11-26T23:00:00Z')).toBe(false);         // Thursday
    await db.query(`UPDATE notification_user_prefs SET dnd_enabled = false, snooze_until = now() + interval '1 hour' WHERE user_id = $1`, [u.id]);
    expect((await db.query(`SELECT notif_user_quiet($1) AS q`, [u.id])).rows[0].q).toBe(true);
    await db.query(`UPDATE notification_user_prefs SET snooze_until = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);
    expect((await db.query(`SELECT notif_user_quiet($1) AS q`, [u.id])).rows[0].q).toBe(false);
    await db.query(`UPDATE notification_user_prefs SET dnd_enabled = true WHERE user_id = $1`, [u.id]);
    await setOrg({ allow_dnd: false });
    expect(await q('2026-11-27T23:00:00Z')).toBe(false);
    await setOrg({ allow_personal: false });
    await db.query(`UPDATE notification_user_prefs SET snooze_until = now() + interval '1 hour' WHERE user_id = $1`, [u.id]);
    expect((await db.query(`SELECT notif_user_quiet($1) AS q`, [u.id])).rows[0].q).toBe(false);
    await setOrg({});
  });

  it('quiet time stops the e-mail of a governed kind (with a decision) and lets a mandatory kind through; push waits', async () => {
    await setOrg({});
    const u = await makeUser(db, { status: 'active' });
    await db.query(`INSERT INTO notification_user_prefs (user_id, snooze_until) VALUES ($1, now() + interval '1 hour')`, [u.id]);
    expect((await db.query(`SELECT notif_user_mail_blocked($1, 'task_assigned', 't', '/l') AS b, notif_user_mail_blocked($1, 'no_holder', 't', '/l') AS m`, [u.id])).rows[0]).toEqual({ b: true, m: false });
    expect((await db.query(`SELECT count(*)::int AS n FROM notification_decisions WHERE user_id = $1 AND reason = 'quiet_mail'`, [u.id])).rows[0].n).toBe(1);
    const sub = `https://push.example.test/${u.id}`;
    await db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, last_notification_at) VALUES ($1, $2, 'BPublicKeyForTestingOnly1234567890', 'authsecret12345', now() - interval '1 day')`, [u.id, sub]);
    await db.query(`INSERT INTO notifications (user_id, channel, kind, title, link) VALUES ($1, 'in_app', 'task_assigned', 'x', '/q')`, [u.id]);
    const due = async () => (await db.query(`SELECT count(*)::int AS n FROM push_due(200) WHERE endpoint = $1`, [sub])).rows[0].n as number;
    expect(await due()).toBe(0);                                                           // held in quiet time
    await db.query(`UPDATE notification_user_prefs SET snooze_until = NULL WHERE user_id = $1`, [u.id]);
    expect(await due()).toBe(1);                                                           // sent when quiet ends
  });

  it('snooze and clear through the API; at most 14 days; the test notice reaches the bell and pauses 30 seconds', async () => {
    await setOrg({});
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const s = await a.api.call('post', '/me/notification-prefs/snooze', { until: when });
    expect(s.status).toBe(200);
    expect(s.body.quiet_now).toBe(true);
    expect((await a.api.call('post', '/me/notification-prefs/snooze', { until: new Date(Date.now() + 20 * 86_400_000).toISOString() })).status).toBe(422);
    expect((await a.api.call('post', '/me/notification-prefs/snooze', { until: null })).body.quiet_now).toBe(false);
    const t = await a.api.call('post', '/me/notification-prefs/test');
    expect(t.status).toBe(200);
    expect(await count(a.user.id, 'system')).toBeGreaterThanOrEqual(1);
    expect((await a.api.call('post', '/me/notification-prefs/test')).status).toBe(429);
  });
});

describe('the org switches', () => {
  it('are System Admin only, audited with a reason, versioned, and turn the personal layer off', async () => {
    await setOrg({});
    expect((await a.api.call('get', '/admin/notification-personal')).status).toBe(403);
    const g = await admin.api.call('get', '/admin/notification-personal');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ allow_personal: true, allow_dnd: true, dedupe_minutes: 10, decision_retention_days: 30 });
    expect((await admin.api.call('put', '/admin/notification-personal', { dedupe_minutes: 5 }, { 'If-Match': `"${g.body.version}"` })).status).toBe(422);   // no reason
    expect((await admin.api.call('put', '/admin/notification-personal', { dedupe_minutes: 5000, reason: 'test change' }, { 'If-Match': `"${g.body.version}"` })).status).toBe(422);
    const ok = await admin.api.call('put', '/admin/notification-personal', { allow_personal: false, dedupe_minutes: 5, reason: 'test change' }, { 'If-Match': `"${g.body.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ allow_personal: false, dedupe_minutes: 5, version: g.body.version + 1 });
    expect((await admin.api.call('put', '/admin/notification-personal', { allow_personal: true, reason: 'stale' }, { 'If-Match': `"${g.body.version}"` })).status).toBe(412);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'notification_personal_update' AND entity_id = 'notifications.personal'`)).rows[0].n).toBeGreaterThanOrEqual(1);
    const v = (await a.api.call('get', '/me/notification-prefs')).body.version;
    expect((await a.api.call('put', '/me/notification-prefs', { types: {} }, { 'If-Match': `"${v}"` })).status).toBe(403);   // switched off for everyone
    await setOrg({});
  });
});

describe('data reset and grants', () => {
  it('classifies both tables, keeps the app role read-only, and the hourly step purges old decisions', async () => {
    const plan = (await db.query(`SELECT tbl, action FROM data_reset_plan() WHERE tbl IN ('notification_user_prefs', 'notification_decisions')`)).rows as { tbl: string; action: string }[];
    expect(plan.map((r) => r.tbl).sort()).toEqual(['notification_decisions', 'notification_user_prefs']);
    for (const t of ['notification_user_prefs', 'notification_decisions']) {
      expect((await db.query(`SELECT has_table_privilege('pmis_app', $1, 'INSERT') AS w, has_table_privilege('pmis_reset_owner', $1, 'SELECT') AS r`, [t])).rows[0]).toEqual({ w: false, r: true });
    }
    const u = await makeUser(db, { status: 'active' });
    await db.query(`INSERT INTO notification_decisions (user_id, kind, channel, reason, created_at) VALUES ($1, 'task_assigned', 'in_app', 'duplicate', now() - interval '40 days'), ($1, 'task_assigned', 'in_app', 'duplicate', now())`, [u.id]);
    await setOrg({ decision_retention_days: 30 });
    await db.query('SELECT notif_policy_tick()');
    expect((await db.query(`SELECT count(*)::int AS n FROM notification_decisions WHERE user_id = $1`, [u.id])).rows[0].n).toBe(1);
    await setOrg({});
  });
});
