import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, Api, delegate, grantProfile, loggedIn, makeAdmin, makeUser, startApp, superDbMfa } from './helpers';

/**
 * Migration 0143, contract 0.15.60: the per-user MFA exemption, POST /groups, POST /me/notify-admins and POST /auth/employee-id on the real API.
 * Runs on its own database (TEST_DATABASE_URL_MFA): one case switches the global setting require_mfa on.
 */
let app: NestExpressApplication;
let db: Pg;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_MFA as string });
  db = await superDbMfa();
});
afterAll(async () => {
  await db.query("UPDATE settings SET value = 'false'::jsonb WHERE key = 'require_mfa'");
  await app.close();
  await db.end();
});

const future = (h: number): string => new Date(Date.now() + h * 3600_000).toISOString();

describe('MFA exemption (GET, PUT, revoke)', () => {
  it('reads the state for a holder of admin.users view only', async () => {
    const target = await makeUser(db, { assigned: true });
    const plain = await makeUser(db, { assigned: true });
    const p = await loggedIn(app, plain);
    expect((await p.call('get', `/users/${target.id}/mfa-exemption`)).body.code).toBe('module_forbidden');
    const { api } = await adminApi(app, db);
    const res = await api.call('get', `/users/${target.id}/mfa-exemption`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { id: target.id }, exempt: false, until: null, reason: null });
    expect((await api.call('get', `/users/${randomUUID()}/mfa-exemption`)).status).toBe(404);
  });

  it('refuses exempting yourself (403 self_beneficiary), in the API and in the database', async () => {
    const { admin, api } = await adminApi(app, db);
    const res = await api.call('put', `/users/${admin.id}/mfa-exemption`, { reason: 'my own account', until: null });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_beneficiary');
    expect((await db.query('SELECT 1 FROM user_mfa_exemptions WHERE user_id = $1', [admin.id])).rowCount).toBe(0);
  });

  it('needs the acting admin\'s own step-up, then exempts with an end date, audits, notifies, mails and shows the badge', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const target = await makeUser(db, { assigned: true });
    const until = future(48);
    const early = await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'field phone broken', until });
    expect(early.status).toBe(401);
    expect(early.body.code).toBe('step_up_required');
    expect((await db.query('SELECT 1 FROM user_mfa_exemptions WHERE user_id = $1', [target.id])).rowCount).toBe(0);
    await api.stepUp(admin.password);

    const res = await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'field phone broken', until });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exempt: true, reason: 'field phone broken', granted_by: { id: admin.id } });
    expect(new Date(res.body.until).toISOString()).toBe(until);
    const audit = await db.query("SELECT before, after, reason, actor_id, is_admin_override FROM audit_log WHERE action = 'mfa_exemption_granted' AND entity_id = $1", [target.id]);
    expect(audit.rows[0]).toMatchObject({ before: { exempt: false }, after: { exempt: true, granted_by: admin.id }, reason: 'field phone broken', actor_id: admin.id, is_admin_override: true });
    const note = await db.query("SELECT title FROM notifications WHERE user_id = $1 AND kind = 'mfa_exemption'", [target.id]);
    expect(note.rowCount).toBe(1);
    const mail = await db.query('SELECT kind, body_text FROM mail_outbox WHERE to_address = $1', [target.email]);
    expect(mail.rows.map((r) => r.kind)).toContain('identity.security_notice');
    expect(mail.rows.some((r) => String(r.body_text).includes('field phone broken'))).toBe(false); // the reason never goes by mail
    const sec = await db.query("SELECT 1 FROM security_log WHERE event = 'mfa_exemption_granted' AND user_id = $1", [target.id]);
    expect(sec.rowCount).toBe(1);

    const user = await api.call('get', `/users/${target.id}`);
    expect(user.body).toMatchObject({ mfa_exempt: true });
    expect(new Date(user.body.mfa_exempt_until).toISOString()).toBe(until);
    const list = await api.call('get', `/users?q=${encodeURIComponent(target.name)}`);
    expect(list.body.items[0]).toMatchObject({ id: target.id, mfa_exempt: true });

    // change to "until revoked": a second audit row with the old state as before
    const again = await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'still broken' });
    expect(again.body).toMatchObject({ exempt: true, until: null });
    const changed = await db.query("SELECT before FROM audit_log WHERE action = 'mfa_exemption_changed' AND entity_id = $1", [target.id]);
    expect(changed.rows[0].before).toMatchObject({ exempt: true });
  });

  it('validates the body: a past end date, a missing reason, unknown keys', async () => {
    const { api } = await adminApi(app, db);
    const target = await makeUser(db, { assigned: true });
    const past = await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'too late', until: new Date(Date.now() - 60_000).toISOString() });
    expect(past.status).toBe(422);
    expect(past.body.errors[0]).toMatchObject({ path: '/until', code: 'must_be_future' });
    expect((await api.call('put', `/users/${target.id}/mfa-exemption`, { until: null })).status).toBe(422);
    expect((await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'ok reason', extra: 1 })).status).toBe(422);
  });

  it('revokes an exemption in force once (409 when there is nothing to revoke)', async () => {
    const { api } = await adminApi(app, db);
    const target = await makeUser(db, { assigned: true });
    expect((await api.call('post', `/users/${target.id}/mfa-exemption/revoke`, { reason: 'nothing yet' })).status).toBe(409);
    await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'temporary', until: null });
    const res = await api.call('post', `/users/${target.id}/mfa-exemption/revoke`, { reason: 'phone replaced' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exempt: false, until: null });
    const audit = await db.query("SELECT before, after FROM audit_log WHERE action = 'mfa_exemption_revoked' AND entity_id = $1", [target.id]);
    expect(audit.rows[0]).toMatchObject({ before: { exempt: true }, after: { exempt: false } });
    const again = await api.call('post', `/users/${target.id}/mfa-exemption/revoke`, { reason: 'phone replaced' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
    expect((await api.call('get', `/users/${target.id}`)).body.mfa_exempt).toBe(false);
  });

  it('a delegate with users.administer exempts a plain user but not an admin; without the right it is 403', async () => {
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'administer']]);
    const dApi = await loggedIn(app, del);
    await dApi.stepUp(del.password);
    const plain = await makeUser(db, { assigned: true });
    expect((await dApi.call('put', `/users/${plain.id}/mfa-exemption`, { reason: 'delegated exemption', until: future(2) })).status).toBe(200);
    const admin = await makeAdmin(db);
    const toAdmin = await dApi.call('put', `/users/${admin.id}/mfa-exemption`, { reason: 'delegate on admin', until: null });
    expect(toAdmin.status).toBe(403);
    expect(toAdmin.body.code).toBe('action_forbidden');
    const onBehalf = await db.query("SELECT on_behalf_of FROM audit_log WHERE action = 'mfa_exemption_granted' AND entity_id = $1", [plain.id]);
    expect(onBehalf.rows[0].on_behalf_of).toBeTruthy();

    const regional = await makeUser(db, { assigned: true });
    await delegate(db, regional.id, [['users', 'administer']], [1]);
    const rApi = await loggedIn(app, regional);
    await rApi.stepUp(regional.password);
    expect((await rApi.call('put', `/users/${plain.id}/mfa-exemption`, { reason: 'regional delegate', until: null })).status).toBe(403);
    const nobody = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await nobody.call('put', `/users/${plain.id}/mfa-exemption`, { reason: 'no right', until: null })).status).toBe(403);
  });

  it('the MFA check honours the exemption and its end date at sign-in and at step-up (require_mfa on)', async () => {
    const { api } = await adminApi(app, db); // stepped up before require_mfa goes on
    const target = await makeUser(db, { assigned: true });
    await db.query("UPDATE settings SET value = 'true'::jsonb WHERE key = 'require_mfa'");
    try {
      const refused = await new Api(app).login(target.email, target.password);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('mfa_required');
      const sec = await db.query("SELECT detail FROM security_log WHERE event = 'sign_in_failed' AND user_id = $1 ORDER BY id DESC LIMIT 1", [target.id]);
      expect(sec.rows[0].detail).toMatchObject({ reason: 'mfa_required' });

      expect((await api.call('put', `/users/${target.id}/mfa-exemption`, { reason: 'no phone yet', until: future(1) })).status).toBe(200);
      const t = new Api(app);
      expect((await t.login(target.email, target.password)).status).toBe(200);
      expect((await t.stepUp(target.password)).status).toBe(200);

      // the end date passes: the next step-up and the next sign-in follow the MFA rule again
      await db.query("UPDATE user_mfa_exemptions SET until = now() - interval '1 second', granted_at = now() - interval '1 hour' WHERE user_id = $1", [target.id]);
      const step = await t.stepUp(target.password);
      expect(step.status).toBe(401);
      expect(step.body.code).toBe('mfa_required');
      expect((await new Api(app).login(target.email, target.password)).body.code).toBe('mfa_required');
      expect((await api.call('get', `/users/${target.id}/mfa-exemption`)).body).toMatchObject({ exempt: false, until: null });
    } finally {
      await db.query("UPDATE settings SET value = 'false'::jsonb WHERE key = 'require_mfa'");
    }
    // off again: a password is enough
    expect((await new Api(app).login(target.email, target.password)).status).toBe(200);
  });
});

