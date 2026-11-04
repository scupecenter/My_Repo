import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { base32Decode, hotp, stepOf } from '../src/auth/totp';
import { Api, adminApi, delegate, loggedIn, makeAdmin, makeUser, NEW_PASSWORD, startApp, superDb, TestUser } from './helpers';

// The self-service "My profile" page (contract 0.9.2, migration 0044, ADR 0014 amendment 2).
let app: NestExpressApplication;
let db: Pg;
const clock = { t: Date.UTC(2026, 10, 4, 9, 0, 0), now(): number { return this.t; } };
const tick = (steps = 1): void => { clock.t += steps * 30_000; };
const codeOf = (secret: string): string => hotp(base32Decode(secret), stepOf(clock.t));

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  app.get(TwoFactorService).setClock(clock);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const etagOf = async (api: Api): Promise<string> => {
  const r = await api.call('get', '/me/profile');
  expect(r.status).toBe(200);
  return r.headers.etag as string;
};
const audits = async (action: string, entity: string) =>
  (await db.query(`SELECT before, after, reason, actor_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id`, [action, entity])).rows;
const failedCount = async (id: string): Promise<number> => (await db.query('SELECT failed_count FROM local_credentials WHERE user_id = $1', [id])).rows[0].failed_count as number;
const totpRow = async (id: string) => (await db.query('SELECT required, enforced, secret_enc IS NOT NULL AS enrolled, failed_count FROM user_totp WHERE user_id = $1', [id])).rows[0];

describe('profile: self-editable and admin-owned fields', () => {
  it('reads the profile with the admin-owned data and an ETag', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const r = await api.call('get', '/me/profile');
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    expect(r.body).toMatchObject({
      id: u.id, display_name: u.name, email: u.email, employee_id: u.employeeId, phone: u.phone, local_sign_in: true, auth_method: 'local',
      editable_fields: ['display_name', 'locale', 'theme'],
      two_factor: { state: 'off', enforced: false, can_enable: true, can_disable: false }, email_change: null, phone_change: null,
    });
    expect(r.body.admin_owned.roles.length).toBe(1);
    expect(r.body.admin_owned.region_ids).toBe('all');
  });

  it('changes display name, language and theme with If-Match; audited once with before and after of what changed', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const etag = await etagOf(api);
    const r = await api.call('patch', '/me/profile', { display_name: '  Renamed Person ', locale: 'ar', theme: 'dark' }, { 'If-Match': etag });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ display_name: 'Renamed Person', phone: u.phone, locale: 'ar', theme: 'dark' });
    expect(r.headers.etag).not.toBe(etag);
    const a = await audits('profile_updated', u.id);
    expect(a).toHaveLength(1);
    expect(a[0].before).toEqual({ display_name: u.name, locale: 'en', theme: 'light' });
    expect(a[0].after).toMatchObject({ display_name: 'Renamed Person', locale: 'ar', theme: 'dark' });
    expect(a[0].actor_id).toBe(u.id);
    // the same values again change nothing and write no audit row
    const again = await api.call('patch', '/me/profile', { theme: 'dark' }, { 'If-Match': r.headers.etag as string });
    expect(again.status).toBe(200);
    expect(await audits('profile_updated', u.id)).toHaveLength(1);
  });

  it('needs If-Match (428) and a current one (412)', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await api.call('patch', '/me/profile', { display_name: 'X Y' })).status).toBe(428);
    expect((await api.call('patch', '/me/profile', { display_name: 'X Y' }, { 'If-Match': '"1"' })).status).toBe(412);
  });

  it('refuses admin-owned fields with 403 field_read_only, unknown keys and bad values with 422', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const etag = await etagOf(api);
    for (const body of [{ email: 'me@example.test' }, { phone: '+218912345678' }, { phone: null }, { employee_id: '1234' }, { status: 'active' }, { team: 'cw' }, { region_ids: [1] }, { roles: [] }, { display_name: 'Ok', department_id: null }]) {
      const r = await api.call('patch', '/me/profile', body, { 'If-Match': etag });
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.body.code).toBe('field_read_only');
    }
    const email = await api.call('patch', '/me/profile', { email: 'me@example.test' }, { 'If-Match': etag });
    expect(email.body.errors[0]).toMatchObject({ path: '/email', code: 'read_only' });
    expect((await api.call('patch', '/me/profile', { nickname: 'x' }, { 'If-Match': etag })).status).toBe(422);
    expect((await api.call('patch', '/me/profile', {}, { 'If-Match': etag })).status).toBe(422);
    // 0058 (D156): the phone changes only through a request
    const phone = await api.call('patch', '/me/profile', { phone: '0912345678' }, { 'If-Match': etag });
    expect(phone.status).toBe(403);
    expect(phone.body.errors[0]).toMatchObject({ path: '/phone', code: 'read_only' });
    expect(phone.body.errors[0].message).toMatch(/phone-change/);
    expect((await api.call('patch', '/me/profile', { display_name: '   ' }, { 'If-Match': etag })).status).toBe(422);
    expect((await api.call('patch', '/me/profile', { locale: 'fr' }, { 'If-Match': etag })).status).toBe(422);
    const row = await db.query('SELECT email, employee_id, status, phone FROM users WHERE id = $1', [u.id]);
    expect(row.rows[0]).toMatchObject({ email: u.email, employee_id: u.employeeId, status: 'active', phone: u.phone });
  });

  it('is not for a pending account or without a session', async () => {
    const p = await makeUser(db, { assigned: false });
    const api = await loggedIn(app, p);
    expect((await api.call('get', '/me/profile')).status).toBe(403);
    expect((await new Api(app).call('get', '/me/profile')).status).toBe(401);
  });
});

