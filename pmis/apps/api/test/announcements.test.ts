import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserStateService } from '../src/auth/user-state.service';
import { Api, delegate, ensureRole, loggedIn, makeAdmin, makeUser, startApp, superDb, TestUser } from './helpers';

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

let n = 0;
async function newDepartment(): Promise<string> {
  const r = await db.query('INSERT INTO departments (code, name_en) VALUES ($1, $2) RETURNING id', [`D${Date.now().toString(36).toUpperCase()}${n++}`.slice(0, 20), 'Ops "East", Unit']);
  return r.rows[0].id as string;
}

async function member(dept: string, over: Parameters<typeof makeUser>[1] = { assigned: true }): Promise<TestUser> {
  const u = await makeUser(db, over);
  await db.query('UPDATE users SET department_id = $1 WHERE id = $2', [dept, u.id]);
  return u;
}

interface Setup { admin: Api; adminUser: TestUser; dept: string; people: TestUser[]; apis: Api[] }

/** An admin and a department of two active people. */
async function setup(): Promise<Setup> {
  const adminUser = await makeAdmin(db);
  const dept = await newDepartment();
  const people = [await member(dept), await member(dept)];
  return { admin: await loggedIn(app, adminUser), adminUser, dept, people, apis: await Promise.all(people.map((p) => loggedIn(app, p))) };
}

