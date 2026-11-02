import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, startApp, superDb } from './helpers';
import { G, createRec, team } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * X1, the notification inbox (migration 0031 and the review fixes of migration 0040). Region 6 (GM) for sites and tasks, the GECOL register in region 6.
 * Every test builds its own users. Nothing here depends on the weekday, the clock of the day or the database collation (ids and counts only).
 */
const REGION = 6;
const PREFIX = `XI${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const site = (region = REGION) => makeSite(db, region, { prefix: PREFIX });
const reader = (regions: number[] | null = [REGION]) =>
  actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('gecol', 'view')], regions, modules: null });
const ids = (res: { body: { items: { id: string }[] } }): string[] => res.body.items.map((i) => i.id);

/** A notification written the way the database functions write it (as the superuser here); the trigger fills region_id and module_key. */
async function notify(
  userId: string,
  title: string,
  o: { kind?: string; taskId?: string; link?: string; at?: string; read?: boolean; snooze?: string } = {},
): Promise<string> {
  const r = await db.query(
    `INSERT INTO notifications (user_id, channel, kind, title, task_id, link, created_at, read_at, snoozed_until)
     VALUES ($1, 'in_app', $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8) RETURNING id::text AS id`,
    [userId, o.kind ?? 'task_assigned', title, o.taskId ?? null, o.link ?? null, o.at ?? null, o.read ? new Date() : null, o.snooze ?? null],
  );
  return r.rows[0].id as string;
}

/** Narrows the only assignment of the user to the given regions (one transaction: the scope check is deferred). */
async function restrictRegions(userId: string, regions: number[]): Promise<void> {
  await db.query('BEGIN');
  try {
    const a = await db.query('SELECT id FROM user_role_assignments WHERE user_id = $1', [userId]);
    for (const { id } of a.rows) {
      await db.query('UPDATE user_role_assignments SET all_regions = false WHERE id = $1', [id]);
      await db.query('DELETE FROM user_role_assignment_regions WHERE assignment_id = $1', [id]);
      for (const r of regions) await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, $2)', [id, r]);
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

/** Takes a grant out of the profile of the user's assignment. */
async function dropGrant(userId: string, module: string): Promise<void> {
  await db.query(
    `DELETE FROM permission_grants WHERE module_key = $2 AND profile_id IN
       (SELECT ap.profile_id FROM user_role_assignment_profiles ap JOIN user_role_assignments ua ON ua.id = ap.assignment_id WHERE ua.user_id = $1)`,
    [userId, module],
  );
}

const audits = async (action: string, actorId: string) =>
  (await db.query('SELECT entity_id, before, after, ip FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id', [action, actorId])).rows;

describe('X1 inbox: who may call it', () => {
  it('answers 401 to every inbox endpoint without a session', async () => {
    const anon = (m: 'get' | 'post', p: string) => request(app.getHttpServer())[m](`${API}${p}`).send(m === 'post' ? {} : undefined);
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [m, p] of [['get', '/notifications'], ['post', '/notifications/read-all'], ['post', `/notifications/${id}/read`], ['post', `/notifications/${id}/unread`],
      ['post', `/notifications/${id}/snooze`], ['get', '/me/follows']] as const) {
      expect((await anon(m, p)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('a malformed id is 404 and another person\'s notification is 404 too, never 403', async () => {
    const me = await reader();
    const other = await reader();
    const theirs = await notify(other.user.id, 'private');
    for (const a of ['read', 'unread']) {
      expect((await me.api.call('post', `/notifications/${theirs}/${a}`)).status).toBe(404);
      expect((await me.api.call('post', `/notifications/not-a-uuid/${a}`)).status).toBe(404);
    }
    expect((await me.api.call('post', `/notifications/${theirs}/snooze`, { until: null })).status).toBe(404);
    // nothing of theirs changed
    const row = await db.query('SELECT read_at, snoozed_until FROM notifications WHERE id = $1', [theirs]);
    expect(row.rows[0]).toEqual({ read_at: null, snoozed_until: null });
  });
});

describe('X1 inbox: what the caller can still read', () => {
  it('hides a task notification once the region is taken away, with its count, and brings it back when the region returns', async () => {
    const me = await reader([REGION, 1]);
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'open');
    const mine = await notify(me.user.id, 'WM task waits for you', { taskId: tid, link: `/tasks/${tid}` });
    const personal = await notify(me.user.id, 'A system notice', { kind: 'system' });

    let res = await me.api.call('get', '/notifications');
    expect(ids(res).sort()).toEqual([mine, personal].sort());
    expect(res.body.unread_count).toBe(2);
    expect(res.body.items.find((i: { id: string }) => i.id === mine)).toMatchObject({ entity_type: 'task', entity_id: tid });

    await restrictRegions(me.user.id, [1]);
    res = await me.api.call('get', '/notifications');
    expect(ids(res)).toEqual([personal]);
    expect(res.body.unread_count).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('waits for you');
    // include / only / unread_only cannot bring it back
    for (const q of ['?snoozed=include', '?unread_only=true', '?kind=task_assigned']) {
      expect(JSON.stringify((await me.api.call('get', `/notifications${q}`)).body), q).not.toContain(mine);
    }
    // acting on it is 404, not 403 (the caller must not learn that it exists)
    expect((await me.api.call('post', `/notifications/${mine}/read`)).status).toBe(404);
    expect((await me.api.call('post', `/notifications/${mine}/unread`)).status).toBe(404);
    expect((await me.api.call('post', `/notifications/${mine}/snooze`, { until: null })).status).toBe(404);

    await restrictRegions(me.user.id, [1, REGION]);
    expect(ids(await me.api.call('get', '/notifications')).sort()).toEqual([mine, personal].sort());
  });

  it('hides a register notification once the register\'s module is taken away, and read-all leaves the hidden ones unread', async () => {
    const t = await team(app, db, 'gecol', 'gecol', REGION);
    const me = await reader();
    const rec = await createRec(t, { pr_no: 'GP-X1', request_date: '2026-01-05' });
    const proper = await notify(me.user.id, 'GECOL record changed', { kind: 'followed_change', link: `/registers/gecol/records/${rec.id}` });
    const visible = await notify(me.user.id, 'Another notice', { kind: 'system' });
    expect(ids(await me.api.call('get', '/notifications')).sort()).toEqual([proper, visible].sort());

    await dropGrant(me.user.id, 'gecol');
    const res = await me.api.call('get', '/notifications');
    expect(ids(res)).toEqual([visible]);
    expect(res.body.unread_count).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('GECOL record changed');

    expect((await me.api.call('post', '/notifications/read-all')).status).toBe(204);
    const rows = await db.query('SELECT id::text AS id, read_at IS NOT NULL AS is_read FROM notifications WHERE user_id = $1', [me.user.id]);
    const state = Object.fromEntries(rows.rows.map((r) => [r.id, r.is_read]));
    expect(state[proper]).toBe(false); // out of scope: not touched
    expect(state[visible]).toBe(true);
    expect((await audits('notification_read_all', me.user.id))[0]?.after).toEqual({ count: 1 });
  });

  it('a user with the scope but without the view right on the module sees no notification of it', async () => {
    const t = await team(app, db, 'gecol', 'gecol', REGION);
    const rec = await createRec(t, { pr_no: 'GP-X2', request_date: '2026-01-05' });
    const noGrant = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: null });
    const n = await notify(noGrant.user.id, 'record notice', { link: `/registers/gecol/records/${rec.id}` });
    const res = await noGrant.api.call('get', '/notifications');
    expect(ids(res)).toEqual([]);
    expect(res.body.unread_count).toBe(0);
    expect((await noGrant.api.call('post', `/notifications/${n}/read`)).status).toBe(404);
  });

  it('a System Admin sees the notifications of every region', async () => {
    const admin = await plainAdmin(app, db);
    const s = await site(3);
    const tid = await makeTask(db, s, 'A1', 'open');
    const n = await notify(admin.user.id, 'no holder', { kind: 'no_holder', taskId: tid, link: `/tasks/${tid}` });
    expect(ids(await admin.api.call('get', '/notifications'))).toContain(n);
  });

  it('fills region_id and module_key from the task or the register link when a notification is written', async () => {
    const t = await team(app, db, 'gecol', 'gecol', REGION);
    const u = await reader();
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'open');
    const rec = await createRec(t, { pr_no: 'GP-X3', request_date: '2026-01-05' });
    const a = await notify(u.user.id, 'task', { taskId: tid, link: `/tasks/${tid}` });
    const b = await notify(u.user.id, 'record', { link: `/registers/gecol/records/${rec.id}` });
    const c = await notify(u.user.id, 'dangling', { link: '/registers/gecol/records/00000000-0000-4000-8000-000000000000' });
    const d = await notify(u.user.id, 'plain', { link: '/approvals' });
    const e = await notify(u.user.id, 'odd link', { link: `/registers/gecol/records/${'-'.repeat(36)}` }); // never breaks the write of a notification
    const rows = await db.query('SELECT id::text AS id, region_id, module_key FROM notifications WHERE id = ANY($1::uuid[])', [[a, b, c, d, e]]);
    const by = Object.fromEntries(rows.rows.map((r) => [r.id, [r.region_id, r.module_key]]));
    expect(by[a]).toEqual([REGION, 'sites']);
    expect(by[b]).toEqual([REGION, 'gecol']);
    expect(by[c]).toEqual([null, null]);
    expect(by[d]).toEqual([null, null]);
    expect(by[e]).toEqual([null, null]);
  });
});

describe('X1 inbox: list, pages, filters', () => {
  it('pages with a cursor without gaps or repeats, newest first, and rejects a bad kind, snoozed, limit or cursor', async () => {
    const me = await reader();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push(await notify(me.user.id, `n${i}`, { at: `2026-03-0${i + 1}T10:00:00Z` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: request.Response = await me.api.call('get', `/notifications?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...ids(res));
      cursor = res.body.page.next_cursor;
      if (!cursor) break;
      expect(res.body.items).toHaveLength(2);
    }
    expect(seen).toEqual([...made].reverse());
    expect(new Set(seen).size).toBe(5);
    for (const q of ['kind=nope', 'snoozed=later', 'limit=0', 'limit=9999']) {
      expect((await me.api.call('get', `/notifications?${q}`)).status, q).toBe(422);
    }
    // a cursor that is not ours, or whose parts do not have the right shape, is 400 and never reaches the database
    const forged = (parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
    for (const c of ['@@@', forged(['x', 'y']), forged(['2026-03-01T10:00:00Z', 'not-a-uuid']), forged(['2026-03-01T10:00:00Z'])]) {
      expect((await me.api.call('get', `/notifications?cursor=${encodeURIComponent(c)}`)).status, c).toBe(400);
    }
  });

  it('filters by kind and unread, and shows a snooze again once its date has passed', async () => {
    const me = await reader();
    const a = await notify(me.user.id, 'mention a', { kind: 'mention' });
    const b = await notify(me.user.id, 'read mention', { kind: 'mention', read: true });
    const c = await notify(me.user.id, 'asleep', { kind: 'system', snooze: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    const d = await notify(me.user.id, 'woke up', { kind: 'system', snooze: new Date(Date.now() - 60_000).toISOString() });
    expect(ids(await me.api.call('get', '/notifications?kind=mention')).sort()).toEqual([a, b].sort());
    expect(ids(await me.api.call('get', '/notifications?kind=mention&unread_only=true'))).toEqual([a]);
    const def = await me.api.call('get', '/notifications');
    expect(ids(def).sort()).toEqual([a, b, d].sort());
    expect(def.body.unread_count).toBe(2); // a and d; c is asleep
    expect(ids(await me.api.call('get', '/notifications?snoozed=only'))).toEqual([c]);
    expect(ids(await me.api.call('get', '/notifications?snoozed=include')).sort()).toEqual([a, b, c, d].sort());
  });
});

