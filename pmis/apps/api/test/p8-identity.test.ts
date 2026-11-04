import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { base32Decode, hotp, stepOf } from '../src/auth/totp';
import type { MailMessage } from '../src/mail/mail.port';
import { MailPort } from '../src/mail/mail.port';
import { Api, adminApi, delegate, loggedIn, makeProfile, makeRole, makeUser, startApp, superDb, TestUser } from './helpers';

// Work package P8 (migration 0058, contract 0.12.6): phone change by request (D156), the verified new email (Q158), sessions after
// two-factor off (Q161) and the assignment overlap by region and module (Q18).
let app: NestExpressApplication;
let db: Pg;
let sent: MailMessage[] = [];
const clock = { t: Date.UTC(2026, 10, 4, 9, 0, 0), now(): number { return this.t; } };
const tick = (steps = 1): void => { clock.t += steps * 30_000; };
const codeOf = (secret: string): string => hotp(base32Decode(secret), stepOf(clock.t));

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  app.get(TwoFactorService).setClock(clock);
  // the no-op mail provider of the tests: record what would be sent
  vi.spyOn(app.get(MailPort), 'send').mockImplementation(async (m: MailMessage) => { sent.push(m); });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const audits = async (action: string, entity: string) =>
  (await db.query(`SELECT before, after, reason, actor_id, on_behalf_of FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id`, [action, entity])).rows;
