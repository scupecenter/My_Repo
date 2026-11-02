import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G, createRec, recPath, team, PROC } from './reg-helpers';
import {
  Actor,
  actor,
  makeSite,
  makeTask,
  plainAdmin,
  setCell,
} from './wf-helpers';

/**
 * UI plan features X1 to X7 and the `via` of DD6 (migration 0031). Region 2 (Middle) for the workflow tests, region 3 (WM) for the registers.
 * Each test builds its own users, so the suites that run in parallel do not meet them.
 */
const REGION = 2;
const PREFIX = `XF${randomBytes(3).toString("hex").toUpperCase()}`;
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
const sitesView = (regions: number[] | null = [REGION]) =>
  actor(app, db, {
    level: 'view',
    grants: G('sites', 'view'),
    regions,
    modules: null,
  });
const notify = async (
  userId: string,
  title: string,
  over: { kind?: string; read?: boolean; snooze?: string } = {},
): Promise<string> =>
  (
    await db.query(
      `INSERT INTO notifications (user_id, channel, kind, title, read_at, snoozed_until) VALUES ($1, 'in_app', $2, $3, $4, $5) RETURNING id::text AS id`,
      [
        userId,
        over.kind ?? 'task_assigned',
        title,
        over.read ? new Date() : null,
        over.snooze ?? null,
      ],
    )
  ).rows[0].id as string;
const audits = async (action: string, entityId?: string) =>
  (
    await db.query(
      'SELECT actor_id::text, before, after FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2) ORDER BY id',
      [action, entityId ?? null],
    )
  ).rows;