describe('email change: a request that an admin approves', () => {
  const freshEmail = (): string => `new.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.test`;

  it('needs the password; a wrong one is 401 and counts toward the lock', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const r = await api.call('post', '/me/email-change', { new_email: freshEmail(), password: 'wrong-password-123' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_credentials');
    expect(await failedCount(u.id)).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM email_change_requests WHERE user_id = $1', [u.id])).rows[0].n).toBe(0);
  });

  it('full lifecycle: pending, admins told, one at a time, cancel, request again, reject, approve; only an approval changes the email', async () => {
    const { admin, api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const first = freshEmail();
    const r = await api.call('post', '/me/email-change', { new_email: first.toUpperCase(), password: u.password });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ old_email: u.email, new_email: first, status: 'pending' });
    expect((await db.query('SELECT email FROM users WHERE id = $1', [u.id])).rows[0].email).toBe(u.email);
    const note = await db.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'email_change_requested' AND body LIKE $2`, [admin.id, `%${first}%`]);
    expect(note.rowCount).toBe(1);
    expect((await audits('email_change_requested', u.id))[0]).toMatchObject({ before: { email: u.email }, after: { requested_email: first } });
    expect((await api.call('get', '/me/profile')).body.email_change).toMatchObject({ status: 'pending', new_email: first });

    // one pending request per user
    expect((await api.call('post', '/me/email-change', { new_email: freshEmail(), password: u.password })).status).toBe(409);
    // cancel, then a new request
    expect((await api.call('delete', '/me/email-change')).status).toBe(204);
    expect((await api.call('delete', '/me/email-change')).status).toBe(404);
    expect((await audits('email_change_cancelled', u.id))).toHaveLength(1);
    const second = freshEmail();
    const r2 = await api.call('post', '/me/email-change', { new_email: second, password: u.password });
    expect(r2.status).toBe(201);

    // the admin lists it, rejects it (reason required, step-up done)
    const list = await adminCall.call('get', '/email-change-requests');
    expect(list.status).toBe(200);
    expect(list.body.items.find((x: { id: string }) => x.id === r2.body.id)).toMatchObject({ status: 'pending', user: { id: u.id } });
    expect((await adminCall.call('post', `/email-change-requests/${r2.body.id}/decide`, { decision: 'reject' })).status).toBe(422);
    const rej = await adminCall.call('post', `/email-change-requests/${r2.body.id}/decide`, { decision: 'reject', reason: 'Use the company domain' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decision_reason: 'Use the company domain', decided_by: { id: admin.id } });
    expect((await db.query('SELECT email FROM users WHERE id = $1', [u.id])).rows[0].email).toBe(u.email);
    const told = await db.query(`SELECT title FROM notifications WHERE user_id = $1 AND kind = 'email_change_decided'`, [u.id]);
    expect(told.rows.map((x) => x.title)).toEqual(['Your email change was rejected']);
    // decided already: 409
    expect((await adminCall.call('post', `/email-change-requests/${r2.body.id}/decide`, { decision: 'approve', reason: 'changed my mind' })).status).toBe(409);

    // a third request, approved: the login email changes and the user signs in with it
    const third = freshEmail();
    const r3 = await api.call('post', '/me/email-change', { new_email: third, password: u.password });
    // 0058 (Q158): unverified, so the admin records the documented identity check
    const ok = await adminCall.call('post', `/email-change-requests/${r3.body.id}/decide`, { decision: 'approve', reason: 'Verified by phone', identity_check: 'Called the user on the registered phone' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await db.query('SELECT email FROM users WHERE id = $1', [u.id])).rows[0].email).toBe(third);
    const a = await audits('email_changed', u.id);
    expect(a[0]).toMatchObject({ before: { email: u.email }, after: { email: third }, reason: 'Verified by phone', actor_id: admin.id });
    expect((await new Api(app).login(third, u.password)).status).toBe(200);
    expect((await new Api(app).login(u.email, u.password)).status).toBe(401);
  });

  it('keeps uniqueness: an address of another account or of another pending request is 409; the same address is 422', async () => {
    const a = await makeUser(db, { assigned: true });
    const b = await makeUser(db, { assigned: true });
    const c = await makeUser(db, { assigned: true });
    const aApi = await loggedIn(app, a);
    const taken = await aApi.call('post', '/me/email-change', { new_email: b.email, password: a.password });
    expect(taken.status).toBe(409);
    expect(taken.body.errors[0]).toMatchObject({ path: '/new_email', code: 'duplicate' });
    expect((await aApi.call('post', '/me/email-change', { new_email: a.email, password: a.password })).status).toBe(422);
    const wanted = freshEmail();
    expect((await aApi.call('post', '/me/email-change', { new_email: wanted, password: a.password })).status).toBe(201);
    const cApi = await loggedIn(app, c);
    expect((await cApi.call('post', '/me/email-change', { new_email: wanted, password: c.password })).status).toBe(409);
  });

  it('rights: a plain user cannot list or decide; nobody decides their own; a delegate decides for a plain user but not for an admin; step-up first', async () => {
    const { admin, api: adminCall } = await adminApi(app, db);
    const plain = await makeUser(db, { assigned: true });
    const pApi = await loggedIn(app, plain);
    await pApi.stepUp(plain.password);
    const req = await pApi.call('post', '/me/email-change', { new_email: freshEmail(), password: plain.password });
    expect(req.status).toBe(201);
    expect((await pApi.call('get', '/email-change-requests')).status).toBe(403);
    expect((await pApi.call('post', `/email-change-requests/${req.body.id}/decide`, { decision: 'approve', reason: 'self approve' })).status).toBe(403);

    // the admin asks for their own change and cannot approve it
    const own = await adminCall.call('post', '/me/email-change', { new_email: freshEmail(), password: admin.password });
    expect(own.status).toBe(201);
    const self = await adminCall.call('post', `/email-change-requests/${own.body.id}/decide`, { decision: 'approve', reason: 'my own' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');

    // a delegate holding users.edit for all regions: needs a step-up, then may decide the plain user's, not the admin's
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'edit']]);
    const dApi = await loggedIn(app, del);
    const noStep = await dApi.call('post', `/email-change-requests/${req.body.id}/decide`, { decision: 'reject', reason: 'not now' });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    await dApi.stepUp(del.password);
    expect((await dApi.call('post', `/email-change-requests/${own.body.id}/decide`, { decision: 'approve', reason: 'for the admin' })).status).toBe(403);
    const ok = await dApi.call('post', `/email-change-requests/${req.body.id}/decide`, { decision: 'reject', reason: 'not now' });
    expect(ok.status).toBe(200);
    const audit = await db.query(`SELECT on_behalf_of FROM audit_log WHERE action = 'email_change_rejected' AND entity_id = $1`, [plain.id]);
    expect(audit.rows[0].on_behalf_of).not.toBeNull();

    // a delegate limited to one region cannot decide (the change is global)
    const tri = await makeUser(db, { assigned: true });
    await delegate(db, tri.id, [['users', 'edit']], [1]);
    const tApi = await loggedIn(app, tri);
    await tApi.stepUp(tri.password);
    expect((await tApi.call('post', `/email-change-requests/${own.body.id}/decide`, { decision: 'reject', reason: 'regional' })).status).toBe(403);
    expect((await tApi.call('get', '/email-change-requests')).status).toBe(403);
  });
});

describe('password change from the profile', () => {
  it('wrong current password is 401 and counts; the policy is the sign-in policy (422 weak_password)', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const wrong = await api.call('post', '/me/password', { current_password: 'not-my-password-1', new_password: NEW_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(await failedCount(u.id)).toBe(1);
    const short = await api.call('post', '/me/password', { current_password: u.password, new_password: 'short' });
    expect(short.status).toBe(422);
    expect(short.body.code).toBe('weak_password');
    const withId = await api.call('post', '/me/password', { current_password: u.password, new_password: `Long-enough-${u.employeeId}-x` });
    expect(withId.body.errors.map((e: { code: string }) => e.code)).toContain('contains_employee_id');
    const same = await api.call('post', '/me/password', { current_password: u.password, new_password: u.password });
    expect(same.body.errors.map((e: { code: string }) => e.code)).toContain('same_as_current');
  });

  it('five wrong current passwords lock the account like sign-in', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    for (let i = 0; i < 5; i++) expect((await api.call('post', '/me/password', { current_password: `wrong-${i}-password`, new_password: NEW_PASSWORD })).status).toBe(401);
    const locked = await api.call('post', '/me/password', { current_password: u.password, new_password: NEW_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');
  });

  it('success ends the other sessions, keeps this one, and is audited', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const other = await loggedIn(app, u);
    const r = await api.call('post', '/me/password', { current_password: u.password, new_password: NEW_PASSWORD });
    expect(r.status).toBe(200);
    expect((await api.call('get', '/me/profile')).status).toBe(200);
    expect((await other.call('get', '/me/profile')).status).toBe(401);
    expect(await audits('password_changed', u.id)).toHaveLength(1);
    expect((await new Api(app).login(u.email, NEW_PASSWORD)).status).toBe(200);
  });
});

describe('two-factor self-service', () => {
  /** A user turns two-factor on from the profile. Returns the secret and the recovery codes. */
  async function selfEnrol(u: TestUser, api: Api): Promise<{ secret: string; codes: string[] }> {
    expect((await api.stepUp(u.password)).status).toBe(200);
    const start = await api.call('post', '/me/two-factor/enrol/start');
    expect(start.status).toBe(200);
    tick();
    const ok = await api.call('post', '/me/two-factor/enrol/confirm', { code: codeOf(start.body.secret as string) });
    expect(ok.status).toBe(200);
    return { secret: start.body.secret as string, codes: ok.body.recovery_codes as string[] };
  }

  it('turn on: needs a fresh step-up, no enrolment code; a wrong code counts; then on, not enforced, other sessions end, audited', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const other = await loggedIn(app, u);
    const noStep = await api.call('post', '/me/two-factor/enrol/start');
    expect(noStep.status).toBe(401);
    expect(noStep.body).toMatchObject({ code: 'step_up_required', step_up_method: 'password' });
    await api.stepUp(u.password);
    const start = await api.call('post', '/me/two-factor/enrol/start');
    expect(start.status).toBe(200);
    expect(start.headers['cache-control']).toMatch(/no-store/);
    expect(start.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await totpRow(u.id))).toMatchObject({ required: false, enrolled: false });
    // the QR code of this session cannot be confirmed from another session
    tick();
    expect((await other.call('post', '/me/two-factor/enrol/confirm', { code: codeOf(start.body.secret) })).status).toBe(409);
    const wrong = await api.call('post', '/me/two-factor/enrol/confirm', { code: '000000' === codeOf(start.body.secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_code');
    expect((await totpRow(u.id)).failed_count).toBe(1);
    const ok = await api.call('post', '/me/two-factor/enrol/confirm', { code: codeOf(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect(ok.body.two_factor).toMatchObject({ state: 'on', enforced: false, recovery_codes_remaining: 10, can_disable: true });
    expect(ok.body.other_sessions_ended).toBe(1);
    expect(await totpRow(u.id)).toMatchObject({ required: true, enforced: false, enrolled: true });
    expect((await api.call('get', '/auth/session')).body).toMatchObject({ mfa: true, two_factor: { enabled: true, enforced: false } });
    expect((await other.call('get', '/me/profile')).status).toBe(401);
    expect((await audits('two_factor_self_enabled', u.id))[0]).toMatchObject({ before: { two_factor: 'off' }, after: { two_factor: 'on', enforced: false }, actor_id: u.id });
    // the next sign-in asks for the code (the session guard of 0033 applies as before)
    const next = new Api(app);
    expect((await next.login(u.email, u.password)).body).toMatchObject({ authenticated: false, next: 'two_factor' });
    // and starting again is 409
    await api.stepUp(u.password, { code: (tick(), codeOf(start.body.secret)) });
    expect((await api.call('post', '/me/two-factor/enrol/start')).status).toBe(409);
  });

  it('turn off: the password and a code (or a recovery code); wrong ones are refused and counted; audited', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const { secret, codes } = await selfEnrol(u, api);
    tick();
    expect((await api.call('post', '/me/two-factor/disable', { password: u.password })).status).toBe(422);
    const badPw = await api.call('post', '/me/two-factor/disable', { password: 'wrong-password-99', code: codeOf(secret) });
    expect(badPw.status).toBe(401);
    expect(badPw.body.code).toBe('invalid_credentials');
    const badCode = await api.call('post', '/me/two-factor/disable', { password: u.password, code: '12345' });
    expect(badCode.status).toBe(401);
    expect(badCode.body.code).toBe('invalid_code');
    expect((await totpRow(u.id)).required).toBe(true);
    const off = await api.call('post', '/me/two-factor/disable', { password: u.password, recovery_code: codes[0] });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ state: 'off', enforced: false, can_enable: true });
    expect(await totpRow(u.id)).toMatchObject({ required: false, enrolled: false });
    expect((await db.query('SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1', [u.id])).rows[0].n).toBe(0);
    expect((await audits('two_factor_self_disabled', u.id))[0]).toMatchObject({ before: { two_factor: 'on' }, after: { two_factor: 'off' } });
    expect((await new Api(app).login(u.email, u.password)).body.authenticated).toBe(true);
    expect((await api.call('post', '/me/two-factor/disable', { password: u.password, code: '123456' })).status).toBe(409);
  });

  it('turn off is refused with 403 two_factor_enforced when an admin turned it on, and nothing is counted', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const on = await adminCall.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(on.status).toBe(200);
    const api = new Api(app);
    await api.login(u.email, u.password);
    const start = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: on.body.enrol_code });
    tick();
    const confirm = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: on.body.enrol_code });
    expect(confirm.status).toBe(200);
    api.adopt(confirm, confirm.body.session);
    expect(await totpRow(u.id)).toMatchObject({ required: true, enforced: true });
    const prof = await api.call('get', '/me/profile');
    expect(prof.body.two_factor).toMatchObject({ state: 'on', enforced: true, can_disable: false });
    const failsBefore = await failedCount(u.id);
    tick();
    const r = await api.call('post', '/me/two-factor/disable', { password: 'even-a-wrong-one', code: codeOf(start.body.secret) });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('two_factor_enforced');
    expect(await failedCount(u.id)).toBe(failsBefore);
    expect((await totpRow(u.id)).required).toBe(true);
    const listed = await adminCall.call('get', `/users/${u.id}`);
    expect(listed.body.two_factor_enforced).toBe(true);
  });

  it('admin enforce: unmark lets the user turn it off; mark on a self-enrolled user blocks it; admin "on" for a self-enrolled user enforces it', async () => {
    const { admin, api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const { secret } = await selfEnrol(u, api);
    // mark enforced (reason, step-up done), audited
    expect((await adminCall.call('put', `/users/${u.id}/two-factor/enforced`, { enforced: true })).status).toBe(422);
    const mark = await adminCall.call('put', `/users/${u.id}/two-factor/enforced`, { enforced: true, reason: 'Finance role' });
    expect(mark.status).toBe(200);
    expect(mark.body).toEqual({ two_factor: 'on', enforced: true });
    expect((await audits('two_factor_enforced', u.id))[0]).toMatchObject({ before: { enforced: false }, after: { enforced: true }, reason: 'Finance role', actor_id: admin.id });
    tick();
    expect((await api.call('post', '/me/two-factor/disable', { password: u.password, code: codeOf(secret) })).status).toBe(403);
    // unmark: the user may turn it off
    const unmark = await adminCall.call('put', `/users/${u.id}/two-factor/enforced`, { enforced: false, reason: 'Role ended' });
    expect(unmark.body.enforced).toBe(false);
    expect(await audits('two_factor_unenforced', u.id)).toHaveLength(1);
    tick();
    expect((await api.call('post', '/me/two-factor/disable', { password: u.password, code: codeOf(secret) })).status).toBe(200);

    // admin "on" for a user who is already on (self) marks it enforced, no new code
    const v = await makeUser(db, { assigned: true });
    const vApi = await loggedIn(app, v);
    await selfEnrol(v, vApi);
    const on = await adminCall.call('put', `/users/${v.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(on.body).toEqual({ two_factor: 'on' });
    expect((await totpRow(v.id)).enforced).toBe(true);
    // admin off clears it
    await adminCall.call('put', `/users/${v.id}/two-factor`, { enabled: false, reason: 'not needed' });
    expect(await totpRow(v.id)).toMatchObject({ required: false, enforced: false });
  });

  it('enforce rights: not for a plain user, not on oneself, not while two-factor is off (409), not without step-up', async () => {
    const admin = await makeAdmin(db);
    const aApi = await loggedIn(app, admin);
    const u = await makeUser(db, { assigned: true });
    const noStep = await aApi.call('put', `/users/${u.id}/two-factor/enforced`, { enforced: true, reason: 'policy' });
    expect(noStep.status).toBe(401);
    await aApi.stepUp(admin.password);
    expect((await aApi.call('put', `/users/${u.id}/two-factor/enforced`, { enforced: true, reason: 'policy' })).status).toBe(409);
    expect((await aApi.call('put', `/users/${admin.id}/two-factor/enforced`, { enforced: false, reason: 'myself' })).status).toBe(403);
    const plain = await makeUser(db, { assigned: true });
    const pApi = await loggedIn(app, plain);
    await pApi.stepUp(plain.password);
    expect((await pApi.call('put', `/users/${u.id}/two-factor/enforced`, { enforced: true, reason: 'policy' })).status).toBe(403);
  });
});
