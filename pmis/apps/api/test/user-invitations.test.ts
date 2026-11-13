import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MailService } from '../src/mail/mail.service';
import type { MailMessage } from '../src/mail/mail.service';
import { Api, adminApi, delegate, ensureRole, loggedIn, makeAdmin, makeUser, startApp, superDb } from './helpers';

// Decision 5 (migration 0091): invite a new user by email with role and properties chosen at invite time.
let app: NestExpressApplication;
let db: Pg;
let admin: Api;
const sent: { to: string; m: MailMessage }[] = [];

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  vi.spyOn(app.get(MailService), 'sendToAddress').mockImplementation(async (to: string, m: MailMessage) => { sent.push({ to, m }); return null; });
  admin = (await adminApi(app, db)).api;
});
afterAll(async () => {
  await app.close();
  await db.end();
});

let seq = 0;
const fresh = (): string => `inv.${Date.now().toString(36)}${seq++}${Math.random().toString(36).slice(2, 6)}@example.test`;
const STRONG = 'Violet-Harbor-Lantern-77';
const tokenOf = (to: string): string => {
  const m = [...sent].reverse().find((x) => x.to === to);
  const t = /\/invite\/([A-Za-z0-9_-]{43})/.exec(m?.m.text ?? '')?.[1];
  if (!t) throw new Error('no invitation mail for ' + to);
  return t;
};
const role = async (): Promise<string> => ensureRole(db, 'INV_ROLE');
const row = (roleId: string, over: Record<string, unknown> = {}) => ({ role_id: roleId, permission_level: 'entry', team: 'cw', all_regions: false, region_ids: [1, 2], all_modules: true, ...over });
const invite = (api: Api, email: string, over: Record<string, unknown> = {}) =>
  api.call('post', '/users/invitations', { email, display_name: 'Invited Person', reason: 'new engineer', ...over });
const pub = () => new Api(app);
const audits = async (action: string, entity: string) => (await db.query('SELECT actor_id, after FROM audit_log WHERE action = $1 AND entity_id = $2', [action, entity])).rows;

describe('inviting', () => {
  it('creates a pending invitation, mails a one-time link and audits it', async () => {
    const email = fresh();
    const r = await invite(admin, email, { assignments: [row(await role())], require_two_factor: false });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    expect(r.body.assignments).toHaveLength(1);
    expect(r.body.assignments[0].role.code).toBe('INV_ROLE');
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
    const mail = sent.find((x) => x.to === email)!;
    expect(mail.m.sensitive).toBe(true);
    expect(mail.m.text).toContain('{{app_url}}/invite/');
    expect((await audits('user_invited', r.body.id)).length).toBe(1);
    const stored = (await db.query('SELECT token_hash FROM user_invitations WHERE id = $1', [r.body.id])).rows[0].token_hash as string;
    expect(stored).toHaveLength(64);
    expect(stored).not.toContain(tokenOf(email));
  });

  it('refuses a person without the right (403), an anonymous call (401) and a duplicate email (409)', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await invite(api, fresh())).status).toBe(403);
    expect((await api.call('get', '/users/invitations')).status).toBe(403);
    expect((await invite(pub(), fresh())).status).toBe(401);
    const e = fresh();
    expect((await invite(admin, e)).status).toBe(201);
    const dup = await invite(admin, e);
    expect(dup.status).toBe(409);
    const used = await invite(admin, u.email);
    expect(used.status).toBe(409);
    expect(used.body.code).toBe('duplicate');
  });

  it('needs a region or all regions on every role row (422)', async () => {
    const r = await invite(admin, fresh(), { assignments: [row(await role(), { region_ids: [] })] });
    expect(r.status).toBe(422);
  });

  it('lists with a status filter and a cursor', async () => {
    const a = await admin.call('get', '/users/invitations?limit=1');
    expect(a.status).toBe(200);
    expect(a.body.items).toHaveLength(1);
    expect(a.body.page.next_cursor).toBeTruthy();
    const b = await admin.call('get', `/users/invitations?limit=1&cursor=${a.body.page.next_cursor}`);
    expect(b.status).toBe(200);
    expect(b.body.items[0].id).not.toBe(a.body.items[0].id);
    const p = await admin.call('get', '/users/invitations?status=pending');
    expect(p.body.items.every((i: { status: string }) => i.status === 'pending')).toBe(true);
  });
});