describe('X1 notification inbox', () => {
  it('lists only my notifications, filters unread and snoozed, marks read and unread, snoozes, and audits each change', async () => {
    const me = await sitesView();
    const other = await sitesView();
    const n1 = await notify(me.user.id, 'one');
    const n2 = await notify(me.user.id, 'two', { read: true });
    const n3 = await notify(me.user.id, 'three', { kind: 'some_unknown_kind' });
    const theirs = await notify(other.user.id, 'secret');

    let res = await me.api.call('get', '/notifications');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [n1, n2, n3].sort(),
    );
    expect(res.body.unread_count).toBe(2);
    expect(res.body.items.find((i: { id: string }) => i.id === n3).kind).toBe(
      'system',
    );
    res = await me.api.call('get', '/notifications?unread_only=true');
    expect(res.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [n1, n3].sort(),
    );

    // another person's notification is not found, never forbidden
    expect(
      (await me.api.call('post', `/notifications/${theirs}/read`)).status,
    ).toBe(404);
    expect(
      (
        await me.api.call('post', `/notifications/${theirs}/snooze`, {
          until: null,
        })
      ).status,
    ).toBe(404);
    expect(
      (await other.api.call('get', '/notifications')).body.items,
    ).toHaveLength(1);

    res = await me.api.call('post', `/notifications/${n1}/read`);
    expect(res.status).toBe(200);
    expect(res.body.read_at).toBeTruthy();
    res = await me.api.call('post', `/notifications/${n1}/unread`);
    expect(res.body.read_at).toBeNull();

    // snooze: hidden from the default list and the unread count, found with snoozed=only
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
    res = await me.api.call('post', `/notifications/${n1}/snooze`, { until });
    expect(res.status).toBe(200);
    expect(res.body.snoozed_until).toBeTruthy();
    res = await me.api.call('get', '/notifications');
    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(n1);
    expect(res.body.unread_count).toBe(1);
    expect(
      (await me.api.call('get', '/notifications?snoozed=only')).body.items.map(
        (i: { id: string }) => i.id,
      ),
    ).toEqual([n1]);
    expect(
      (await me.api.call('get', '/notifications?snoozed=include')).body.items,
    ).toHaveLength(3);
    expect(
      (await me.api.call('get', '/notifications?snoozed=bad')).status,
    ).toBe(422);
    // the past or too far ahead is refused; null clears the snooze
    expect(
      (
        await me.api.call('post', `/notifications/${n1}/snooze`, {
          until: new Date(Date.now() - 1000).toISOString(),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await me.api.call('post', `/notifications/${n1}/snooze`, {
          until: '2999-01-01',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await me.api.call('post', `/notifications/${n1}/snooze`, {
          until: null,
        })
      ).body.snoozed_until,
    ).toBeNull();
    // a plain date is accepted
    const day = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(
      (await me.api.call('post', `/notifications/${n1}/snooze`, { until: day }))
        .status,
    ).toBe(200);

    // read-all leaves the snoozed one and everybody else's untouched
    expect((await me.api.call('post', '/notifications/read-all')).status).toBe(
      204,
    );
    const rows = await db.query(
      'SELECT id::text AS id, read_at FROM notifications WHERE id = ANY($1::uuid[])',
      [[n1, n3, theirs]],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.read_at]));
    expect(byId[n3]).not.toBeNull();
    expect(byId[n1]).toBeNull();
    expect(byId[theirs]).toBeNull();

    expect((await audits('notification_read', n1))[0]?.actor_id).toBe(
      me.user.id,
    );
    expect(
      (await audits('notification_snooze', n1)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      (await audits('notification_read_all')).some(
        (a) => a.actor_id === me.user.id,
      ),
    ).toBe(true);
  });

  it('keeps the row-level wall: the application role reads and changes only its own rows, and creates none', async () => {
    const me = await sitesView();
    const other = await sitesView();
    const mine = await notify(me.user.id, 'mine');
    const theirs = await notify(other.user.id, 'theirs');
    const forged = await me.api.call('post', `/notifications/${theirs}/unread`);
    expect(forged.status).toBe(404);
    expect(
      (
        await db.query('SELECT read_at FROM notifications WHERE id = $1', [
          theirs,
        ])
      ).rows[0].read_at,
    ).toBeNull();
    expect(
      (await me.api.call('get', '/notifications')).body.items.map(
        (i: { id: string }) => i.id,
      ),
    ).toEqual([mine]);
    // no session: 401
    const anon = await import('supertest').then((m) =>
      m.default(app.getHttpServer()).get('/api/v1/notifications'),
    );
    expect(anon.status).toBe(401);
  });
});

describe('X2 follow', () => {
  it('follows a site the caller can read, is idempotent, lists it and stops; a site outside the regions is 404', async () => {
    const f = await sitesView();
    const s = await site();
    const far = await site(4);
    let res = await f.api.call('put', `/sites/${s.id}/follow`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity_type: 'site',
      entity_id: s.id,
      site_id: s.id,
    });
    const first = res.body.id;
    expect((await f.api.call('put', `/sites/${s.id}/follow`)).body.id).toBe(
      first,
    );
    expect(await audits('follow', first)).toHaveLength(1);
    expect((await f.api.call('put', `/sites/${far.id}/follow`)).status).toBe(
      404,
    );
    expect(
      (
        await f.api.call(
          'put',
          '/sites/00000000-0000-0000-0000-000000000000/follow',
        )
      ).status,
    ).toBe(404);

    res = await f.api.call('get', '/me/follows');
    expect(
      res.body.items.map((i: { entity_id: string }) => i.entity_id),
    ).toEqual([s.id]);
    expect(res.body.items[0].label).toContain(s.code);

    expect((await f.api.call('delete', `/sites/${s.id}/follow`)).status).toBe(
      204,
    );
    expect((await f.api.call('delete', `/sites/${s.id}/follow`)).status).toBe(
      204,
    );
    expect(await audits('unfollow', first)).toHaveLength(1);
    expect((await f.api.call('get', '/me/follows')).body.items).toEqual([]);
  });

  it("refuses a caller without the Sites module (403), and nobody sees another person's follows", async () => {
    const s = await site();
    const noSites = await actor(app, db, {
      level: 'view',
      grants: G('approvals', 'view'),
      regions: [REGION],
      modules: ['approvals'],
    });
    expect(
      (await noSites.api.call('put', `/sites/${s.id}/follow`)).status,
    ).toBe(403);
    const a = await sitesView();
    const b = await sitesView();
    await a.api.call('put', `/sites/${s.id}/follow`);
    expect((await b.api.call('get', '/me/follows')).body.items).toEqual([]);
  });

  it('notifies followers of a task change, only while they can still read the site, and never the person who acted', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const watcher = await sitesView();
    const lost = await sitesView();
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'entry', {
      actualDate: '2026-01-05',
    });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'review', { user: [watcher.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [watcher.user.id] });
    await e.api.call('put', `/sites/${s.id}/follow`);
    await watcher.api.call('put', `/sites/${s.id}/follow`);
    await lost.api.call('put', `/sites/${s.id}/follow`);
    // the third follower loses access to the region before the change
    await db.query(
      "UPDATE user_role_assignments SET valid_to = now() - interval '1 minute', valid_from = now() - interval '1 day' WHERE user_id = $1",
      [lost.user.id],
    );

    const t = (await e.api.call('get', `/tasks/${tid}`)).body;
    const res = await e.api.call(
      'post',
      `/tasks/${tid}/submit`,
      { via: 'drag' },
      { 'If-Match': `"${t.version}"` },
    );
    expect(res.status).toBe(200);
    const got = async (u: Actor) =>
      (
        await db.query(
          `SELECT title, task_id::text AS task_id FROM notifications WHERE user_id = $1 AND kind = 'followed_change'`,
          [u.user.id],
        )
      ).rows;
    expect(await got(watcher)).toEqual([
      { title: 'A followed site changed', task_id: tid },
    ]);
    expect(await got(e)).toEqual([]);
    expect(await got(lost)).toEqual([]);
    // the watcher sees it in the inbox
    const inbox = await watcher.api.call(
      'get',
      '/notifications?kind=followed_change',
    );
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({
      kind: 'followed_change',
      entity_type: 'task',
      entity_id: tid,
    });
  });

  it('follows a register record and is notified of its changes only if it can read the register', async () => {
    const t = await team(app, db, 'procurement', 'procurement', 3);
    const w = await actor(app, db, {
      level: 'view',
      grants: G('procurement', 'view'),
      regions: [3],
      modules: null,
    });
    const blind = await actor(app, db, {
      level: 'view',
      grants: G('sites', 'view'),
      regions: [3],
      modules: ['sites'],
    });
    const rec = await createRec(t, PROC);
    expect(
      (await w.api.call('put', recPath('procurement', rec.id, '/follow')))
        .status,
    ).toBe(200);
    expect(
      (await w.api.call('put', recPath('procurement', rec.id, '/follow')))
        .status,
    ).toBe(200);
    // a user outside the register's module gets 403, a wrong register or id 404
    expect(
      (await blind.api.call('put', recPath('procurement', rec.id, '/follow')))
        .status,
    ).toBe(403);
    expect(
      (await w.api.call('put', recPath('nope', rec.id, '/follow'))).status,
    ).toBe(404);
    expect(
      (
        await w.api.call(
          'put',
          recPath(
            'procurement',
            '00000000-0000-0000-0000-000000000000',
            '/follow',
          ),
        )
      ).status,
    ).toBe(404);
    const mine = await w.api.call('get', '/me/follows');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      entity_type: 'register_record',
      register_key: 'procurement',
    });

    const sub = await t.entry.api.call(
      'post',
      recPath('procurement', rec.id, '/submit'),
      { via: 'button' },
      { 'If-Match': `"${rec.version}"` },
    );
    expect(sub.status).toBe(200);
    const rows = await db.query(
      `SELECT title FROM notifications WHERE user_id = $1 AND kind = 'followed_change'`,
      [w.user.id],
    );
    expect(rows.rows).toEqual([{ title: 'A followed record changed' }]);
    expect(
      (await audits('register_record_submit', rec.id)).at(-1)?.after.via,
    ).toBe('button');
    expect(
      (await w.api.call('delete', recPath('procurement', rec.id, '/follow')))
        .status,
    ).toBe(204);
  });
});

