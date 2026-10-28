import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, loggedIn, makeAdmin, makeUser, startApp, superDb, TestUser } from './helpers';

let app: NestExpressApplication;
let db: Pg;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

interface Team { boss: TestUser; emp: TestUser; stranger: TestUser; bossApi: Api; empApi: Api; strangerApi: Api }

/** A manager with one report, and a third person who is neither. */
async function team(): Promise<Team> {
  const boss = await makeUser(db, { assigned: true });
  const emp = await makeUser(db, { assigned: true });
  const stranger = await makeUser(db, { assigned: true });
  await db.query('UPDATE users SET manager_id = $1 WHERE id = $2', [boss.id, emp.id]);
  return { boss, emp, stranger, bossApi: await loggedIn(app, boss), empApi: await loggedIn(app, emp), strangerApi: await loggedIn(app, stranger) };
}

const start = (api: Api, to: TestUser, subject = 'Leave request', body = 'May I take two days next week?') =>
  api.call('post', '/messages/threads', { to_user_id: to.id, subject, body });

describe('GET /messages/contacts', () => {
  it('gives an employee the manager, a manager the reports, an admin can_message_anyone', async () => {
    const t = await team();
    const emp = await t.empApi.call('get', '/messages/contacts');
    expect(emp.status).toBe(200);
    expect(emp.body).toEqual({ manager: { id: t.boss.id, display_name: t.boss.name, employee_id: t.boss.employeeId }, reports: [], can_message_anyone: false });
    const boss = await t.bossApi.call('get', '/messages/contacts');
    expect(boss.body.manager).toBeNull();
    expect(boss.body.reports).toEqual([{ id: t.emp.id, display_name: t.emp.name, employee_id: t.emp.employeeId }]);
    const stranger = await t.strangerApi.call('get', '/messages/contacts');
    expect(stranger.body).toEqual({ manager: null, reports: [], can_message_anyone: false });
    const admin = await loggedIn(app, await makeAdmin(db));
    expect((await admin.call('get', '/messages/contacts')).body.can_message_anyone).toBe(true);
    expect((await new Api(app).raw('get', '/messages/contacts')).status).toBe(401);
  });
});