const phoneOf = async (id: string): Promise<string | null> => (await db.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone as string | null;
const failedCount = async (id: string): Promise<number> => (await db.query('SELECT failed_count FROM local_credentials WHERE user_id = $1', [id])).rows[0].failed_count as number;
const mailsTo = (addr: string): MailMessage[] => sent.filter((m) => m.to.includes(addr));
const codeIn = (m: MailMessage | undefined): string => /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(m?.text ?? '')?.[1] ?? '';
let seq = 0;
const freshPhone = (): string => `+21894${String((Date.now() * 7 + seq++ * 7919) % 10_000_000).padStart(7, '0')}`;
const freshEmail = (): string => `p8.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.test`;

describe('phone change: a request that an admin approves (D156)', () => {
  it('PATCH /me/profile no longer changes the phone (403 field_read_only)', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const etag = (await api.call('get', '/me/profile')).headers.etag as string;
    const r = await api.call('patch', '/me/profile', { phone: freshPhone() }, { 'If-Match': etag });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('field_read_only');
    expect(await phoneOf(u.id)).toBe(u.phone);
  });

  it('needs the password; a wrong one is 401 and counts toward the lock', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const r = await api.call('post', '/me/phone-change', { new_phone: freshPhone(), password: 'wrong-password-123' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_credentials');
    expect(await failedCount(u.id)).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM phone_change_requests WHERE user_id = $1', [u.id])).rows[0].n).toBe(0);
  });

  it('full lifecycle: pending, deciders told, one at a time, cancel, reject, approve; only an approval changes the phone; audited; user told', async () => {
    const { admin, api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const first = freshPhone();
    const r = await api.call('post', '/me/phone-change', { new_phone: first, password: u.password });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ old_phone: u.phone, new_phone: first, status: 'pending', decided_at: null });
    expect(await phoneOf(u.id)).toBe(u.phone);
    const note = await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'phone_change_requested' AND body LIKE $2`, [admin.id, `%${first}%`]);
    expect(note.rowCount).toBe(1);
    expect((await audits('phone_change_requested', u.id))[0]).toMatchObject({ before: { phone: u.phone }, after: { requested_phone: first, status: 'pending' }, actor_id: u.id });
    expect((await api.call('get', '/me/profile')).body.phone_change).toMatchObject({ status: 'pending', new_phone: first });
    expect(mailsTo(u.email).some((m) => m.category === 'phone_change')).toBe(true);

    // one pending request per user; cancel; cancel again is 404
    expect((await api.call('post', '/me/phone-change', { new_phone: freshPhone(), password: u.password })).status).toBe(409);
    expect((await api.call('delete', '/me/phone-change')).status).toBe(204);
    expect((await api.call('delete', '/me/phone-change')).status).toBe(404);
    expect(await audits('phone_change_cancelled', u.id)).toHaveLength(1);

    // a second one, rejected with a reason
    const r2 = await api.call('post', '/me/phone-change', { new_phone: freshPhone(), password: u.password });
    expect(r2.status).toBe(201);
    const list = await adminCall.call('get', '/phone-change-requests');
    expect(list.status).toBe(200);
    expect(list.body.items.find((x: { id: string }) => x.id === r2.body.id)).toMatchObject({ status: 'pending', user: { id: u.id } });
    expect((await adminCall.call('post', `/phone-change-requests/${r2.body.id}/decide`, { decision: 'reject' })).status).toBe(422);
    const rej = await adminCall.call('post', `/phone-change-requests/${r2.body.id}/decide`, { decision: 'reject', reason: 'Not your number' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decision_reason: 'Not your number', decided_by: { id: admin.id } });
    expect(await phoneOf(u.id)).toBe(u.phone);
    expect((await db.query(`SELECT title FROM notifications WHERE user_id = $1 AND kind = 'phone_change_decided'`, [u.id])).rows.map((x) => x.title))
      .toEqual(['Your phone change was rejected']);
    expect((await adminCall.call('post', `/phone-change-requests/${r2.body.id}/decide`, { decision: 'approve', reason: 'changed my mind' })).status).toBe(409);

    // a third one, approved: the phone changes and the user signs in with it
    const third = freshPhone();
    const r3 = await api.call('post', '/me/phone-change', { new_phone: third, password: u.password });
    const ok = await adminCall.call('post', `/phone-change-requests/${r3.body.id}/decide`, { decision: 'approve', reason: 'Confirmed in person' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(await phoneOf(u.id)).toBe(third);
    expect((await audits('phone_changed', u.id))[0]).toMatchObject({ before: { phone: u.phone }, after: { phone: third }, reason: 'Confirmed in person', actor_id: admin.id, on_behalf_of: null });
    expect((await new Api(app).login(third, u.password)).status).toBe(200);
    expect((await new Api(app).login(u.phone, u.password)).status).toBe(401);
    expect(mailsTo(u.email).filter((m) => m.category === 'phone_change').length).toBeGreaterThanOrEqual(3);
  });

  it('keeps uniqueness: another account\'s phone or another pending request is 409; the current phone and a bad form are 422; null removes the phone', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const a = await makeUser(db, { assigned: true });
    const b = await makeUser(db, { assigned: true });
    const c = await makeUser(db, { assigned: true });
    const aApi = await loggedIn(app, a);
    const taken = await aApi.call('post', '/me/phone-change', { new_phone: b.phone, password: a.password });
    expect(taken.status).toBe(409);
    expect(taken.body.errors[0]).toMatchObject({ path: '/new_phone', code: 'duplicate' });
    const same = await aApi.call('post', '/me/phone-change', { new_phone: a.phone, password: a.password });
    expect(same.status).toBe(422);
    expect(same.body.errors[0]).toMatchObject({ path: '/new_phone', code: 'same_as_current' });
    expect((await aApi.call('post', '/me/phone-change', { new_phone: '0912345678', password: a.password })).status).toBe(422);
    const wanted = freshPhone();
    expect((await aApi.call('post', '/me/phone-change', { new_phone: wanted, password: a.password })).status).toBe(201);
    const cApi = await loggedIn(app, c);
    expect((await cApi.call('post', '/me/phone-change', { new_phone: wanted, password: c.password })).status).toBe(409);
    // null: remove the phone
    const rm = await cApi.call('post', '/me/phone-change', { new_phone: null, password: c.password });
    expect(rm.status).toBe(201);
    expect(rm.body.new_phone).toBeNull();
    expect((await adminCall.call('post', `/phone-change-requests/${rm.body.id}/decide`, { decision: 'approve', reason: 'Lost the SIM' })).status).toBe(200);
    expect(await phoneOf(c.id)).toBeNull();
    // the number is taken directly by an admin before the decision: the approval checks again (409)
    await db.query('UPDATE users SET phone = $1 WHERE id = $2', [wanted, b.id]);
    const pend = (await adminCall.call('get', '/phone-change-requests')).body.items.find((x: { user: { id: string } }) => x.user.id === a.id);
    expect((await adminCall.call('post', `/phone-change-requests/${pend.id}/decide`, { decision: 'approve', reason: 'Approve it' })).status).toBe(409);
  });

  it('rights: a plain user cannot list or decide; nobody decides their own; a delegate decides for a plain user but not for an admin; step-up first', async () => {
    const { admin, api: adminCall } = await adminApi(app, db);
    const plain = await makeUser(db, { assigned: true });
    const pApi = await loggedIn(app, plain);
    await pApi.stepUp(plain.password);
    const req = await pApi.call('post', '/me/phone-change', { new_phone: freshPhone(), password: plain.password });
    expect(req.status).toBe(201);
    expect((await pApi.call('get', '/phone-change-requests')).status).toBe(403);
    expect((await pApi.call('post', `/phone-change-requests/${req.body.id}/decide`, { decision: 'approve', reason: 'self approve' })).status).toBe(403);

    const own = await adminCall.call('post', '/me/phone-change', { new_phone: freshPhone(), password: admin.password });
    expect(own.status).toBe(201);
    const self = await adminCall.call('post', `/phone-change-requests/${own.body.id}/decide`, { decision: 'approve', reason: 'my own' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');

    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'edit']]);
    const dApi = await loggedIn(app, del);
    const noStep = await dApi.call('post', `/phone-change-requests/${req.body.id}/decide`, { decision: 'reject', reason: 'not now' });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    await dApi.stepUp(del.password);
    expect((await dApi.call('post', `/phone-change-requests/${own.body.id}/decide`, { decision: 'approve', reason: 'for the admin' })).status).toBe(403);
    const ok = await dApi.call('post', `/phone-change-requests/${req.body.id}/decide`, { decision: 'approve', reason: 'Confirmed' });
    expect(ok.status).toBe(200);
    expect((await audits('phone_changed', plain.id))[0].on_behalf_of).not.toBeNull();

    const tri = await makeUser(db, { assigned: true });
    await delegate(db, tri.id, [['users', 'edit']], [1]);
    const tApi = await loggedIn(app, tri);
    await tApi.stepUp(tri.password);
    expect((await tApi.call('get', '/phone-change-requests')).status).toBe(403);
    expect((await tApi.call('post', `/phone-change-requests/${own.body.id}/decide`, { decision: 'reject', reason: 'regional' })).status).toBe(403);
  });
});

describe('email change: the new address is verified before an approval (Q158)', () => {
  it('mails a code to the new address and a notice to the old one; approval needs the code or a documented identity check', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const target = freshEmail();
    const r = await api.call('post', '/me/email-change', { new_email: target, password: u.password });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', verified_at: null, verified_via: null });
    expect(r.body.verify_expires_at).not.toBeNull();
    const toNew = mailsTo(target);
    expect(toNew.map((m) => m.category)).toEqual(['email_change_verification']);
    expect(mailsTo(u.email).some((m) => m.category === 'security_notice')).toBe(true);
    const code = codeIn(toNew[0]);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // the code is never stored in clear
    const stored = await db.query('SELECT verify_hash FROM email_change_requests WHERE id = $1', [r.body.id]);
    expect(stored.rows[0].verify_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows[0])).not.toContain(code.replace('-', ''));

    // not verified: approve without an identity check is 409 email_not_verified
    const early = await adminCall.call('post', `/email-change-requests/${r.body.id}/decide`, { decision: 'approve', reason: 'Looks fine' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('email_not_verified');
    expect((await db.query('SELECT email FROM users WHERE id = $1', [u.id])).rows[0].email).toBe(u.email);

    // a wrong code is counted and the count is kept
    const bad = await api.call('post', '/me/email-change/verify', { code: 'AAAA-AAAA' === code ? 'BBBB-BBBB' : 'AAAA-AAAA' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_code');
    expect((await db.query('SELECT verify_attempts FROM email_change_requests WHERE id = $1', [r.body.id])).rows[0].verify_attempts).toBe(1);
    const good = await api.call('post', '/me/email-change/verify', { code: code.toLowerCase() });
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ verified_via: 'code' });
    expect(good.body.verified_at).not.toBeNull();
    expect(await audits('email_change_verified', u.id)).toHaveLength(1);

    sent = [];
    const ok = await adminCall.call('post', `/email-change-requests/${r.body.id}/decide`, { decision: 'approve', reason: 'Address confirmed' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', verified_via: 'code', identity_check: null });
    expect((await audits('email_changed', u.id))[0].after).toMatchObject({ email: target, verified_via: 'code' });
    // both addresses are told; no reason in the mail
    expect(mailsTo(u.email).some((m) => m.category === 'email_change_decided')).toBe(true);
    expect(mailsTo(target).some((m) => m.category === 'email_change_decided')).toBe(true);
    expect(sent.every((m) => !m.text.includes('Address confirmed'))).toBe(true);
  });

  it('five wrong codes spend the code; a new code works and the old one stops; the documented identity check approves an unverified one', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const target = freshEmail();
    const r = await api.call('post', '/me/email-change', { new_email: target, password: u.password });
    const first = codeIn(mailsTo(target)[0]);
    for (let i = 0; i < 5; i++) expect((await api.call('post', '/me/email-change/verify', { code: 'ZZZZ-ZZZ0' })).status).toBe(422);
    const spent = await api.call('post', '/me/email-change/verify', { code: first });
    expect(spent.status).toBe(422);
    expect(spent.body.errors[0].code).toBe('locked');
    const again = await api.call('post', '/me/email-change/resend');
    expect(again.status).toBe(200);
    const second = codeIn(mailsTo(target).at(-1));
    expect(second).not.toBe(first);
    expect((await api.call('post', '/me/email-change/verify', { code: first })).status).toBe(422);
    expect((await api.call('post', '/me/email-change/verify', { code: second })).status).toBe(200);
    expect((await api.call('post', '/me/email-change/resend')).status).toBe(409);
    await api.call('delete', '/me/email-change');

    // mail unavailable: the admin records the identity check (stored and audited)
    const other = freshEmail();
    const r2 = await api.call('post', '/me/email-change', { new_email: other, password: u.password });
    expect(r2.status).toBe(201);
    const ok = await adminCall.call('post', `/email-change-requests/${r2.body.id}/decide`,
      { decision: 'approve', reason: 'Approved', identity_check: 'Called the user on the registered phone and read back the address' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ verified_via: 'admin_check', identity_check: 'Called the user on the registered phone and read back the address' });
    expect((await audits('email_changed', u.id))[0].after).toMatchObject({ verified_via: 'admin_check' });
    void r;
  });
});

describe('two-factor off ends the other sessions (Q161)', () => {
  it('self disable: the other sessions end, this one stays; a security notice and a mail; audited with the count', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    await api.stepUp(u.password);
    const start = await api.call('post', '/me/two-factor/enrol/start');
    tick();
    const on = await api.call('post', '/me/two-factor/enrol/confirm', { code: codeOf(start.body.secret) });
    expect(on.status).toBe(200);
    // a second session: password and code
    const other = new Api(app);
    await other.login(u.email, u.password);
    tick();
    const two = await other.pendingCall('/auth/local/2fa', { code: codeOf(start.body.secret) });
    expect(two.status).toBe(200);
    other.adopt(two, two.body);
    expect((await other.call('get', '/me/profile')).status).toBe(200);
    tick();
    const off = await api.call('post', '/me/two-factor/disable', { password: u.password, code: codeOf(start.body.secret) });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ state: 'off' });
    expect((await api.call('get', '/me/profile')).status).toBe(200);
    expect((await other.call('get', '/me/profile')).status).toBe(401);
    expect((await audits('two_factor_self_disabled', u.id))[0].after).toMatchObject({ sessions_ended: 1, recovery_codes_remaining: 0 });
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'security_notice'`, [u.id])).rowCount).toBe(1);
    expect(mailsTo(u.email).some((m) => m.category === 'security_notice')).toBe(true);
    const rev = await db.query(`SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND revoke_reason = 'two_factor_disabled'`, [u.id]);
    expect(rev.rows[0].n).toBe(1);
  });

  it('admin off: all the user\'s sessions end and the user gets a security notice', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    await api.stepUp(u.password);
    const start = await api.call('post', '/me/two-factor/enrol/start');
    tick();
    expect((await api.call('post', '/me/two-factor/enrol/confirm', { code: codeOf(start.body.secret) })).status).toBe(200);
    const off = await adminCall.call('put', `/users/${u.id}/two-factor`, { enabled: false, reason: 'Phone replaced' });
    expect(off.status).toBe(200);
    expect((await api.call('get', '/me/profile')).status).toBe(401);
    expect((await audits('two_factor_disabled', u.id))[0].after).toMatchObject({ sessions_ended: 1 });
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'security_notice'`, [u.id])).rowCount).toBe(1);
    expect(mailsTo(u.email).some((m) => m.category === 'security_notice')).toBe(true);
  });
});

describe('assignment overlap compares regions and modules (Q18)', () => {
  interface Setup { profile: string; role: string; api: Api }
  async function setup(): Promise<Setup> {
    const profile = await makeProfile(db, [['sites', 'view'], ['warehouse', 'view']]);
    const role = await makeRole(db, { profile });
    return { profile, role, api: (await adminApi(app, db)).api };
  }
  const assign = (s: Setup, users: TestUser[], regions: number[] | 'all', modules: string[] | 'all') =>
    s.api.call('post', '/assignments/bulk-assign', {
      user_ids: users.map((u) => u.id), role_ids: [s.role],
      defaults: { permission_level: 'entry', region_ids: regions, module_keys: modules, profile_ids: [s.profile] }, reason: 'Q18 overlap',
    });

  it('bulk-assign: another region or another module is a separate row; a shared region and module is skipped with the conflicting rows', async () => {
    const s = await setup();
    const u = await makeUser(db, { assigned: false });
    const a = await assign(s, [u], [1], ['sites']);
    expect(a.body.done).toHaveLength(1);
    const idA = a.body.done[0].created_id as string;
    const b = await assign(s, [u], [2], ['sites']);
    expect(b.body.done).toHaveLength(1);
    const idB = b.body.done[0].created_id as string;
    const c = await assign(s, [u], [1], ['warehouse']);
    expect(c.body.done).toHaveLength(1);
    const clash = await assign(s, [u], [1, 3], ['sites']);
    expect(clash.body.done).toHaveLength(0);
    expect(clash.body.skipped).toEqual([expect.objectContaining({ ref: `${u.id}:${s.role}`, code: 'already_assigned', conflicts: [idA] })]);
    const all = await assign(s, [u], 'all', ['sites']);
    expect(all.body.skipped[0].conflicts.sort()).toEqual([idA, idB].sort());
    const allModules = await assign(s, [u], [3], 'all');
    expect(allModules.body.done).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int AS n FROM user_role_assignments WHERE user_id = $1 AND role_id = $2', [u.id, s.role])).rows[0].n).toBe(4);
  });

  it('bulk-update: moving a row onto the region and module of another row of the same role fails with the conflict', async () => {
    const s = await setup();
    const u = await makeUser(db, { assigned: false });
    const a = await assign(s, [u], [1], ['sites']);
    await assign(s, [u], [2], ['sites']);
    const rows = (await s.api.call('get', `/users/${u.id}/assignments`)).body.items as { id: string; version: number; region_ids: number[] }[];
    const rowB = rows.find((r) => Array.isArray(r.region_ids) && r.region_ids[0] === 2)!;
    const bad = await s.api.call('post', '/assignments/bulk-update', { items: [{ id: rowB.id, version: rowB.version }], patch: { region_ids: [1, 2] }, reason: 'widen' });
    expect(bad.status).toBe(200);
    expect(bad.body.failed).toEqual([expect.objectContaining({ ref: rowB.id, code: 'already_assigned', conflicts: [a.body.done[0].created_id] })]);
    const fine = await s.api.call('post', '/assignments/bulk-update', { items: [{ id: rowB.id, version: rowB.version }], patch: { region_ids: [2, 4] }, reason: 'widen' });
    expect(fine.body.done).toHaveLength(1);
  });

  it('copy: a target holding the role in another region gets the row; one holding the same region and module is skipped', async () => {
    const s = await setup();
    const from = await makeUser(db, { assigned: false });
    await assign(s, [from], [1], ['sites']);
    const elsewhere = await makeUser(db, { assigned: false });
    await assign(s, [elsewhere], [5], ['sites']);
    const same = await makeUser(db, { assigned: false });
    const held = await assign(s, [same], [1], ['sites', 'warehouse']);
    const r = await s.api.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [elsewhere.id, same.id], mode: 'add', reason: 'copy Q18', dry_run: false });
    expect(r.status).toBe(200);
    expect(r.body.done).toHaveLength(1);
    expect(r.body.skipped).toEqual([expect.objectContaining({ ref: `${same.id}:${s.role}`, code: 'already_assigned', conflicts: [held.body.done[0].created_id] })]);
  });
});

describe('P8 mails go through the P9 mail outbox (MailPort bound to OutboxMail)', () => {
  it('the verification code is queued as a sensitive identity mail to the new address, the notice to the old one; a rolled-back request queues nothing', async () => {
    vi.mocked(app.get(MailPort).send).mockRestore();
    try {
      const u = await makeUser(db, { assigned: true });
      const api = await loggedIn(app, u);
      const target = freshEmail();
      expect((await api.call('post', '/me/email-change', { new_email: target, password: u.password })).status).toBe(201);
      const rows = async (addr: string) =>
        (await db.query(`SELECT kind, sensitive FROM mail_outbox WHERE to_address = $1 ORDER BY created_at`, [addr])).rows as { kind: string; sensitive: boolean }[];
      expect(await rows(target)).toEqual([{ kind: 'identity.email_change_verification', sensitive: true }]);
      expect((await rows(u.email.toLowerCase())).some((m) => m.kind === 'identity.security_notice' && !m.sensitive)).toBe(true);
      // a wrong password fails the request: no new mail row for another address
      const other = freshEmail();
      expect((await api.call('post', '/me/email-change', { new_email: other, password: 'Wrong-Password-1' })).status).not.toBe(201);
      expect(await rows(other)).toEqual([]);
    } finally {
      vi.spyOn(app.get(MailPort), 'send').mockImplementation(async (m: MailMessage) => { sent.push(m); });
    }
  });
});