const send = (api: Api, audience: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  api.call('post', '/announcements', { title: 'Fire drill', body: 'There is a fire drill at 10:00 on Sunday.', audience, ...over });

describe('POST /announcements', () => {
  it('sends to a department: the recipients are fixed, the sender is never one, counts are returned', async () => {
    const s = await setup();
    const res = await send(s.admin, { department_ids: [s.dept] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Fire drill', created_by: { id: s.adminUser.id }, recipient_count: 2, agree_count: 0, disagree_count: 0, pending_count: 2,
    });
    const rec = await db.query('SELECT user_id FROM announcement_recipients WHERE announcement_id = $1', [res.body.id]);
    expect(rec.rows.map((r) => r.user_id).sort()).toEqual(s.people.map((p) => p.id).sort());
    const audit = await db.query("SELECT actor_id, after FROM audit_log WHERE action = 'announcement_sent' AND entity_id = $1", [res.body.id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: s.adminUser.id, after: { recipients: 2 } });

    // a person who joins the department later does not receive it
    const late = await member(s.dept);
    const lateApi = await loggedIn(app, late);
    expect((await lateApi.call('get', '/me/announcements/pending')).body.items).toEqual([]);
    expect((await s.admin.call('get', `/announcements/${res.body.id}`)).body.recipient_count).toBe(2);
  });

  it('sends to everyone (all), to chosen users, to a group and to a role', async () => {
    const s = await setup();
    const all = await send(s.admin, { all: true });
    expect(all.status).toBe(201);
    expect(all.body.recipient_count).toBeGreaterThanOrEqual(2);
    expect((await s.apis[0]!.call('get', '/me/announcements/pending')).body.items.map((a: { id: string }) => a.id)).toContain(all.body.id);

    const users = await send(s.admin, { user_ids: [s.people[0]!.id] });
    expect(users.body.recipient_count).toBe(1);

    const group = (await db.query('INSERT INTO groups (name) VALUES ($1) RETURNING id', [`Ann group ${Date.now()}${n++}`])).rows[0].id as string;
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [group, s.people[1]!.id]);
    expect((await send(s.admin, { group_ids: [group] })).body.recipient_count).toBe(1);

    const roleCode = `ANN_ROLE_${Date.now()}${n++}`;
    const role = await ensureRole(db, roleCode);
    await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true)`, [s.people[0]!.id, role]);
    expect((await send(s.admin, { role_ids: [role] })).body.recipient_count).toBe(1);
  });

  it('is refused for a non-admin (403 action_forbidden) and for a delegate limited to some regions; an all-regions delegate may send', async () => {
    const s = await setup();
    const plain = await send(s.apis[0]!, { department_ids: [s.dept] });
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe('action_forbidden');

    const regional = await makeUser(db, { assigned: true });
    await delegate(db, regional.id, [['announcements', 'create']], [1]);
    const regionalApi = await loggedIn(app, regional);
    const refused = await send(regionalApi, { department_ids: [s.dept] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('action_forbidden');

    const global = await makeUser(db, { assigned: true });
    await delegate(db, global.id, [['announcements', 'create']]);
    const globalApi = await loggedIn(app, global);
    const ok = await send(globalApi, { department_ids: [s.dept] });
    expect(ok.status).toBe(201);
    expect(ok.body.created_by.id).toBe(global.id);
    // the delegate sees what they sent, and nothing sent by others
    const mine = await globalApi.call('get', '/announcements');
    expect(mine.body.items.map((a: { id: string }) => a.id)).toEqual([ok.body.id]);
  });

  it('answers 422 validation_failed with errors[].code no_recipients when nobody matches', async () => {
    const s = await setup();
    const emptyDept = await newDepartment();
    for (const audience of [{ department_ids: [emptyDept] }, {}, { user_ids: [s.adminUser.id] }]) {
      const res = await send(s.admin, audience);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors).toEqual([expect.objectContaining({ code: 'no_recipients' })]);
    }
    const suspended = await member(s.dept, { status: 'suspended' });
    expect((await send(s.admin, { user_ids: [suspended.id] })).status).toBe(422);
  });

  it('validates the body', async () => {
    const s = await setup();
    expect((await send(s.admin, { department_ids: ['nope'] })).status).toBe(422);
    expect((await send(s.admin, { all: true }, { title: '' })).status).toBe(422);
    expect((await send(s.admin, { all: true, everyone: true })).status).toBe(422);
    expect((await new Api(app).raw('post', '/announcements')).status).toBe(401);
  });
});

describe('answering', () => {
  it('records agree once; a second answer is 409 duplicate; the announcement leaves the pending list', async () => {
    const s = await setup();
    const a = (await send(s.admin, { department_ids: [s.dept] })).body.id as string;
    const api = s.apis[0]!;
    expect((await api.call('get', '/me/announcements/pending')).body.items.map((x: { id: string }) => x.id)).toEqual([a]);
    const ok = await api.call('post', `/announcements/${a}/respond`, { decision: 'agree' });
    expect(ok.status).toBe(204);
    expect((await api.call('get', '/me/announcements/pending')).body.items).toEqual([]);
    const again = await api.call('post', `/announcements/${a}/respond`, { decision: 'disagree', note: 'changed my mind' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('duplicate');
    const row = await db.query('SELECT decision FROM announcement_responses WHERE announcement_id = $1 AND user_id = $2', [a, s.people[0]!.id]);
    expect(row.rows).toEqual([{ decision: 'agree' }]);
  });

  it('needs a note of at least 3 characters to disagree (422 note_required) and keeps the pop-up pending', async () => {
    const s = await setup();
    const a = (await send(s.admin, { department_ids: [s.dept] })).body.id as string;
    const api = s.apis[0]!;
    for (const body of [{ decision: 'disagree' }, { decision: 'disagree', note: null }, { decision: 'disagree', note: '  ab ' }]) {
      const res = await api.call('post', `/announcements/${a}/respond`, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('note_required');
      expect(res.body.errors[0]).toMatchObject({ path: '/note', code: 'note_required' });
    }
    expect((await api.call('get', '/me/announcements/pending')).body.items).toHaveLength(1);
    const ok = await api.call('post', `/announcements/${a}/respond`, { decision: 'disagree', note: 'The time clashes with the shift.' });
    expect(ok.status).toBe(204);
    expect((await api.call('post', `/announcements/${a}/respond`, { decision: 'wat' })).status).toBe(422);
  });

  it('answers 404 to someone it was not addressed to, to the sender and to a System Admin', async () => {
    const s = await setup();
    const a = (await send(s.admin, { user_ids: [s.people[0]!.id] })).body.id as string;
    const outsider = await loggedIn(app, await makeUser(db, { assigned: true }));
    const res = await outsider.call('post', `/announcements/${a}/respond`, { decision: 'agree' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect((await s.apis[1]!.call('post', `/announcements/${a}/respond`, { decision: 'agree' })).status).toBe(404);
    expect((await s.admin.call('post', `/announcements/${a}/respond`, { decision: 'agree' })).status).toBe(404);
    expect((await outsider.call('post', '/announcements/not-a-uuid/respond', { decision: 'agree' })).status).toBe(404);
    expect((await outsider.call('get', '/me/announcements/pending')).body.items).toEqual([]);
    expect((await new Api(app).raw('post', `/announcements/${a}/respond`)).status).toBe(401);
  });

  it('lists the pending announcements oldest first', async () => {
    const s = await setup();
    const first = (await send(s.admin, { department_ids: [s.dept] }, { title: 'First' })).body.id as string;
    const second = (await send(s.admin, { department_ids: [s.dept] }, { title: 'Second', body: 'Second text' })).body.id as string;
    const res = await s.apis[0]!.call('get', '/me/announcements/pending', undefined, { 'X-PMIS-Live': '1' });
    expect(res.status).toBe(200);
    expect(res.body.items.map((x: { id: string }) => x.id)).toEqual([first, second]);
    expect(res.body.items[1]).toMatchObject({ title: 'Second', body: 'Second text', created_by: { id: s.adminUser.id } });
  });

  it('works for a must-change account and for a pending-assignment account (the blocking pop-up)', async () => {
    const adminUser = await makeAdmin(db);
    const admin = await loggedIn(app, adminUser);
    const dept = await newDepartment();
    const mustChange = await member(dept, { assigned: true, mustChange: true });
    const unassigned = await member(dept, {}); // active, no assignment: pending by the guard
    const a = (await send(admin, { department_ids: [dept] })).body.id as string;
    expect((await db.query('SELECT count(*)::int AS n FROM announcement_recipients WHERE announcement_id = $1', [a])).rows[0].n).toBe(2);

    const mc = await loggedIn(app, mustChange);
    expect((await mc.call('get', '/groups')).body.code).toBe('password_change_required');
    const list = await mc.call('get', '/me/announcements/pending');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([a]);
    expect((await mc.call('post', `/announcements/${a}/respond`, { decision: 'agree' })).status).toBe(204);

    const pend = await loggedIn(app, unassigned);
    expect((await pend.call('get', '/groups')).body.code).toBe('pending_assignment');
    expect((await pend.call('get', '/me/announcements/pending')).body.items.map((x: { id: string }) => x.id)).toEqual([a]);
    expect((await pend.call('post', `/announcements/${a}/respond`, { decision: 'disagree', note: 'I object to this' })).status).toBe(204);
    // the other announcement endpoints stay closed to them
    expect((await pend.call('get', '/announcements')).body.code).toBe('pending_assignment');
  });
});

describe('results', () => {
  async function answered() {
    const s = await setup();
    const third = await member(s.dept);
    const a = (await send(s.admin, { department_ids: [s.dept] }, { title: 'Policy' })).body.id as string;
    expect((await s.apis[0]!.call('post', `/announcements/${a}/respond`, { decision: 'agree' })).status).toBe(204);
    expect((await s.apis[1]!.call('post', `/announcements/${a}/respond`, { decision: 'disagree', note: 'Too short, "notice"\nplease =extend' })).status).toBe(204);
    return { ...s, third, a };
  }

  it('lists the announcements for the sender and for a System Admin, with counts; a recipient gets text only', async () => {
    const s = await answered();
    const mine = await s.admin.call('get', '/announcements');
    expect(mine.status).toBe(200);
    expect(mine.body.items[0]).toMatchObject({ id: s.a, recipient_count: 3, agree_count: 1, disagree_count: 1, pending_count: 1 });
    expect(mine.body.page.limit).toBe(50);

    const otherAdmin = await loggedIn(app, await makeAdmin(db));
    expect((await otherAdmin.call('get', '/announcements')).body.items.map((x: { id: string }) => x.id)).toContain(s.a);
    expect((await otherAdmin.call('get', `/announcements/${s.a}/responses`)).status).toBe(200);

    expect((await s.apis[0]!.call('get', '/announcements')).body.items).toEqual([]);

    const detail = await s.admin.call('get', `/announcements/${s.a}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ body: 'There is a fire drill at 10:00 on Sunday.', recipient_count: 3, agree_count: 1, disagree_count: 1, pending_count: 1 });
    expect(detail.body.audience.departments.map((d: { id: string }) => d.id)).toEqual([s.dept]);
    expect(detail.body.audience).toMatchObject({ all: false, users: [], groups: [], roles: [] });

    const asRecipient = await s.apis[0]!.call('get', `/announcements/${s.a}`);
    expect(asRecipient.status).toBe(200);
    expect(asRecipient.body).toMatchObject({ title: 'Policy', body: 'There is a fire drill at 10:00 on Sunday.', recipient_count: 0, agree_count: 0, disagree_count: 0, pending_count: 0 });
    expect(asRecipient.body.audience.departments).toEqual([]);
    const stranger = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await stranger.call('get', `/announcements/${s.a}`)).status).toBe(404);
    expect((await stranger.call('get', '/announcements/not-a-uuid')).status).toBe(404);
  });

  it('pages the list newest first', async () => {
    const s = await setup();
    const a = (await send(s.admin, { department_ids: [s.dept] }, { title: 'A' })).body.id as string;
    const b = (await send(s.admin, { department_ids: [s.dept] }, { title: 'B' })).body.id as string;
    const p1 = await s.admin.call('get', '/announcements?limit=1');
    expect(p1.body.items.map((x: { id: string }) => x.id)).toEqual([b]);
    const p2 = await s.admin.call('get', `/announcements?limit=1&cursor=${p1.body.page.next_cursor}`);
    expect(p2.body.items.map((x: { id: string }) => x.id)).toEqual([a]);
  });

  it('lists the responses with the decision filter, pending = recipients without an answer', async () => {
    const s = await answered();
    const all = await s.admin.call('get', `/announcements/${s.a}/responses`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);
    expect(all.body.page.total).toBe(3);
    const byUser = Object.fromEntries(all.body.items.map((i: { user: { id: string } }) => [i.user.id, i]));
    expect(byUser[s.people[0]!.id]).toMatchObject({ decision: 'agree', note: null, department: { id: s.dept } });
    expect(byUser[s.people[0]!.id].responded_at).toBeTruthy();
    expect(byUser[s.people[1]!.id]).toMatchObject({ decision: 'disagree', note: 'Too short, "notice"\nplease =extend' });
    expect(byUser[s.third.id]).toMatchObject({ decision: 'pending', note: null, responded_at: null });

    const ids = async (q: string) => (await s.admin.call('get', `/announcements/${s.a}/responses?decision=${q}`)).body.items.map((i: { user: { id: string } }) => i.user.id);
    expect(await ids('pending')).toEqual([s.third.id]);
    expect(await ids('agree')).toEqual([s.people[0]!.id]);
    expect(await ids('disagree')).toEqual([s.people[1]!.id]);
    expect((await s.admin.call('get', `/announcements/${s.a}/responses?decision=maybe`)).status).toBe(422);

    const p1 = await s.admin.call('get', `/announcements/${s.a}/responses?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await s.admin.call('get', `/announcements/${s.a}/responses?limit=2&cursor=${p1.body.page.next_cursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.page.next_cursor).toBeNull();

    // a recipient (and anyone else) cannot read the results
    expect((await s.apis[0]!.call('get', `/announcements/${s.a}/responses`)).status).toBe(404);
    expect((await s.apis[0]!.call('get', `/announcements/${s.a}/responses/export`)).status).toBe(404);
  });

  it('exports a CSV with BOM and the agreed columns, and audits the export', async () => {
    const s = await answered();
    const res = await s.admin.call('get', `/announcements/${s.a}/responses/export`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="announcement-.*\.csv"$/);
    const buf = res.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8').slice(1);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('employee_id,name,department,decision,note,responded_at');
    const row = lines.find((l) => l.startsWith(s.people[1]!.employeeId + ','))!;
    expect(row).toContain(s.people[1]!.name);
    expect(row).toContain('"Ops ""East"", Unit"');
    expect(row).toContain(',disagree,"Too short, ""notice""\nplease =extend"');
    expect(lines.find((l) => l.startsWith(s.third.employeeId + ','))).toMatch(/,pending,,$/);
    expect(lines.find((l) => l.startsWith(s.people[0]!.employeeId + ','))).toMatch(/,agree,,\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(text.endsWith('\r\n')).toBe(true);

    const audit = await db.query("SELECT actor_id, after FROM audit_log WHERE action = 'announcement_exported' AND entity_id = $1", [s.a]);
    expect(audit.rows).toEqual([{ actor_id: s.adminUser.id, after: { rows: 3 } }]);
    expect((await new Api(app).raw('get', `/announcements/${s.a}/responses/export`)).status).toBe(401);
  });

  it('neutralises a spreadsheet formula in a note', async () => {
    const s = await setup();
    const a = (await send(s.admin, { user_ids: [s.people[0]!.id] })).body.id as string;
    await s.apis[0]!.call('post', `/announcements/${a}/respond`, { decision: 'disagree', note: '=HYPERLINK("http://x")' });
    const res = await s.admin.call('get', `/announcements/${a}/responses/export`);
    expect(res.text).toContain(`'=HYPERLINK`);
  });
});

describe('navigation', () => {
  it('adds messages for every active user and announcements for admins and all-regions delegates', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const adminNav = (await admin.call('get', '/me')).body.effective.nav as string[];
    expect(adminNav).toEqual(expect.arrayContaining(['messages', 'announcements']));

    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    const plainNav = (await plain.call('get', '/me')).body.effective.nav as string[];
    expect(plainNav).toContain('messages');
    expect(plainNav).not.toContain('announcements');

    const regional = await makeUser(db, { assigned: true });
    await delegate(db, regional.id, [['announcements', 'create']], [2]);
    expect(((await (await loggedIn(app, regional)).call('get', '/me')).body.effective.nav as string[])).not.toContain('announcements');

    const delegate1 = await makeUser(db, { assigned: true });
    await delegate(db, delegate1.id, [['announcements', 'create']]);
    app.get(UserStateService).invalidate(delegate1.id);
    const nav = (await (await loggedIn(app, delegate1)).call('get', '/me')).body.effective.nav as string[];
    expect(nav).toEqual(expect.arrayContaining(['messages', 'announcements']));

    const pending = await loggedIn(app, await makeUser(db, {}));
    expect((await pending.call('get', '/me')).body.effective.nav).toEqual([]);
  });
});