describe('threads between an employee and the manager', () => {
  it('starts, replies in both directions, orders original first then replies newest first, and tracks unread', async () => {
    const t = await team();
    const created = await start(t.empApi, t.boss);
    expect(created.status).toBe(201);
    const id: string = created.body.id;
    expect(created.body).toMatchObject({ subject: 'Leave request', replies: [], original: { body: 'May I take two days next week?', author: { id: t.emp.id } } });
    expect(created.body.participants.map((p: { id: string }) => p.id).sort()).toEqual([t.emp.id, t.boss.id].sort());

    // the manager sees one unread thread; the starter has none
    const bossList = await t.bossApi.call('get', '/messages/threads');
    expect(bossList.status).toBe(200);
    expect(bossList.body.unread_total).toBe(1);
    expect(bossList.body.items[0]).toMatchObject({
      id, subject: 'Leave request', unread: true, started_by_me: false, reply_count: 0,
      other: { id: t.emp.id }, last_author: { id: t.emp.id }, last_message_preview: 'May I take two days next week?',
    });
    const empList = await t.empApi.call('get', '/messages/threads');
    expect(empList.body.unread_total).toBe(0);
    expect(empList.body.items[0]).toMatchObject({ unread: false, started_by_me: true, other: { id: t.boss.id } });

    // reading does not mark the thread read; the explicit call does
    const read1 = await t.bossApi.call('get', `/messages/threads/${id}`);
    expect(read1.status).toBe(200);
    expect(read1.body.last_read_at).toBeNull();
    expect((await t.bossApi.call('get', '/messages/threads?unread=true')).body.items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await t.bossApi.call('post', `/messages/threads/${id}/read`)).status).toBe(204);
    const afterRead = await t.bossApi.call('get', '/messages/threads');
    expect(afterRead.body.unread_total).toBe(0);
    expect(afterRead.body.items[0].unread).toBe(false);
    expect((await t.bossApi.call('get', '/messages/threads?unread=true')).body.items).toEqual([]);
    expect((await t.bossApi.call('get', `/messages/threads/${id}`)).body.last_read_at).not.toBeNull();

    // manager replies, then the employee, then the manager again
    const r1 = await t.bossApi.call('post', `/messages/threads/${id}/replies`, { body: 'Yes, approved.' });
    expect(r1.status).toBe(201);
    expect(r1.body.replies.map((r: { body: string }) => r.body)).toEqual(['Yes, approved.']);
    expect(r1.body.replies[0].author.id).toBe(t.boss.id);
    const r2 = await t.empApi.call('post', `/messages/threads/${id}/replies`, { body: 'Thank you.' });
    expect(r2.status).toBe(201);
    const r3 = await t.bossApi.call('post', `/messages/threads/${id}/replies`, { body: 'Enjoy.' });
    expect(r3.body.original.body).toBe('May I take two days next week?');
    expect(r3.body.replies.map((r: { body: string }) => r.body)).toEqual(['Enjoy.', 'Thank you.', 'Yes, approved.']);

    const full = await t.empApi.call('get', `/messages/threads/${id}`);
    expect(full.body.original.body).toBe('May I take two days next week?');
    expect(full.body.replies.map((r: { body: string }) => r.body)).toEqual(['Enjoy.', 'Thank you.', 'Yes, approved.']);

    // the employee has two unread replies' worth of thread: one thread unread, with the manager as last author
    const empAfter = await t.empApi.call('get', '/messages/threads');
    expect(empAfter.body.unread_total).toBe(1);
    expect(empAfter.body.items[0]).toMatchObject({ unread: true, reply_count: 3, last_author: { id: t.boss.id }, last_message_preview: 'Enjoy.' });
    expect((await t.empApi.call('post', `/messages/threads/${id}/read`)).status).toBe(204);
    expect((await t.empApi.call('get', '/messages/threads')).body.unread_total).toBe(0);
  });

  it('lets the manager start a thread with a report', async () => {
    const t = await team();
    const res = await start(t.bossApi, t.emp, 'Report', 'Please send the weekly report.');
    expect(res.status).toBe(201);
    expect((await t.empApi.call('get', '/messages/threads')).body.items[0]).toMatchObject({ unread: true, other: { id: t.boss.id } });
  });

  it('hides a thread from a third person: 404 on read, reply and mark-read, and nothing in the list', async () => {
    const t = await team();
    const id: string = (await start(t.empApi, t.boss)).body.id;
    expect((await t.strangerApi.call('get', `/messages/threads/${id}`)).status).toBe(404);
    const reply = await t.strangerApi.call('post', `/messages/threads/${id}/replies`, { body: 'Let me in.' });
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe('not_found');
    expect((await t.strangerApi.call('post', `/messages/threads/${id}/read`)).status).toBe(404);
    expect((await t.strangerApi.call('get', '/messages/threads')).body.items).toEqual([]);
    expect((await t.strangerApi.call('get', '/messages/threads/not-a-uuid')).status).toBe(404);
    const n = await db.query('SELECT count(*)::int AS n FROM messages WHERE thread_id = $1', [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('refuses a thread with someone who is not my manager or report (403 action_forbidden)', async () => {
    const t = await team();
    const res = await start(t.empApi, t.stranger);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
    expect((await start(t.empApi, t.emp)).status).toBe(403); // myself
    expect((await t.empApi.call('get', '/messages/threads')).body.items).toEqual([]);
  });

  it('lets a System Admin write to anyone, but not read a thread they are not part of', async () => {
    const t = await team();
    const admin = await loggedIn(app, await makeAdmin(db));
    const res = await start(admin, t.stranger, 'Notice', 'Please see me.');
    expect(res.status).toBe(201);
    expect((await t.strangerApi.call('get', `/messages/threads/${res.body.id}`)).status).toBe(200);
    const priv = await start(t.empApi, t.boss);
    const peek = await admin.call('get', `/messages/threads/${priv.body.id}`);
    expect(peek.status).toBe(404);
    expect((await admin.call('post', `/messages/threads/${priv.body.id}/replies`, { body: 'peek' })).status).toBe(404);
    expect((await admin.call('get', '/messages/threads')).body.items.map((x: { id: string }) => x.id)).not.toContain(priv.body.id);
  });

  it('keeps a thread usable after the manager link changes, and refuses new threads on the old link', async () => {
    const t = await team();
    const id: string = (await start(t.empApi, t.boss)).body.id;
    await db.query('UPDATE users SET manager_id = NULL WHERE id = $1', [t.emp.id]);
    expect((await t.bossApi.call('post', `/messages/threads/${id}/replies`, { body: 'Still here.' })).status).toBe(201);
    expect((await start(t.empApi, t.boss)).status).toBe(403);
  });

  it('pages the thread list with a cursor, most recent activity first', async () => {
    const t = await team();
    const a: string = (await start(t.empApi, t.boss, 'First', 'one')).body.id;
    const b: string = (await start(t.empApi, t.boss, 'Second', 'two')).body.id;
    const p1 = await t.bossApi.call('get', '/messages/threads?limit=1');
    expect(p1.body.items.map((x: { id: string }) => x.id)).toEqual([b]);
    expect(p1.body.page.next_cursor).toBeTruthy();
    expect(p1.body.unread_total).toBe(2);
    const p2 = await t.bossApi.call('get', `/messages/threads?limit=1&cursor=${p1.body.page.next_cursor}`);
    expect(p2.body.items.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(p2.body.page.next_cursor).toBeNull();
    // a reply moves the older thread to the top
    await t.empApi.call('post', `/messages/threads/${a}/replies`, { body: 'bump' });
    expect((await t.bossApi.call('get', '/messages/threads')).body.items.map((x: { id: string }) => x.id)).toEqual([a, b]);
    expect((await t.bossApi.call('get', '/messages/threads?cursor=xx')).status).toBe(400);
    expect((await t.bossApi.call('get', '/messages/threads?unread=maybe')).status).toBe(422);
  });

  it('validates bodies', async () => {
    const t = await team();
    expect((await t.empApi.call('post', '/messages/threads', { to_user_id: t.boss.id, subject: '', body: 'x' })).status).toBe(422);
    expect((await t.empApi.call('post', '/messages/threads', { to_user_id: 'nope', subject: 's', body: 'x' })).status).toBe(422);
    expect((await t.empApi.call('post', '/messages/threads', { to_user_id: t.boss.id, subject: 's', body: 'x', extra: 1 })).status).toBe(422);
    const id: string = (await start(t.empApi, t.boss)).body.id;
    expect((await t.bossApi.call('post', `/messages/threads/${id}/replies`, { body: '   ' })).status).toBe(422);
  });

  it('needs a signed-in, assigned account', async () => {
    expect((await new Api(app).raw('get', '/messages/threads')).status).toBe(401);
    const pending = await loggedIn(app, await makeUser(db, {}));
    const res = await pending.call('get', '/messages/threads');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('pending_assignment');
  });
});
