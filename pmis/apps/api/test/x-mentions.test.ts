import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, delegate, startApp, superDb } from './helpers';
import { G, PROC, approveAll, createRec, post, recPath, team } from './reg-helpers';
import { Actor, actor, makeSite, makeTask } from './wf-helpers';

/**
 * X3, @mentions in comments on tasks and on register records (migration 0031, rule unified in 0036): a mention reaches only a person who can read the item
 * now (active account, the module, the region, the `view` right in the grid, through an assignment or a delegation). Everyone else is dropped silently.
 * Region 5 (Benghazi) for tasks and for the Procurement register. Nothing depends on the weekday or the database collation.
 */
const REGION = 5;
const PREFIX = `XM${randomBytes(3).toString('hex').toUpperCase()}`;
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

const taskReader = (regions: number[] | null = [REGION]) => actor(app, db, { level: 'view', grants: G('sites', 'view'), regions, modules: null });
const author = () => actor(app, db, { level: 'entry', grants: [...G('sites', 'view', 'edit')], regions: [REGION], modules: null });
const mentionCount = async (u: Actor): Promise<number> =>
  (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'mention'`, [u.user.id])).rows[0].n;
const stored = async (commentId: string): Promise<string[]> => (await db.query('SELECT user_id::text AS u FROM comment_mentions WHERE comment_id = $1', [commentId])).rows.map((r) => r.u).sort();
const auditMentions = async (action: string, entityId: string): Promise<string[][]> =>
  (await db.query('SELECT after FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, entityId])).rows.map((r) => [...r.after.mentions].sort());
const counts = async (list: Actor[]): Promise<number[]> => {
  const out: number[] = [];
  for (const u of list) out.push(await mentionCount(u));
  return out;
};
const mentioned = (res: { body: { mentions: { id: string }[] } }): string[] => res.body.mentions.map((m) => m.id).sort();

describe('X3 mentions on a task', () => {
  it('mentions exactly the people who can read the task, through assignments and delegations, and nobody else', async () => {
    const s = await makeSite(db, REGION, { prefix: PREFIX });
    const tid = await makeTask(db, s, 'A1', 'open');
    const a = await author();
    const inScope = await taskReader();
    const viaDelegation = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: ['approvals'] });
    await delegate(db, viaDelegation.user.id, G('sites', 'view'), [REGION]);
    const delegatedElsewhere = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: ['approvals'] });
    await delegate(db, delegatedElsewhere.user.id, G('sites', 'view'), [1]);
    const otherRegion = await taskReader([1]);
    const noGrant = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: null }); // the scope fits, the role has no view on Sites
    const wrongModules = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: ['approvals'] }); // the assignment excludes Sites
    const expired = await taskReader();
    await db.query(`UPDATE user_role_assignments SET valid_from = now() - interval '2 days', valid_to = now() - interval '1 day' WHERE user_id = $1`, [expired.user.id]);
    const suspended = await taskReader();
    await db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.user.id]);
    const who = [inScope, viaDelegation, delegatedElsewhere, otherRegion, noGrant, wrongModules, expired, suspended, a];

    const res = await a.api.call('post', `/tasks/${tid}/comments`, { body: 'please look', mention_user_ids: who.map((u) => u.user.id) });
    expect(res.status).toBe(201);
    expect(mentioned(res)).toEqual([inScope.user.id, viaDelegation.user.id].sort());
    expect(await stored(res.body.id)).toEqual([inScope.user.id, viaDelegation.user.id].sort());
    expect(await counts(who)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0]);
    // the notification carries the task and the comment text, and only the readers got it
    const n = (await inScope.api.call('get', '/notifications?kind=mention')).body.items[0];
    expect(n).toMatchObject({ kind: 'mention', entity_type: 'task', entity_id: tid, link: `/tasks/${tid}` });
    expect(n.body).toContain('please look');
    for (const u of [delegatedElsewhere, otherRegion, noGrant, wrongModules]) {
      expect(JSON.stringify((await u.api.call('get', '/notifications')).body.items)).not.toContain('please look');
    }
    // the audit row names the people who were mentioned, not everyone who was asked for
    const rows = await auditMentions('task_comment', tid);
    expect(rows.at(-1)).toEqual([inScope.user.id, viaDelegation.user.id].sort());
  });

  it('a duplicate in the list makes one notification, and an @employee-id token resolves like an id (and never for a stranger)', async () => {
    const s = await makeSite(db, REGION, { prefix: PREFIX });
    const tid = await makeTask(db, s, 'A1', 'open');
    const a = await author();
    const r = await taskReader();
    const outsider = await taskReader([2]);
    const res = await a.api.call('post', `/tasks/${tid}/comments`, { body: 'x', mention_user_ids: [r.user.id, r.user.id, r.user.id] });
    expect(mentioned(res)).toEqual([r.user.id]);
    expect(await mentionCount(r)).toBe(1);

    const token = (body: string) => a.api.call('post', `/tasks/${tid}/comments`, { body });
    expect(mentioned(await token(`hello @${r.user.employeeId}`))).toEqual([r.user.id]);
    expect(mentioned(await token(`(@${r.user.employeeId}) please`))).toEqual([r.user.id]);
    // not a token: an e-mail, five digits, no space before, a person who is outside the region, an unknown number
    expect(mentioned(await token(`mail a@${r.user.employeeId}`))).toEqual([]);
    expect(mentioned(await token(`@${r.user.employeeId}9`))).toEqual([]);
    expect(mentioned(await token(`@${outsider.user.employeeId}`))).toEqual([]);
    expect(mentioned(await token('@0000 @abcd'))).toEqual([]);
    expect(await mentionCount(r)).toBe(3);
    expect(await mentionCount(outsider)).toBe(0);
    // the answer for a stranger is the answer for an unknown number
    const x = await token(`@${outsider.user.employeeId}`);
    const y = await token('@0000');
    expect({ ...x.body, id: 0, created_at: 0, body: '' }).toEqual({ ...y.body, id: 0, created_at: 0, body: '' });
  });

  it('refuses a caller who cannot read the task (403 without the module, 404 in another region) and a malformed comment (422)', async () => {
    const s = await makeSite(db, REGION, { prefix: PREFIX });
    const tid = await makeTask(db, s, 'A1', 'open');
    const a = await author();
    const noModule = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: ['approvals'] });
    const far = await taskReader([1]);
    expect((await noModule.api.call('post', `/tasks/${tid}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await noModule.api.call('get', `/tasks/${tid}/comments`)).status).toBe(403);
    expect((await far.api.call('post', `/tasks/${tid}/comments`, { body: 'hi' })).status).toBe(404);
    expect((await far.api.call('get', `/tasks/${tid}/comments`)).status).toBe(404);
    expect((await request(app.getHttpServer()).post(`${API}/tasks/${tid}/comments`).send({ body: 'hi' })).status).toBe(401);
    expect((await db.query('SELECT count(*)::int AS n FROM comments WHERE task_id = $1', [tid])).rows[0].n).toBe(0);
    const bad: unknown[] = [
      { body: '' }, { body: '   ' }, { body: 'x'.repeat(4001) }, { body: 'x', mention_user_ids: Array.from({ length: 21 }, () => '00000000-0000-4000-8000-000000000001') },
      { body: 'x', mention_user_ids: ['not-a-uuid'] }, { body: 'x', extra: 1 }, {},
    ];
    for (const body of bad) expect((await a.api.call('post', `/tasks/${tid}/comments`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    // an id that is no user at all is dropped like a stranger
    const ghost = await a.api.call('post', `/tasks/${tid}/comments`, { body: 'x', mention_user_ids: ['00000000-0000-4000-8000-0000000000aa'] });
    expect(ghost.status).toBe(201);
    expect(ghost.body.mentions).toEqual([]);
  });

  it('lists the thread oldest first in pages and rejects a forged cursor', async () => {
    const s = await makeSite(db, REGION, { prefix: PREFIX });
    const tid = await makeTask(db, s, 'A1', 'open');
    const a = await author();
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push((await a.api.call('post', `/tasks/${tid}/comments`, { body: `c${i}` })).body.id);
    const p1 = await a.api.call('get', `/tasks/${tid}/comments?limit=2`);
    expect(p1.body.items.map((c: { id: string }) => c.id)).toEqual(made.slice(0, 2));
    const p2 = await a.api.call('get', `/tasks/${tid}/comments?limit=2&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`);
    expect(p2.body.items.map((c: { id: string }) => c.id)).toEqual(made.slice(2));
    expect(p2.body.page.next_cursor).toBeNull();
    const forged = Buffer.from(JSON.stringify(['yesterday', 'x'])).toString('base64url');
    expect((await a.api.call('get', `/tasks/${tid}/comments?cursor=${forged}`)).status).toBe(400);
  });
});