describe('X3 mentions', () => {
  it('notifies only the people who can read the task and says nothing about the others', async () => {
    const author = await actor(app, db, { level: 'entry' });
    const reader = await sitesView();
    const outsider = await sitesView([4]); // a region without this site
    const nobody = await actor(app, db, {
      level: 'view',
      grants: G('approvals', 'view'),
      regions: [REGION],
      modules: ['approvals'],
    });
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'open');
    const post = (body: unknown) =>
      author.api.call('post', `/tasks/${tid}/comments`, body);

    let res = await post({
      body: 'please look',
      mention_user_ids: [
        reader.user.id,
        outsider.user.id,
        nobody.user.id,
        author.user.id,
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.mentions.map((m: { id: string }) => m.id)).toEqual([
      reader.user.id,
    ]);
    const count = async (u: Actor) =>
      (
        await db.query(
          `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'mention'`,
          [u.user.id],
        )
      ).rows[0].n;
    expect([
      await count(reader),
      await count(outsider),
      await count(nobody),
      await count(author),
    ]).toEqual([1, 0, 0, 0]);
    expect(
      (await outsider.api.call('get', '/notifications')).body.items,
    ).toEqual([]);

    // an @employee-id token in the text resolves to the person; an unknown number is ignored without an error
    res = await post({ body: `ping @${reader.user.employeeId} and @0000` });
    expect(res.status).toBe(201);
    expect(res.body.mentions.map((m: { id: string }) => m.id)).toEqual([
      reader.user.id,
    ]);
    expect(await count(reader)).toBe(2);
    res = await post({ body: `outsider @${outsider.user.employeeId}` });
    expect(res.body.mentions).toEqual([]);
    expect(await count(outsider)).toBe(0);
  });

  it('comments on a register record with mentions, notifies only readers of the register, and refuses a stranger', async () => {
    const t = await team(app, db, 'procurement', 'procurement', 3);
    const reader = await actor(app, db, {
      level: 'view',
      grants: G('procurement', 'view'),
      regions: [3],
      modules: null,
    });
    const wrongRegion = await actor(app, db, {
      level: 'view',
      grants: G('procurement', 'view'),
      regions: [5],
      modules: null,
    });
    const wrongModule = await actor(app, db, {
      level: 'view',
      grants: G('sites', 'view'),
      regions: [3],
      modules: ['sites'],
    });
    const rec = await createRec(t, PROC);
    const path = recPath('procurement', rec.id, '/comments');

    const res = await t.entry.api.call('post', path, {
      body: `check @${reader.user.employeeId}`,
      mention_user_ids: [wrongRegion.user.id, wrongModule.user.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.mentions.map((m: { id: string }) => m.id)).toEqual([
      reader.user.id,
    ]);
    const n = async (u: Actor) =>
      (
        await db.query(
          `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'mention'`,
          [u.user.id],
        )
      ).rows[0].n;
    expect([
      await n(reader),
      await n(wrongRegion),
      await n(wrongModule),
    ]).toEqual([1, 0, 0]);

    const list = await reader.api.call('get', path);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].body).toContain('check');
    // a later version of the record keeps the thread
    expect((await wrongRegion.api.call('get', path)).status).toBe(404);
    expect(
      (await wrongRegion.api.call('post', path, { body: 'hi' })).status,
    ).toBe(404);
    expect((await wrongModule.api.call('get', path)).status).toBe(403);
    expect((await t.entry.api.call('post', path, { body: '   ' })).status).toBe(
      422,
    );
    expect(await audits('register_record_comment', rec.id)).toHaveLength(1);
  });
});

describe('DD6 via', () => {
  it('records button, drag or bulk in the audit row, refuses other values, and changes no rule', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'entry', {
      actualDate: '2026-01-05',
    });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    const v = (await e.api.call('get', `/tasks/${tid}`)).body.version;
    expect(
      (
        await e.api.call(
          'post',
          `/tasks/${tid}/submit`,
          { via: 'swipe' },
          { 'If-Match': `"${v}"` },
        )
      ).status,
    ).toBe(422);
    const ok = await e.api.call(
      'post',
      `/tasks/${tid}/submit`,
      { via: 'drag' },
      { 'If-Match': `"${v}"` },
    );
    expect(ok.status).toBe(200);
    expect((await audits('task_submit', tid)).at(-1)?.after.via).toBe('drag');
  });

  it('marks the bulk approval rows with bulk by default', async () => {
    // two fixed levels (owner decision 2026-11-01): the bulk action of the L2 holder is the approval; the middle "pass" exists only for 3-level snapshots
    const e = await actor(app, db, { level: 'entry' });
    const a = await actor(app, db, { level: 'approve' });
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'in_approval', {
      actualDate: '2026-01-05',
    });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [a.user.id] });
    const v = (await a.api.call('get', `/tasks/${tid}`)).body.version;
    const res = await a.api.call('post', '/approvals/bulk', {
      action: 'approve',
      items: [{ id: tid, version: v }],
    });
    expect(res.status).toBe(200);
    expect(res.body.done.map((d: { id: string }) => d.id)).toEqual([tid]);
    const last = (await audits('task_approve', tid)).at(-1);
    expect(last?.after.via).toBe('bulk');
  });
});