describe('POST /groups', () => {
  it('needs step-up, then creates the group with its members, audited, with an ETag', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const a = await makeUser(db, { assigned: true });
    const b = await makeUser(db, { assigned: true });
    const name = `CW Approvers ${randomUUID().slice(0, 6)}`;
    const body = { name, description: 'Synthetic group', member_ids: [a.id, b.id, a.id], reason: 'new approver group' };
    const early = await api.call('post', '/groups', body);
    expect(early.status).toBe(401);
    expect(early.body.code).toBe('step_up_required');
    await api.stepUp(admin.password);
    const res = await api.call('post', '/groups', body);
    expect(res.status).toBe(201);
    expect(res.headers['etag']).toBe(`"${res.body.version}"`);
    expect(res.body).toMatchObject({ name, description: 'Synthetic group', is_system_admins: false, is_active: true, member_count: 2 });
    expect(res.body.members.map((m: { user: { id: string } }) => m.user.id).sort()).toEqual([a.id, b.id].sort());
    const audit = await db.query("SELECT after, reason, actor_id FROM audit_log WHERE action = 'group_created' AND entity_id = $1", [res.body.id]);
    expect(audit.rows[0]).toMatchObject({ reason: 'new approver group', actor_id: admin.id, after: { name } });
    expect((await db.query("SELECT 1 FROM audit_log WHERE action = 'group_member_added' AND entity_id = $1", [res.body.id])).rowCount).toBe(2);

    const dup = await api.call('post', '/groups', { name: name.toUpperCase(), reason: 'same name' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
    expect((await api.call('post', '/groups', { name: 'x', reason: 'too short' })).status).toBe(422);
    expect((await api.call('post', '/groups', { name: 'No reason group' })).status).toBe(422);
  });

  it('never lets the creator join their own group, nor a pending or unknown member; nothing is created', async () => {
    const { admin, api } = await adminApi(app, db);
    const name = `Self Group ${randomUUID().slice(0, 6)}`;
    const self = await api.call('post', '/groups', { name, member_ids: [admin.id], reason: 'me inside' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');
    const pending = await makeUser(db, { status: 'pending_assignment' });
    const bad = await api.call('post', '/groups', { name, member_ids: [pending.id, randomUUID()], reason: 'bad members' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/member_ids/0', code: 'pending_assignment' }), expect.objectContaining({ path: '/member_ids/1', code: 'not_found' })]));
    expect((await db.query('SELECT 1 FROM groups WHERE name = $1', [name])).rowCount).toBe(0);
  });

  it('applies the ceilings: groups.create for all regions; members also need groups.edit; a plain user is refused', async () => {
    const createOnly = await makeUser(db, { assigned: true });
    await delegate(db, createOnly.id, [['groups', 'create']]);
    const c = await loggedIn(app, createOnly);
    await c.stepUp(createOnly.password);
    const member = await makeUser(db, { assigned: true });
    const withMembers = await c.call('post', '/groups', { name: `Deleg ${randomUUID().slice(0, 6)}`, member_ids: [member.id], reason: 'delegate with members' });
    expect(withMembers.status).toBe(403);
    const empty = await c.call('post', '/groups', { name: `Deleg ${randomUUID().slice(0, 6)}`, reason: 'delegate, no members' });
    expect(empty.status).toBe(201);
    const obo = await db.query("SELECT on_behalf_of FROM audit_log WHERE action = 'group_created' AND entity_id = $1", [empty.body.id]);
    expect(obo.rows[0].on_behalf_of).toBeTruthy();
    // the delegate then tries to slip into the group they created
    const slip = await c.call('post', `/groups/${empty.body.id}/members`, { user_ids: [createOnly.id], reason: 'join my group' });
    expect(slip.status).toBe(403); // no groups.edit at all

    const regional = await makeUser(db, { assigned: true });
    await delegate(db, regional.id, [['groups', 'create'], ['groups', 'edit']], [1]);
    const r = await loggedIn(app, regional);
    await r.stepUp(regional.password);
    expect((await r.call('post', '/groups', { name: `Regional ${randomUUID().slice(0, 6)}`, reason: 'regional delegate' })).status).toBe(403);

    const plain = await makeUser(db, { assigned: true });
    await grantProfile(db, plain.id, [['admin.groups', 'view']]);
    const p = await loggedIn(app, plain);
    await p.stepUp(plain.password);
    expect((await p.call('post', '/groups', { name: `Plain ${randomUUID().slice(0, 6)}`, reason: 'no right' })).body.code).toBe('action_forbidden');
  });
});

describe('POST /me/notify-admins', () => {
  it('a pending user notifies the System Admins once per cooldown (in-app, mail, audit), then 429', async () => {
    const admin = await makeAdmin(db);
    const pending = await makeUser(db, { status: 'pending_assignment' });
    const api = await loggedIn(app, pending);
    expect((await api.call('get', '/users')).body.code).toBe('pending_assignment');
    const res = await api.call('post', '/me/notify-admins', { message: 'Please assign me to CW Tripoli.\nThanks' });
    expect(res.status).toBe(202);
    const notes = await db.query("SELECT body, link FROM notifications WHERE user_id = $1 AND kind = 'assignment_request' AND link = $2", [admin.id, `/admin/users/${pending.id}`]);
    expect(notes.rowCount).toBe(1);
    expect(notes.rows[0].body).toContain('Please assign me to CW Tripoli.');
    const mail = await db.query("SELECT 1 FROM mail_outbox WHERE kind = 'identity.assignment_request' AND to_address = $1", [admin.email]);
    expect(mail.rowCount).toBe(1);
    const audit = await db.query("SELECT actor_id, after FROM audit_log WHERE action = 'admins_notified' AND entity_id = $1", [pending.id]);
    expect(audit.rows[0].actor_id).toBe(pending.id);
    expect(audit.rows[0].after.recipients).toBeGreaterThanOrEqual(2);

    const again = await api.call('post', '/me/notify-admins', {});
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('rate_limited');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(60);
    expect((await db.query('SELECT 1 FROM me_admin_requests WHERE user_id = $1', [pending.id])).rowCount).toBe(1);
  });

  it('accepts plain text only and validates the body; needs a session', async () => {
    const pending = await makeUser(db, { status: 'pending_assignment' });
    const api = await loggedIn(app, pending);
    const html = await api.call('post', '/me/notify-admins', { message: 'Hi <b>admin</b>' });
    expect(html.status).toBe(422);
    expect(html.body.errors[0]).toMatchObject({ path: '/message', code: 'markup_not_allowed' });
    expect((await api.call('post', '/me/notify-admins', { message: '&lt;script&gt;' })).status).toBe(422);
    expect((await api.call('post', '/me/notify-admins', { message: 'x'.repeat(501) })).status).toBe(422);
    expect((await api.call('post', '/me/notify-admins', { other: 1 })).status).toBe(422);
    expect((await db.query('SELECT 1 FROM me_admin_requests WHERE user_id = $1', [pending.id])).rowCount).toBe(0);
    expect((await new Api(app).call('post', '/me/notify-admins', {})).status).toBe(401);
  });
});

describe('POST /auth/employee-id', () => {
  it('answers the same 409 for a free, a used and an unknown ID (no enumeration), logs only a keyed hash, and is rate limited', async () => {
    const used = await makeUser(db, { assigned: true });
    const pending = await makeUser(db, { status: 'pending_assignment' });
    const api = await loggedIn(app, pending);
    const answers = [];
    for (const id of ['0000', used.employeeId, '8888']) {
      const r = await api.call('post', '/auth/employee-id', { employee_id: id });
      answers.push({ status: r.status, code: r.body.code, detail: r.body.detail, keys: Object.keys(r.body).filter((k) => k !== 'instance').sort() });
    }
    expect(answers[0]).toMatchObject({ status: 409, code: 'invalid_transition' });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    const bad = await api.call('post', '/auth/employee-id', { employee_id: '12a4' });
    expect(bad.status).toBe(422);
    const logs = await db.query("SELECT context::text AS c FROM system_log WHERE message = 'employee_id_link_refused' AND user_id = $1", [pending.id]);
    expect(logs.rowCount).toBe(3);
    expect(logs.rows.some((r) => String(r.c).includes(used.employeeId))).toBe(false);
    expect((await db.query('SELECT employee_id FROM users WHERE id = $1', [pending.id])).rows[0].employee_id).toBe(pending.employeeId);

    let last = 0;
    for (let i = 0; i < 4; i++) last = (await api.call('post', '/auth/employee-id', { employee_id: '0001' })).status;
    expect(last).toBe(429);
    expect((await new Api(app).call('post', '/auth/employee-id', { employee_id: '0001' })).status).toBe(401);
  });
});