describe('X1 inbox: changes and their audit', () => {
  it('reads, un-reads and snoozes with one audit row each (before and after, the caller\'s address), and read-all counts only the unread', async () => {
    const me = await reader();
    const n1 = await notify(me.user.id, 'one');
    const n2 = await notify(me.user.id, 'two');
    await notify(me.user.id, 'three', { read: true });
    expect((await me.api.call('post', `/notifications/${n1}/read`)).body.read_at).toBeTruthy();
    // reading twice keeps the first read time
    const first = (await db.query('SELECT read_at FROM notifications WHERE id = $1', [n1])).rows[0].read_at as Date;
    await me.api.call('post', `/notifications/${n1}/read`);
    expect(((await db.query('SELECT read_at FROM notifications WHERE id = $1', [n1])).rows[0].read_at as Date).getTime()).toBe(first.getTime());
    expect((await me.api.call('post', `/notifications/${n1}/unread`)).body.read_at).toBeNull();
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const snz = await me.api.call('post', `/notifications/${n2}/snooze`, { until });
    expect(snz.status).toBe(200);
    expect(snz.body.read_at).toBeNull(); // snoozing does not mark it read
    expect(new Date(snz.body.snoozed_until).getTime()).toBe(new Date(until).getTime());

    const reads = await audits('notification_read', me.user.id);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ entity_id: n1 });
    expect(reads[0].before.read_at).toBeNull();
    expect(reads[0].after.read_at).toBeTruthy();
    expect((await audits('notification_unread', me.user.id))[0].before.read_at).toBeTruthy();
    const snoozes = await audits('notification_snooze', me.user.id);
    expect(snoozes).toHaveLength(1);
    expect(snoozes[0].before.snoozed_until).toBeNull();
    expect(snoozes[0].after.snoozed_until).toBeTruthy();
    expect(snoozes[0].ip).toBeTruthy();

    expect((await me.api.call('post', '/notifications/read-all')).status).toBe(204);
    expect((await audits('notification_read_all', me.user.id)).at(-1)?.after).toEqual({ count: 1 }); // n1 only: n2 is asleep, n3 was read
    expect((await me.api.call('post', '/notifications/read-all')).status).toBe(204);
    expect(await audits('notification_read_all', me.user.id)).toHaveLength(1); // nothing to do: nothing audited
  });

  it('snoozes until a plain date at the start of that day in Tripoli, and refuses the past, a year ahead, junk and extra keys', async () => {
    const me = await reader();
    const n = await notify(me.user.id, 'later');
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const res = await me.api.call('post', `/notifications/${n}/snooze`, { until: day });
    expect(res.status).toBe(200);
    const expected = await db.query(`SELECT (($1::date)::timestamp AT TIME ZONE 'Africa/Tripoli') AS t`, [day]);
    expect(new Date(res.body.snoozed_until).getTime()).toBe((expected.rows[0].t as Date).getTime());
    const bad: unknown[] = [
      { until: new Date(Date.now() - 1000).toISOString() },
      { until: new Date(Date.now() + 400 * 86_400_000).toISOString() },
      { until: '2020-01-01' },
      { until: 'tomorrow' },
      { until: 5 },
      {},
      { until: null, extra: 1 },
    ];
    for (const body of bad) {
      const r = await me.api.call('post', `/notifications/${n}/snooze`, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    // the failed attempts changed nothing; null clears it
    expect(new Date((await db.query('SELECT snoozed_until FROM notifications WHERE id = $1', [n])).rows[0].snoozed_until).getTime()).toBe(new Date(res.body.snoozed_until).getTime());
    expect((await me.api.call('post', `/notifications/${n}/snooze`, { until: null })).body.snoozed_until).toBeNull();
  });
});