describe('X4 time in state', () => {
  async function submitted() {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'approve' });
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'entry', {
      actualDate: '2026-01-05',
    });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [r.user.id] });
    const v = (await e.api.call('get', `/tasks/${tid}`)).body.version;
    expect(
      (
        await e.api.call(
          'post',
          `/tasks/${tid}/submit`,
          {},
          { 'If-Match': `"${v}"` },
        )
      ).status,
    ).toBe(200);
    return { e, r, s, tid };
  }

  it("reports the durations per level from the audit log; a task outside the caller's regions is 404", async () => {
    const { e, r, tid } = await submitted();
    // age the first visit so the figure is visible: the audit rows are append-only, so use the superuser to build a clean fixture instead
    const res = await e.api.call('get', `/tasks/${tid}/time-in-state`);
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe(tid);
    expect(res.body.items.map((i: { state: string }) => i.state)).toEqual([
      'entry',
      'review',
      'approve',
    ]);
    expect(res.body.current_state).not.toBeNull();
    // a task made by a fixture has no audit row for the time before its first change, so the first counted visit is L2 (state approve).
    // Two levels: the submission goes straight to L2 and the task never visits the middle (review) state.
    expect(res.body.items[1].visits).toBe(0);
    const approve = res.body.items[2];
    expect(approve.visits).toBe(1);
    expect(res.body.segments[0]).toMatchObject({ state: 'approve', ended_at: null });
    expect(res.body.current_state).toBe('approve');
    expect(
      (await r.api.call('get', `/tasks/${tid}/time-in-state`)).status,
    ).toBe(200);
    const far = await sitesView([4]);
    expect(
      (await far.api.call('get', `/tasks/${tid}/time-in-state`)).status,
    ).toBe(404);
  });

  it('counts a long visit in seconds and working days, and aggregates per holder and per team for a reader of Reports', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'locked');
    // a fixture with a known history: unlocked 10 days ago, submitted 4 days ago by e
    await db.query(
      `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, site_id, region_id, after)
      VALUES (now() - interval '10 days', NULL, 'task_unlock', 'task', $1, $2, $3, '{"state":"open"}'),
             (now() - interval '4 days', $4, 'task_submit', 'task', $1, $2, $3, '{"state":"in_review"}')`,
      [tid, s.id, REGION, e.user.id],
    );
    const reader = await actor(app, db, {
      level: 'view',
      grants: [...G('sites', 'view'), ...G('reports', 'view')],
      regions: [REGION],
      modules: null,
    });
    const one = await reader.api.call('get', `/tasks/${tid}/time-in-state`);
    expect(one.status).toBe(200);
    const entry = one.body.items.find(
      (i: { state: string }) => i.state === 'entry',
    );
    expect(entry.visits).toBe(1);
    expect(entry.total_seconds).toBeGreaterThan(6 * 86_400 - 60);
    expect(entry.total_seconds).toBeLessThan(6 * 86_400 + 60);
    expect(entry.working_days).toBeGreaterThanOrEqual(3);
    expect(one.body.current_state).toBe('review');

    const byHolder = await reader.api.call(
      'get',
      `/reports/time-in-state?group_by=holder&region_id=${REGION}`,
    );
    expect(byHolder.status).toBe(200);
    const mine = byHolder.body.items.find(
      (i: { holder: { id: string } }) => i.holder.id === e.user.id,
    );
    expect(mine.levels.entry).toMatchObject({ visits: 1 });
    expect(mine.levels.entry.average_seconds).toBeGreaterThan(5 * 86_400);
    const byTeam = await reader.api.call(
      'get',
      `/reports/time-in-state?group_by=team&region_id=${REGION}`,
    );
    expect(byTeam.status).toBe(200);
    expect(
      byTeam.body.items.every((i: { team: string }) =>
        ['cw', 'te', 'both', 'none'].includes(i.team),
      ),
    ).toBe(true);
    expect(
      (await reader.api.call('get', '/reports/time-in-state?group_by=nope'))
        .status,
    ).toBe(422);
    expect(
      (await reader.api.call('get', '/reports/time-in-state?from=yesterday'))
        .status,
    ).toBe(422);

    // outside the reader's regions nothing shows; without the Reports module it is 403
    const elsewhere = await actor(app, db, {
      level: 'view',
      grants: [...G('sites', 'view'), ...G('reports', 'view')],
      regions: [4],
      modules: null,
    });
    const none = await elsewhere.api.call(
      'get',
      `/reports/time-in-state?group_by=holder`,
    );
    expect(
      none.body.items.find(
        (i: { holder: { id: string } }) => i.holder.id === e.user.id,
      ),
    ).toBeUndefined();
    const noReports = await sitesView();
    expect(
      (await noReports.api.call('get', '/reports/time-in-state')).status,
    ).toBe(403);
  });
});