describe('the rights of the inviter', () => {
  it('a delegate cannot invite with admin level, a manager, a group or two-factor beyond the rights held', async () => {
    const d = await makeUser(db, { assigned: true });
    await delegate(db, d.id, [['users', 'create'], ['assignments', 'create']]);
    const api = await loggedIn(app, d);
    await api.stepUp(d.password);
    const roleId = await role();
    const adminLevel = await invite(api, fresh(), { assignments: [row(roleId, { permission_level: 'admin' })] });
    expect(adminLevel.status).toBe(403);
    const manager = await invite(api, fresh(), { manager_id: d.id });
    expect(manager.status).toBe(403);
    const tf = await invite(api, fresh(), { require_two_factor: true });
    expect(tf.status).toBe(403);
    const none = (await db.query('SELECT count(*)::int AS n FROM user_invitations WHERE invited_by = $1', [d.id])).rows[0].n;
    expect(none).toBe(0);
  });

  it('an invitation with admin level needs a fresh step-up, then works for a System Admin', async () => {
    const a2 = await makeAdmin(db);
    const api = await loggedIn(app, a2);
    const email = fresh();
    const body = { assignments: [row(await role(), { permission_level: 'admin', all_regions: true, region_ids: [] })] };
    const r1 = await invite(api, email, body);
    expect(r1.status).toBe(401);
    expect(r1.body.code).toBe('step_up_required');
    await api.stepUp(a2.password);
    const r2 = await invite(api, email, body);
    expect(r2.status).toBe(201);
    expect(r2.body.elevated).toBe(true);
  });
});