describe('X1 inbox: the follower story end to end', () => {
  it('a follower whose role has no view right on Sites (though the scope fits) gets no followed_change notification; the inbox of the others points at the task', async () => {
    const e: Actor = await actor(app, db, { level: 'entry' });
    const approver = await reader();
    const s = await site();
    const full = await reader();
    const noView = await reader();
    const tid = await makeTask(db, s, 'A1', 'entry', { actualDate: '2026-01-05' });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'review', { user: [approver.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [approver.user.id] });
    await full.api.call('put', `/sites/${s.id}/follow`);
    await noView.api.call('put', `/sites/${s.id}/follow`);
    await dropGrant(noView.user.id, 'sites'); // the follow stays, the right is gone
    const v = (await e.api.call('get', `/tasks/${tid}`)).body.version;
    expect((await e.api.call('post', `/tasks/${tid}/submit`, {}, { 'If-Match': `"${v}"` })).status).toBe(200);
    const count = async (u: Actor) => (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'followed_change'`, [u.user.id])).rows[0].n;
    expect([await count(full), await count(noView)]).toEqual([1, 0]);
    const n = (await full.api.call('get', '/notifications?kind=followed_change')).body.items[0];
    expect(n).toMatchObject({ kind: 'followed_change', entity_type: 'task', entity_id: tid, link: `/tasks/${tid}` });
    // the one without the right has nothing in the inbox and cannot follow again
    expect((await noView.api.call('get', '/notifications')).body.items).toEqual([]);
    expect((await noView.api.call('put', `/sites/${s.id}/follow`)).status).toBe(403);
  });
});