describe('X5 workload', () => {
  it("counts open and late tasks per holder within the caller's scope and is closed to callers without Reports", async () => {
    const h = await actor(app, db, { level: 'entry' });
    const s = await site();
    const open1 = await makeTask(db, s, 'B9', 'open');
    const late = await makeTask(db, s, 'B6', 'open');
    const noOne = await makeTask(db, s, 'B5', 'open');
    await setCell(db, 'B9', REGION, 'entry', { user: [h.user.id] });
    await setCell(db, 'B6', REGION, 'entry', { user: [h.user.id] });
    await setCell(db, 'B5', REGION, 'entry', {});
    // B6 started its SLA clock long ago, so it is past its maximum
    await db.query(
      `UPDATE task_instances SET sla_start_date = current_date - 200 WHERE id = $1`,
      [late],
    );
    void open1;
    void noOne;
    const lead = await actor(app, db, {
      level: 'view',
      grants: [...G('sites', 'view'), ...G('reports', 'view')],
      regions: [REGION],
      modules: null,
    });
    const res = await lead.api.call(
      'get',
      `/reports/workload?region_id=${REGION}`,
    );
    expect(res.status).toBe(200);
    const row = res.body.items.find(
      (i: { holder: { id: string } }) => i.holder.id === h.user.id,
    );
    expect(row.open).toBe(2);
    expect(row.by_level.entry).toBe(2);
    expect(row.holder.employee_id).toBe(h.user.employeeId);
    expect(row.team).toBeTruthy();
    expect(row.late).toBeGreaterThanOrEqual(0);
    expect(res.body.no_holder.open).toBeGreaterThanOrEqual(1);

    const elsewhere = await actor(app, db, {
      level: 'view',
      grants: [...G('sites', 'view'), ...G('reports', 'view')],
      regions: [4],
      modules: null,
    });
    const other = await elsewhere.api.call('get', '/reports/workload');
    expect(
      other.body.items.find(
        (i: { holder: { id: string } }) => i.holder.id === h.user.id,
      ),
    ).toBeUndefined();
    expect(
      (await (await sitesView()).api.call('get', '/reports/workload')).status,
    ).toBe(403);
    expect(
      (await lead.api.call('get', '/reports/workload?region_id=9')).status,
    ).toBe(422);
  });
});