describe('accepting', () => {
  it('shows the entered data, creates the user with the assignments, works once only', async () => {
    const email = fresh();
    const roleId = await role();
    const created = await invite(admin, email, { employee_id: '7345', assignments: [row(roleId)], require_two_factor: true });
    expect(created.status).toBe(201);
    const token = tokenOf(email);
    const p = pub();
    const peek = await p.call('get', `/invitations/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.body).toMatchObject({ display_name: 'Invited Person', email, employee_id: '7345' });
    expect(peek.body.assignments).toBeUndefined();
    expect(peek.headers['cache-control']).toBe('no-store');

    const weak = await p.call('post', `/invitations/${token}/accept`, { password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('weak_password');
    const withId = await p.call('post', `/invitations/${token}/accept`, { password: 'Harbor-Lantern-7345-xx' });
    expect(withId.status).toBe(422);

    const ok = await p.call('post', `/invitations/${token}/accept`, { password: STRONG });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ created: true, two_factor_enrolment_pending: true });

    const u = (await db.query('SELECT id, status, employee_id FROM users WHERE email = $1', [email])).rows[0];
    expect(u.status).toBe('active');
    expect(u.employee_id).toBe('7345');
    const a = (await db.query('SELECT permission_level, team, all_regions, all_modules, is_primary FROM user_role_assignments WHERE user_id = $1', [u.id])).rows;
    expect(a).toEqual([{ permission_level: 'entry', team: 'cw', all_regions: false, all_modules: true, is_primary: true }]);
    const regions = (await db.query('SELECT region_id FROM user_role_assignment_regions r JOIN user_role_assignments a ON a.id = r.assignment_id WHERE a.user_id = $1 ORDER BY 1', [u.id])).rows;
    expect(regions.map((x) => x.region_id)).toEqual([1, 2]);
    const tf = (await db.query('SELECT required, enforced FROM user_totp WHERE user_id = $1', [u.id])).rows[0];
    expect(tf).toEqual({ required: true, enforced: true });
    expect((await audits('user_invitation_accepted', created.body.id)).length).toBe(1);
    expect((await audits('user_created_by_invitation', u.id)).length).toBe(1);

    // the password is the person's own and no change is forced
    const login = await pub().login(email, STRONG);
    expect(login.status).toBe(200);

    // single use: the same link now matches nothing
    expect((await p.call('post', `/invitations/${token}/accept`, { password: STRONG })).status).toBe(404);
    expect((await p.call('get', `/invitations/${token}`)).status).toBe(404);
    expect((await admin.call('get', '/users/invitations?q=' + encodeURIComponent(email))).body.items[0].status).toBe('accepted');
  });

  it('a person with no assignment rows is created as pending_assignment', async () => {
    const email = fresh();
    await invite(admin, email);
    const ok = await pub().call('post', `/invitations/${tokenOf(email)}/accept`, { password: STRONG });
    expect(ok.status).toBe(201);
    expect(ok.body.two_factor_enrolment_pending).toBe(false);
    expect((await db.query('SELECT status FROM users WHERE email = $1', [email])).rows[0].status).toBe('pending_assignment');
  });

  it('an expired invitation does not work, reads expired, and can be sent again', async () => {
    const email = fresh();
    const c = await invite(admin, email);
    const old = tokenOf(email);
    await db.query(`UPDATE user_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c.body.id]);
    expect((await pub().call('get', `/invitations/${old}`)).status).toBe(404);
    expect((await pub().call('post', `/invitations/${old}/accept`, { password: STRONG })).status).toBe(404);
    const listed = (await admin.call('get', '/users/invitations?q=' + encodeURIComponent(email))).body.items[0];
    expect(listed.status).toBe('expired');
    const again = await admin.call('post', `/users/invitations/${c.body.id}/resend`, { reason: 'try again' });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('pending');
    expect(again.body.send_count).toBe(2);
    const fresh1 = tokenOf(email);
    expect(fresh1).not.toBe(old);
    expect((await pub().call('get', `/invitations/${old}`)).status).toBe(404);
    expect((await pub().call('get', `/invitations/${fresh1}`)).status).toBe(200);
  });

  it('a revoked invitation stops working; revoking twice is 409; accepted cannot be resent', async () => {
    const email = fresh();
    const c = await invite(admin, email);
    const token = tokenOf(email);
    const r = await admin.call('post', `/users/invitations/${c.body.id}/revoke`, { reason: 'wrong person' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('revoked');
    expect((await pub().call('get', `/invitations/${token}`)).status).toBe(404);
    expect((await admin.call('post', `/users/invitations/${c.body.id}/revoke`, { reason: 'again' })).status).toBe(409);
    expect((await admin.call('post', `/users/invitations/${c.body.id}/resend`, { reason: 'again' })).status).toBe(409);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await api.call('post', `/users/invitations/${c.body.id}/revoke`, { reason: 'nope nope' })).status).toBe(403);
  });

  it('a link made by a sender who lost the rights is closed on use (nothing is created)', async () => {
    const email = fresh();
    const a2 = await makeAdmin(db);
    const api = await loggedIn(app, a2);
    await api.stepUp(a2.password);
    await invite(api, email, { assignments: [row(await role(), { permission_level: 'admin', all_regions: true, region_ids: [] })] });
    const token = tokenOf(email);
    await db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [a2.id]);
    expect((await pub().call('post', `/invitations/${token}/accept`, { password: STRONG })).status).toBe(404);
    expect((await db.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount).toBe(0);
  });
});

describe('the public routes', () => {
  it('answer every bad link the same way and rate limit the failures', async () => {
    const p = pub();
    const bad = ['x', 'A'.repeat(43), 'a'.repeat(200), '%00', 'A'.repeat(42) + '-'];
    const answers = [];
    for (const t of bad) {
      const r = await p.call('get', `/invitations/${t}`);
      answers.push({ status: r.status, code: r.body.code, detail: r.body.detail, title: r.body.title });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]!.status).toBe(404);
    expect(answers[0]!.code).toBe('invitation_invalid');
    let last = 404;
    for (let i = 0; i < 15 && last === 404; i++) last = (await p.call('post', `/invitations/${'B'.repeat(43)}/accept`, { password: STRONG })).status;
    expect(last).toBe(429);
  });
});