describe('X3 mentions on a register record', () => {
  it('mentions only people who can read the register in the record\'s region, once each, and the audit names only them', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const reader = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [REGION], modules: null });
    const viaDelegation = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: ['approvals'] });
    await delegate(db, viaDelegation.user.id, G('procurement', 'view'), [REGION]);
    const wrongRegion = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [1], modules: null });
    const wrongModule = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: null });
    const noGrant = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: null });
    const rec = await createRec(t, PROC);
    const path = recPath('procurement', rec.id, '/comments');

    const res = await t.entry.api.call('post', path, {
      body: `look @${reader.user.employeeId} @${wrongModule.user.employeeId}`,
      mention_user_ids: [reader.user.id, reader.user.id, viaDelegation.user.id, wrongRegion.user.id, wrongModule.user.id, noGrant.user.id, t.entry.user.id],
    });
    expect(res.status).toBe(201);
    expect(mentioned(res)).toEqual([reader.user.id, viaDelegation.user.id].sort());
    expect(await counts([reader, viaDelegation, wrongRegion, wrongModule, noGrant, t.entry])).toEqual([1, 1, 0, 0, 0, 0]);
    expect((await auditMentions('register_record_comment', rec.id)).at(-1)).toEqual([reader.user.id, viaDelegation.user.id].sort());
    const n = (await reader.api.call('get', '/notifications?kind=mention')).body.items[0];
    expect(n.link).toBe(`/registers/procurement/records/${rec.id}`);
    // the readers of the register see the thread; those who cannot are refused without a hint
    expect((await reader.api.call('get', path)).body.items).toHaveLength(1);
    expect((await wrongRegion.api.call('get', path)).status).toBe(404);
    expect((await wrongRegion.api.call('post', path, { body: 'x' })).status).toBe(404);
    expect((await wrongModule.api.call('get', path)).status).toBe(403);
    expect((await wrongModule.api.call('post', path, { body: 'x' })).status).toBe(403);
    expect((await noGrant.api.call('get', path)).status).toBe(403);
    expect((await request(app.getHttpServer()).get(`${API}${path}`)).status).toBe(401);
    expect((await request(app.getHttpServer()).post(`${API}${path}`).send({ body: 'x' })).status).toBe(401);
  });

  it('keeps one thread for all versions of the record, pages it, and validates the body', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const rec = await createRec(t, PROC);
    const path = (id: string) => recPath('procurement', id, '/comments');
    const c1 = await t.entry.api.call('post', path(rec.id), { body: 'first' });
    expect(c1.status).toBe(201);
    const done = await approveAll(t, rec.id, rec.version);
    const nv = await post(t.entry.api, 'procurement', rec.id, 'versions', done.version);
    expect([200, 201]).toContain(nv.status);
    const c2 = await t.entry.api.call('post', path(nv.body.id), { body: 'second' });
    expect(c2.status).toBe(201);
    const both = (id: string) => t.entry.api.call('get', path(id));
    expect((await both(rec.id)).body.items.map((c: { id: string }) => c.id)).toEqual([c1.body.id, c2.body.id]);
    expect((await both(nv.body.id)).body.items.map((c: { id: string }) => c.id)).toEqual([c1.body.id, c2.body.id]);
    const p1 = await t.entry.api.call('get', `${path(rec.id)}?limit=1`);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await t.entry.api.call('get', `${path(rec.id)}?limit=1&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`);
    expect(p2.body.items.map((c: { id: string }) => c.id)).toEqual([c2.body.id]);
    const forged = Buffer.from(JSON.stringify(['2026-01-01T00:00:00Z', 'nope'])).toString('base64url');
    expect((await t.entry.api.call('get', `${path(rec.id)}?cursor=${forged}`)).status).toBe(400);
    for (const body of [{ body: '' }, { body: 'x'.repeat(4001) }, { body: 'x', extra: true }, { body: 'x', mention_user_ids: ['nope'] }]) {
      expect((await t.entry.api.call('post', path(rec.id), body)).status, JSON.stringify(body).slice(0, 50)).toBe(422);
    }
    expect((await t.entry.api.call('get', recPath('procurement', '00000000-0000-4000-8000-000000000000', '/comments'))).status).toBe(404);
  });
});