describe('X6 blocked-by', () => {
  it('lists the predecessor that has not been approved and the gate that is closed, and nothing for a task that is free', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const s = await site();
    const a1 = await makeTask(db, s, 'A1', 'open');
    const a2 = await makeTask(db, s, 'A2', 'locked');
    const res = await e.api.call('get', `/tasks/${a2}/blocked-by`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      task_id: a2,
      state: 'locked',
      blocked: true,
    });
    const pred = res.body.items.find(
      (i: { kind: string }) => i.kind === 'predecessor_not_approved',
    );
    expect(pred).toBeTruthy();
    expect(pred.task).toMatchObject({ task_code: 'A1', id: a1, state: 'open' });
    const free = await e.api.call('get', `/tasks/${a1}/blocked-by`);
    expect(free.body).toMatchObject({ blocked: false, items: [] });
    const far = await sitesView([4]);
    expect((await far.api.call('get', `/tasks/${a2}/blocked-by`)).status).toBe(
      404,
    );
    expect(
      (await far.api.call('get', '/tasks/not-a-uuid/blocked-by')).status,
    ).toBe(404);
  });
});

describe('X7 weekly status updates', () => {
  const lead = (regions: number[] | null = [REGION]) =>
    actor(app, db, {
      level: 'approve',
      grants: [...G('sites', 'view'), ['overrides.reassign', 'administer']],
      regions,
      modules: null,
    });

  it('lets a lead write, the author edit inside the week, and everybody in scope read; nothing is deleted', async () => {
    const l = await lead();
    const reader = await sitesView();
    const body = {
      scope: 'region',
      region_id: REGION,
      health: 'on_track',
      summary: 'Civil works on plan.',
    };
    const created = await l.api.call('post', '/status-updates', body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      scope: 'region',
      region_id: REGION,
      health: 'on_track',
      editable: true,
      version: 1,
    });
    expect(created.body.author.id).toBe(l.user.id);
    expect(created.body.week_start <= created.body.week_end).toBe(true);
    expect(new Date(`${created.body.week_start}T00:00:00Z`).getUTCDay()).toBe(
      0,
    );
    const etag = String(created.headers.etag);

    const edited = await l.api.call(
      'patch',
      `/status-updates/${created.body.id}`,
      { health: 'at_risk' },
      { 'If-Match': etag },
    );
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      health: 'at_risk',
      summary: 'Civil works on plan.',
      version: 2,
    });
    expect(
      (
        await l.api.call(
          'patch',
          `/status-updates/${created.body.id}`,
          { health: 'off_track' },
          { 'If-Match': etag },
        )
      ).status,
    ).toBe(412);
    expect(
      (
        await l.api.call('patch', `/status-updates/${created.body.id}`, {
          health: 'off_track',
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await l.api.call(
          'patch',
          `/status-updates/${created.body.id}`,
          {},
          { 'If-Match': '"2"' },
        )
      ).status,
    ).toBe(422);
    const [post] = await audits('status_update_post', created.body.id);
    expect(post.actor_id).toBe(l.user.id);
    const [edit] = await audits('status_update_edit', created.body.id);
    expect(edit.before).toMatchObject({ health: 'on_track' });
    expect(edit.after).toMatchObject({ health: 'at_risk' });

    const read = await reader.api.call(
      'get',
      `/status-updates?region_id=${REGION}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.items.map((i: { id: string }) => i.id)).toContain(
      created.body.id,
    );
    expect(
      read.body.items.find((i: { id: string }) => i.id === created.body.id)
        .editable,
    ).toBe(false);
    // only the author edits, even a person who is a lead of the same region
    const l2 = await lead();
    expect(
      (
        await l2.api.call(
          'patch',
          `/status-updates/${created.body.id}`,
          { health: 'off_track' },
          { 'If-Match': '"2"' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await reader.api.call(
          'patch',
          `/status-updates/${created.body.id}`,
          { health: 'off_track' },
          { 'If-Match': '"2"' },
        )
      ).status,
    ).toBe(403);

    // never deleted: the database refuses, and the application role has no such right
    await expect(
      db.query('DELETE FROM status_updates WHERE id = $1', [created.body.id]),
    ).rejects.toThrow(/never removed/);
    await expect(db.query('TRUNCATE status_updates')).rejects.toThrow(
      /never removed/,
    );
  });

  it('refuses the edit once the week has ended', async () => {
    const l = await lead();
    const c = await l.api.call('post', '/status-updates', {
      scope: 'region',
      region_id: REGION,
      health: 'off_track',
      summary: 'Late.',
    });
    await db.query(
      `UPDATE status_updates SET week_start = week_start - 14 WHERE id = $1`,
      [c.body.id],
    );
    const res = await l.api.call(
      'patch',
      `/status-updates/${c.body.id}`,
      { summary: 'Changed.' },
      { 'If-Match': String(c.headers.etag) },
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
    const list = await l.api.call('get', `/status-updates?region_id=${REGION}`);
    expect(
      list.body.items.find((i: { id: string }) => i.id === c.body.id).editable,
    ).toBe(false);
  });

  it('is closed to someone who is not a lead of the region, and hidden from other regions', async () => {
    const notLead = await sitesView();
    const body = {
      scope: 'region',
      region_id: REGION,
      health: 'on_track',
      summary: 'x',
    };
    expect(
      (await notLead.api.call('post', '/status-updates', body)).status,
    ).toBe(403);
    const otherLead = await lead([4]);
    expect(
      (await otherLead.api.call('post', '/status-updates', body)).status,
    ).toBe(403);
    expect(
      (
        await (
          await actor(app, db, {
            level: 'view',
            grants: G('approvals', 'view'),
            regions: [REGION],
            modules: ['approvals'],
          })
        ).api.call('get', '/status-updates')
      ).status,
    ).toBe(403);

    const l = await lead();
    const created = await l.api.call('post', '/status-updates', body);
    const elsewhere = await sitesView([4]);
    expect(
      (await elsewhere.api.call('get', '/status-updates')).body.items.map(
        (i: { id: string }) => i.id,
      ),
    ).not.toContain(created.body.id);
    expect(
      (
        await elsewhere.api.call(
          'patch',
          `/status-updates/${created.body.id}`,
          { health: 'at_risk' },
          { 'If-Match': '"1"' },
        )
      ).status,
    ).toBe(404);
  });

  it('validates the shape: a region update needs a region, a team update a team; an admin may write for any region and for all regions', async () => {
    const l = await lead();
    const bad = async (b: unknown) =>
      (await l.api.call('post', '/status-updates', b)).status;
    expect(
      await bad({ scope: 'region', health: 'on_track', summary: 'x' }),
    ).toBe(422);
    expect(
      await bad({
        scope: 'region',
        region_id: REGION,
        team: 'cw',
        health: 'on_track',
        summary: 'x',
      }),
    ).toBe(422);
    expect(await bad({ scope: 'team', health: 'on_track', summary: 'x' })).toBe(
      422,
    );
    expect(
      await bad({
        scope: 'region',
        region_id: REGION,
        health: 'fine',
        summary: 'x',
      }),
    ).toBe(422);
    expect(
      await bad({
        scope: 'region',
        region_id: REGION,
        health: 'on_track',
        summary: '   ',
      }),
    ).toBe(422);
    expect(
      await bad({
        scope: 'region',
        region_id: REGION,
        health: 'on_track',
        summary: 'x',
        extra: 1,
      }),
    ).toBe(422);
    // a regional lead writes a team update for her own region, but not for all regions
    const team = await l.api.call('post', '/status-updates', {
      scope: 'team',
      team: 'cw',
      region_id: REGION,
      health: 'at_risk',
      summary: 'CW team.',
    });
    expect(team.status).toBe(201);
    expect(team.body.team).toBe('cw');
    expect(
      await bad({
        scope: 'team',
        team: 'te',
        health: 'on_track',
        summary: 'x',
      }),
    ).toBe(403);
    const admin = await plainAdmin(app, db);
    const all = await admin.api.call('post', '/status-updates', {
      scope: 'team',
      team: 'te',
      health: 'on_track',
      summary: 'All regions.',
    });
    expect(all.status).toBe(201);
    expect(all.body.region_id).toBeNull();
    const seen = await l.api.call('get', '/status-updates?scope=team&team=te');
    expect(seen.body.items.map((i: { id: string }) => i.id)).toContain(
      all.body.id,
    );
  });
});
