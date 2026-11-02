import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { base32Decode, hotp, stepOf, totpCode } from '../src/auth/totp';
import { Api, adminApi, delegate, grantProfile, loggedIn, makeAdmin, makeUser, startApp, superDb, TestUser } from './helpers';

let app: NestExpressApplication;
let db: Pg;
let limiter: RateLimiter;
const clock = { t: Date.UTC(2026, 10, 3, 10, 0, 0), now(): number { return this.t; } };
const tick = (steps = 1): void => { clock.t += steps * 30_000; };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  limiter = app.get(RateLimiter);
  app.get(TwoFactorService).setClock(clock);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const codeOf = (secret: string, offsetSteps = 0): string => hotp(base32Decode(secret), stepOf(clock.t) + offsetSteps);
const state = async (id: string): Promise<{ required: boolean; secret_enc: string | null; pending: string | null; n: number }> => {
  const r = await db.query(`SELECT required, secret_enc, pending_secret_enc AS pending, (SELECT count(*)::int FROM user_recovery_codes c WHERE c.user_id = t.user_id) AS n FROM user_totp t WHERE user_id = $1`, [id]);
  return r.rows[0] ?? { required: false, secret_enc: null, pending: null, n: 0 };
};

/** An admin turns two-factor on for a user and gets the one-time enrolment code. */
const turnOn = async (admin: Api, id: string, reason = 'policy'): Promise<string> => {
  const r = await admin.call('put', `/users/${id}/two-factor`, { enabled: true, reason });
  expect(r.status).toBe(200);
  expect(r.body.enrol_code).toMatch(ENROL_CODE_RE);
  return r.body.enrol_code as string;
};
const ENROL_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

interface Enrolled { user: TestUser; api: Api; secret: string; codes: string[] }

/** An admin turns two-factor on for a fresh user, who enrols at the next sign-in. Returns the user signed in. */
async function enrolledUser(admin: Api, over: Partial<{ assigned: boolean }> = {}): Promise<Enrolled> {
  const user = await makeUser(db, { assigned: over.assigned ?? true });
  const enrolCode = await turnOn(admin, user.id);
  const api = new Api(app);
  const login = await api.login(user.email, user.password);
  expect(login.body).toMatchObject({ authenticated: false, next: 'enrol' });
  const start = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode });
  expect(start.status).toBe(200);
  const secret = start.body.secret as string;
  tick();
  const confirm = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(secret), enrol_code: enrolCode });
  expect(confirm.status).toBe(200);
  api.adopt(confirm, confirm.body.session);
  return { user, api, secret, codes: confirm.body.recovery_codes as string[] };
}

/** Password, then (one step later) the code at `offset` steps from now, or the given recovery code. Returns the api and the answers. */
async function signIn(e: Pick<Enrolled, 'user' | 'secret'>, opt: { offset?: number; recovery_code?: string; code?: string } = {}) {
  const api = new Api(app);
  const login = await api.login(e.user.email, e.user.password);
  tick();
  const body = opt.recovery_code !== undefined ? { recovery_code: opt.recovery_code } : { code: opt.code ?? codeOf(e.secret, opt.offset ?? 0) };
  const res = await api.pendingCall('/auth/local/2fa', body);
  if (res.status === 200) api.adopt(res, res.body);
  return { api, login, res };
}

describe('turning two-factor on: only an admin, with a reason and step-up', () => {
  it('an admin turns it on (pending enrolment), audited with before and after, and the badge shows on the user', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const before = await admin.call('get', `/users/${u.id}`);
    expect(before.body.two_factor).toBe('off');
    const res = await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'Finance accounts' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ two_factor: 'pending_enrolment', enrol_code: expect.stringMatching(ENROL_CODE_RE), enrol_code_expires_at: expect.any(String) });
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const after = await admin.call('get', `/users/${u.id}`);
    expect(after.body.two_factor).toBe('pending_enrolment');
    const list = await admin.call('get', `/users?q=${encodeURIComponent(u.email)}`);
    expect(list.body.items[0].two_factor).toBe('pending_enrolment');
    const audit = await db.query(`SELECT before, after, reason, actor_id FROM audit_log WHERE action = 'two_factor_enabled' AND entity_id = $1`, [u.id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].before).toMatchObject({ two_factor: 'off' });
    expect(audit.rows[0].after).toMatchObject({ two_factor: 'pending_enrolment' });
    expect(audit.rows[0].reason).toBe('Finance accounts');
  });

  it('needs a reason and the admin step-up', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const u = await makeUser(db, { assigned: true });
    const noStep = await api.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect(noStep.body.step_up_method).toBe('password');
    await api.stepUp(admin.password);
    const noReason = await api.call('put', `/users/${u.id}/two-factor`, { enabled: true });
    expect(noReason.status).toBe(422);
    const shortReason = await api.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'x' });
    expect(shortReason.status).toBe(422);
    expect((await state(u.id)).required).toBe(false);
  });

  it('a user without admin rights cannot turn it on or off or reset it (403), and not unauthenticated (401)', async () => {
    const { api: admin } = await adminApi(app, db);
    const target = await makeUser(db, { assigned: true });
    await admin.call('put', `/users/${target.id}/two-factor`, { enabled: true, reason: 'policy' });
    const plain = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    await api.stepUp(plain.password);
    expect((await api.call('put', `/users/${target.id}/two-factor`, { enabled: false, reason: 'let me in' })).status).toBe(403);
    expect((await api.call('post', `/users/${target.id}/two-factor/reset`, { reason: 'let me in' })).status).toBe(403);
    expect((await state(target.id)).required).toBe(true);
    expect((await new Api(app).call('put', `/users/${target.id}/two-factor`, { enabled: false, reason: 'anonymous' })).status).toBe(401);
    expect((await new Api(app).call('post', `/users/${target.id}/two-factor/reset`, { reason: 'anonymous' })).status).toBe(401);
  });

  it('a user with users.edit only (not the two-factor grant) is refused; with the grant they may, but not for an admin', async () => {
    const { api: admin } = await adminApi(app, db);
    const target = await makeUser(db, { assigned: true });
    const editor = await makeUser(db, { assigned: true });
    await delegate(db, editor.id, [['users', 'edit']]);
    const eApi = await loggedIn(app, editor);
    await eApi.stepUp(editor.password);
    const denied = await eApi.call('put', `/users/${target.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(denied.status).toBe(403);

    const granted = await makeUser(db, { assigned: true });
    await delegate(db, granted.id, [['users', 'administer']]);
    const gApi = await loggedIn(app, granted);
    await gApi.stepUp(granted.password);
    const ok = await gApi.call('put', `/users/${target.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(ok.status).toBe(200);
    const audit = await db.query(`SELECT on_behalf_of FROM audit_log WHERE action = 'two_factor_enabled' AND entity_id = $1`, [target.id]);
    expect(audit.rows[0].on_behalf_of).toBeTruthy();

    const otherAdmin = await makeAdmin(db);
    const forAdmin = await gApi.call('put', `/users/${otherAdmin.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(forAdmin.status).toBe(403);
    expect((await state(otherAdmin.id)).required).toBe(false);
    void admin;
  });

  it('the delegable right users.two_factor is offered and stored as the grant users.administer', async () => {
    const { api: admin } = await adminApi(app, db);
    const to = await makeUser(db, { assigned: true });
    const res = await admin.call('post', '/delegations', {
      to_user_id: to.id, scope: 'partial', rights: ['users.two_factor'], region_codes: [], valid_from: new Date(Date.now() - 60_000).toISOString(), reason: 'Helpdesk lead',
    });
    expect(res.status).toBe(201);
    expect(res.body.rights).toEqual(['users.two_factor']);
    const g = await db.query('SELECT module_key, action FROM delegation_grants WHERE delegation_id = $1', [res.body.id]);
    expect(g.rows).toEqual([{ module_key: 'users', action: 'administer' }]);
  });

  it('nobody changes their own setting: an admin cannot turn on, off or reset their own two-factor', async () => {
    const { admin, api } = await adminApi(app, db);
    for (const body of [{ enabled: true, reason: 'myself' }, { enabled: false, reason: 'myself' }]) {
      const r = await api.call('put', `/users/${admin.id}/two-factor`, body);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('self_beneficiary');
    }
    const reset = await api.call('post', `/users/${admin.id}/two-factor/reset`, { reason: 'myself' });
    expect(reset.status).toBe(403);
    expect(reset.body.code).toBe('self_beneficiary');
    expect((await state(admin.id)).required).toBe(false);

    // A delegate holding the grant cannot do it for themselves either.
    const d = await makeUser(db, { assigned: true });
    await delegate(db, d.id, [['users', 'administer']]);
    const dApi = await loggedIn(app, d);
    await dApi.stepUp(d.password);
    expect((await dApi.call('put', `/users/${d.id}/two-factor`, { enabled: true, reason: 'myself' })).status).toBe(403);
  });

  it('a second admin can turn it on for the first (the installer admin starts with it off)', async () => {
    const { api: a } = await adminApi(app, db);
    const second = await makeAdmin(db);
    const first = await db.query('SELECT id FROM users WHERE email = $1', ['bootstrap.admin@example.test']);
    expect((await state(first.rows[0].id)).required).toBe(false); // off by default
    const bApi = await loggedIn(app, second);
    await bApi.stepUp(second.password);
    const r = await bApi.call('put', `/users/${second.id}/two-factor`, { enabled: true, reason: 'self' });
    expect(r.status).toBe(403);
    const ok = await a.call('put', `/users/${second.id}/two-factor`, { enabled: true, reason: 'policy for admins' });
    expect(ok.status).toBe(200);
  });

  it('a user with no local account, an unknown user and a bad id are refused cleanly', async () => {
    const { api: admin } = await adminApi(app, db);
    const noLocal = await db.query(`INSERT INTO users (email, display_name, status, updated_at) VALUES ($1, 'No Local', 'active', now()) RETURNING id`, [`nolocal.${Date.now()}@example.test`]);
    const r = await admin.call('put', `/users/${noLocal.rows[0].id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(r.status).toBe(422);
    expect((await admin.call('put', '/users/00000000-0000-4000-8000-000000000000/two-factor', { enabled: true, reason: 'policy' })).status).toBe(404);
    expect((await admin.call('put', '/users/not-a-uuid/two-factor', { enabled: true, reason: 'policy' })).status).toBe(404);
    expect((await admin.call('post', `/users/${noLocal.rows[0].id}/two-factor/reset`, { reason: 'policy' })).status).toBe(422);
  });
});

describe('enrolment is forced at the next sign-in', () => {
  it('turning it on ends the user sessions; the password alone gives no session, only the enrol step', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const live = await loggedIn(app, u);
    expect((await live.call('get', '/me')).status).toBe(200);
    await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect((await live.call('get', '/me')).status).toBe(401);

    const api = new Api(app);
    const login = await api.login(u.email, u.password);
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ authenticated: false, next: 'enrol' });
    expect(login.body.csrf_token).toBeUndefined();
    const cookies = (login.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/pmis_2fa=/);
    expect(cookies).toMatch(/HttpOnly/);
    expect(cookies).toMatch(/SameSite=Strict/);
    expect(cookies).toMatch(/Path=\/api\/v1\/auth\/local\/2fa/);
    expect(cookies).not.toMatch(/pmis_session=/);
    const noSession = await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
    expect(noSession.rowCount).toBe(0);
  });

  it('the pending state reaches only the enrolment endpoints', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'policy' });
    const api = new Api(app);
    await api.login(u.email, u.password);
    // the pending cookie is not a session
    const asSession = new Api(app);
    asSession.token = api.pending;
    expect((await asSession.call('get', '/me')).status).toBe(401);
    expect((await api.call('get', '/me')).status).toBe(401);
    expect((await api.call('get', '/auth/session')).status).toBe(401);
    // the sign-in step is for users who are enrolled
    expect((await api.pendingCall('/auth/local/2fa', { code: '123456' })).status).toBe(401);
  });

  it('shows the otpauth URI and the manual key; the first valid code turns it on, returns 10 recovery codes once and signs in', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const enrolCode = await turnOn(admin, u.id);
    const api = new Api(app);
    await api.login(u.email, u.password);
    const start = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode });
    expect(start.status).toBe(200);
    expect(start.headers['cache-control']).toMatch(/no-store/);
    expect(start.body.issuer).toBe('GSDN PMIS');
    expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.body.otpauth_uri).toBe(
      `otpauth://totp/GSDN%20PMIS:${encodeURIComponent(u.email)}?secret=${start.body.secret}&issuer=GSDN%20PMIS&algorithm=SHA1&digits=6&period=30`,
    );
    // stored encrypted: not the clear secret, and a pmis_app read is impossible (see the grants test)
    const st = await state(u.id);
    expect(st.pending).toMatch(/^v1:/);
    expect(st.pending).not.toContain(start.body.secret);
    expect(st.secret_enc).toBeNull();

    const wrong = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret, 5), enrol_code: enrolCode });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_code');
    expect((await state(u.id)).secret_enc).toBeNull();

    tick();
    const ok = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: enrolCode });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toMatch(/no-store/);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect(new Set(ok.body.recovery_codes).size).toBe(10);
    expect(ok.body.session).toMatchObject({ authenticated: true, mfa: true, two_factor: { enabled: true, recovery_codes_remaining: 10 } });
    api.adopt(ok, ok.body.session);
    expect((await api.call('get', '/me')).status).toBe(200);
    expect((await api.call('get', `/users/${u.id}`)).body.two_factor).toBe('on');

    const st2 = await state(u.id);
    expect(st2.secret_enc).toMatch(/^v1:/);
    expect(st2.secret_enc).not.toContain(start.body.secret);
    expect(st2.pending).toBeNull();
    expect(st2.n).toBe(10);
    const hashes = await db.query('SELECT code_hash FROM user_recovery_codes WHERE user_id = $1', [u.id]);
    for (const c of ok.body.recovery_codes as string[]) {
      expect(hashes.rows.map((r) => r.code_hash)).not.toContain(c);
      expect(hashes.rows.map((r) => r.code_hash)).not.toContain(c.replace('-', ''));
    }
    const audit = await db.query(`SELECT after FROM audit_log WHERE action = 'two_factor_enrolled' AND entity_id = $1`, [u.id]);
    expect(audit.rows[0].after).toMatchObject({ two_factor: 'on', recovery_codes_remaining: 10 });
    expect(JSON.stringify(audit.rows)).not.toContain(start.body.secret);

    // the pending sign-in is single use
    expect((await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: enrolCode })).status).toBe(401);
  });

  it('a second sign-in with the same password cannot replace or confirm an enrolment another sign-in started (10 minutes)', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const enrolCode = await turnOn(admin, u.id);
    const first = new Api(app);
    await first.login(u.email, u.password);
    const start = await first.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode });
    expect(start.status).toBe(200);
    const second = new Api(app);
    await second.login(u.email, u.password);
    // even holding the right code, a second sign-in cannot replace the QR code of the first for 10 minutes
    const hijack = await second.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode });
    expect(hijack.status).toBeGreaterThanOrEqual(400);
    // the second sign-in cannot confirm with the first QR code either
    tick();
    expect((await second.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: enrolCode })).status).toBeGreaterThanOrEqual(400);
    expect((await state(u.id)).secret_enc).toBeNull();
    // the sign-in that started it finishes it
    const ok = await first.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: enrolCode });
    expect(ok.status).toBe(200);
  });

  it('refuses enrolment endpoints without a pending sign-in, with an expired one, and with the wrong kind', async () => {
    const none = new Api(app);
    expect((await none.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: 'ABCD-EFGH' })).status).toBe(401);
    expect((await none.pendingCall('/auth/local/2fa/enrol/confirm', { code: '123456', enrol_code: 'ABCD-EFGH' })).status).toBe(401);
    expect((await none.pendingCall('/auth/local/2fa', { code: '123456' })).status).toBe(401);
    expect((await none.pendingCall('/auth/local/2fa', { code: '123456' }, 'x'.repeat(43))).status).toBe(401);

    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const enrolCode = await turnOn(admin, u.id);
    const api = new Api(app);
    await api.login(u.email, u.password);
    await db.query(`UPDATE auth_pending SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
    expect((await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode })).status).toBe(401);
  });

  it('an enrolled user cannot start a new enrolment (only an admin reset allows it)', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const api = new Api(app);
    await api.login(e.user.email, e.user.password);
    expect((await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: 'ABCD-EFGH' })).status).toBe(401);
    expect((await state(e.user.id)).secret_enc).toMatch(/^v1:/);
  });
});

describe('sign-in with a code', () => {
  it('password then code: no session after the password, a session with mfa after the code; the pending sign-in is single use', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const api = new Api(app);
    const login = await api.login(e.user.email, e.user.password);
    expect(login.body).toMatchObject({ authenticated: false, next: 'two_factor' });
    expect(new Date(login.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect((await api.call('get', '/me')).status).toBe(401);
    tick();
    const code = codeOf(e.secret);
    const res = await api.pendingCall('/auth/local/2fa', { code });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: true, mfa: true, auth_method: 'local', two_factor: { enabled: true, recovery_codes_remaining: 10 } });
    expect(res.headers['set-cookie'] as unknown as string[]).toEqual(expect.arrayContaining([expect.stringMatching(/^pmis_session=/), expect.stringMatching(/^pmis_2fa=;/)]));
    api.adopt(res, res.body);
    expect((await api.call('get', '/me')).status).toBe(200);
    const sess = await db.query('SELECT two_factor FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [e.user.id]);
    expect(sess.rows[0].two_factor).toBe(true);
    // the same pending cookie again
    tick();
    expect((await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret) }, api.pending)).status).toBe(401);
  });

  it('accepts one step either side and refuses two (6 digits, 30 seconds)', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    tick(3);
    const far = await signIn(e, { offset: 2 });
    expect(far.res.status).toBe(401);
    expect(far.res.body.code).toBe('invalid_code');
    tick();
    const earlier = await signIn(e, { offset: -1 });
    expect(earlier.res.status).toBe(200);
    tick(3);
    const later = await signIn(e, { offset: 1 });
    expect(later.res.status).toBe(200);
    // a code with spaces, as people type it
    tick(3);
    const c = codeOf(e.secret, 1); // signIn ticks once before it sends
    expect((await signIn(e, { code: `${c.slice(0, 3)} ${c.slice(3)}` })).res.status).toBe(200);
  });

  it('refuses a replay: the code that signed in cannot sign in again, a later one can', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const used = codeOf(e.secret, 1); // signIn ticks once before it sends
    expect((await signIn(e, { code: used })).res.status).toBe(200);
    // same code, new password step, same time step: refused although the code is valid
    const api = new Api(app);
    await api.login(e.user.email, e.user.password);
    const replay = await api.pendingCall('/auth/local/2fa', { code: used });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('invalid_code');
    expect(replay.body.detail).toMatch(/already used/);
    // an older step than the last used one is refused as well
    const older = await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret, -1) });
    expect(older.status).toBe(401);
    tick(2);
    expect((await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret) })).status).toBe(200);
  });

  it('records the replay guard in the database, so two parallel uses of one code give one session', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    tick();
    const code = codeOf(e.secret);
    const a = new Api(app);
    const b = new Api(app);
    await Promise.all([a.login(e.user.email, e.user.password), b.login(e.user.email, e.user.password)]);
    const [ra, rb] = await Promise.all([a.pendingCall('/auth/local/2fa', { code }), b.pendingCall('/auth/local/2fa', { code })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 401]);
  });

  it('wrong codes count: 5 lock the account for 15 minutes like passwords, the code counter is apart from the password counter', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    limiter.reset();
    const api = new Api(app);
    await api.login(e.user.email, e.user.password);
    for (let i = 0; i < 4; i++) {
      const r = await api.pendingCall('/auth/local/2fa', { code: '000000' });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_code');
    }
    // a correct password in between does not reset the code counter
    await new Api(app).login(e.user.email, e.user.password);
    const fifth = await api.pendingCall('/auth/local/2fa', { code: '000000' });
    expect(fifth.status).toBe(401);
    // the lock ended every pending sign-in, so even the right code finds nothing to complete
    const locked = await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret, 1) });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('unauthenticated');
    // the password sign-in is locked too, with the same generic answer as for passwords
    const pw = await new Api(app).login(e.user.email, e.user.password);
    expect(pw.status).toBe(401);
    expect(pw.body.code).toBe('invalid_credentials');
    const lock = await db.query('SELECT locked_until FROM local_credentials WHERE user_id = $1', [e.user.id]);
    expect(lock.rows[0].locked_until.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'two_factor_locked' AND entity_id = $1`, [e.user.id]);
    expect(audit.rowCount).toBe(1);
    const log = await db.query(`SELECT context FROM system_log WHERE message = 'local_two_factor_failed' AND user_id = $1`, [e.user.id]);
    expect(log.rowCount).toBeGreaterThanOrEqual(5);
    expect(log.rows[0].context).toMatchObject({ reason: 'bad', purpose: 'sign_in', via: 'totp' });
    // the pending sign-in ended with the lock
    const p = await db.query('SELECT 1 FROM auth_pending WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [e.user.id]);
    expect(p.rowCount).toBe(0);
  });

  it('refuses a malformed body and a body with both a code and a recovery code', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const api = new Api(app);
    await api.login(e.user.email, e.user.password);
    expect((await api.pendingCall('/auth/local/2fa', {})).status).toBe(422);
    expect((await api.pendingCall('/auth/local/2fa', { code: '123456', recovery_code: 'AAAAA-BBBBB' })).status).toBe(422);
    expect((await api.pendingCall('/auth/local/2fa', { code: '123456', extra: 1 })).status).toBe(422);
    expect((await api.pendingCall('/auth/local/2fa', { code: 'abcdef' })).status).toBe(401);
  });
});

describe('recovery codes', () => {
  it('a recovery code works instead of a TOTP code, once; the remaining number is shown', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const [first, second] = e.codes as [string, string];
    const a = await signIn(e, { recovery_code: first.toLowerCase() });
    expect(a.res.status).toBe(200);
    expect(a.res.body.two_factor).toEqual({ enabled: true, recovery_codes_remaining: 9, enforced: true });
    expect((await a.api.call('get', '/auth/session')).body.two_factor.recovery_codes_remaining).toBe(9);
    // the same code a second time
    const b = await signIn(e, { recovery_code: first });
    expect(b.res.status).toBe(401);
    expect(b.res.body.code).toBe('invalid_code');
    // another one still works, and the audit trail has before and after
    const c = await signIn(e, { recovery_code: second });
    expect(c.res.status).toBe(200);
    expect(c.res.body.two_factor.recovery_codes_remaining).toBe(8);
    const audit = await db.query(`SELECT before, after FROM audit_log WHERE action = 'two_factor_recovery_used' AND entity_id = $1 ORDER BY at`, [e.user.id]);
    expect(audit.rows[0].before).toEqual({ recovery_codes_remaining: 10 });
    expect(audit.rows[0].after).toEqual({ recovery_codes_remaining: 9 });
  });

  it('a wrong or malformed recovery code counts toward the lock', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    limiter.reset();
    const api = new Api(app);
    await api.login(e.user.email, e.user.password);
    for (const rc of ['AAAAA-BBBBB', 'short', 'AAAAA-BBBBB', 'ZZZZZ-ZZZZZ', 'CCCCC-DDDDD']) {
      expect((await api.pendingCall('/auth/local/2fa', { recovery_code: rc })).status).toBe(401);
    }
    const after = await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret, 1) });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('unauthenticated'); // the lock ended the pending sign-in
    expect((await new Api(app).login(e.user.email, e.user.password)).status).toBe(401); // locked like a password lockout
  });

  it('regenerating needs a valid TOTP code (not a recovery code), replaces the old codes, and is audited', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    limiter.reset();
    const none = await e.api.call('post', '/auth/local/2fa/recovery-codes', {});
    expect(none.status).toBe(422);
    const asRecovery = await e.api.call('post', '/auth/local/2fa/recovery-codes', { code: e.codes[0]! });
    expect(asRecovery.status).toBe(401);
    tick();
    const wrong = await e.api.call('post', '/auth/local/2fa/recovery-codes', { code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_code');
    const regenCode = codeOf(e.secret);
    const ok = await e.api.call('post', '/auth/local/2fa/recovery-codes', { code: regenCode });
    expect(ok.status).toBe(200);
    // replay: the TOTP code used for the regeneration cannot be used again
    const replay = await e.api.call('post', '/auth/local/2fa/recovery-codes', { code: regenCode });
    expect(replay.status).toBe(401);
    expect(ok.headers['cache-control']).toMatch(/no-store/);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect(ok.body.recovery_codes_remaining).toBe(10);
    expect(ok.body.recovery_codes.some((c: string) => e.codes.includes(c))).toBe(false);
    const old = await signIn(e, { recovery_code: e.codes[1]! });
    expect(old.res.status).toBe(401);
    tick();
    const fresh = await signIn(e, { recovery_code: ok.body.recovery_codes[0] });
    expect(fresh.res.status).toBe(200);
    const audit = await db.query(`SELECT before, after FROM audit_log WHERE action = 'two_factor_recovery_regenerated' AND entity_id = $1`, [e.user.id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].after).toEqual({ recovery_codes_remaining: 10 });
  });

  it('regenerating is refused without a session (401) and for a user whose two-factor is off (409)', async () => {
    expect((await new Api(app).call('post', '/auth/local/2fa/recovery-codes', { code: '123456' })).status).toBe(401);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await api.call('post', '/auth/local/2fa/recovery-codes', { code: '123456' })).status).toBe(409);
  });
});

describe('step-up with a code', () => {
  it('asks for the password and the code together (step_up_method password_totp); both are checked', async () => {
    const { api: admin } = await adminApi(app, db);
    const second = await makeAdmin(db);
    const enrolCode = await turnOn(admin, second.id, 'policy for admins');
    const e: Enrolled = await (async () => {
      const api = new Api(app);
      await api.login(second.email, second.password);
      const start = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode });
      tick();
      const confirm = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret as string), enrol_code: enrolCode });
      api.adopt(confirm, confirm.body.session);
      return { user: second, api, secret: start.body.secret as string, codes: confirm.body.recovery_codes };
    })();
    const target = await makeUser(db, { assigned: true });
    const need = await e.api.call('put', `/users/${target.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect(need.status).toBe(401);
    expect(need.body.code).toBe('step_up_required');
    expect(need.body.step_up_method).toBe('password_totp');

    limiter.reset();
    expect((await e.api.stepUp(second.password)).status).toBe(422); // code missing: nothing counted
    expect((await e.api.stepUp('Wrong-Password-12345', { code: '000000' })).status).toBe(401);
    tick();
    const wrongCode = await e.api.stepUp(second.password, { code: '000000' });
    expect(wrongCode.status).toBe(401);
    expect(wrongCode.body.code).toBe('invalid_code');
    expect((await e.api.call('put', `/users/${target.id}/two-factor`, { enabled: true, reason: 'policy' })).status).toBe(401);
    const ok = await e.api.stepUp(second.password, { code: codeOf(e.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.stepup_valid_until).toBeTruthy();
    expect((await e.api.call('put', `/users/${target.id}/two-factor`, { enabled: true, reason: 'policy' })).status).toBe(200);
    // the code just used cannot be used for another step-up
    const replay = await e.api.stepUp(second.password, { code: codeOf(e.secret) });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('invalid_code');
    // a recovery code works at step-up too
    const viaRecovery = await e.api.stepUp(second.password, { recovery_code: e.codes[0]! });
    expect(viaRecovery.status).toBe(200);
  });

  it('a user without two-factor steps up with the password alone', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await api.stepUp(u.password)).status).toBe(200);
    expect((await api.stepUp(u.password, { code: '123456' })).status).toBe(200); // ignored
  });

  it('wrong codes at step-up count toward the same lock', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    limiter.reset();
    for (let i = 0; i < 5; i++) expect((await e.api.stepUp(e.user.password, { code: '000000' })).status).toBe(401);
    const locked = await e.api.stepUp(e.user.password, { code: codeOf(e.secret) });
    expect([401, 429]).toContain(locked.status);
    expect((await new Api(app).login(e.user.email, e.user.password)).status).toBe(401);
  });
});

describe('turning off and reset', () => {
  it('turning it off deletes the secret and the recovery codes; the user signs in with the password again', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const off = await admin.call('put', `/users/${e.user.id}/two-factor`, { enabled: false, reason: 'phone replaced' });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ two_factor: 'off' });
    const st = await state(e.user.id);
    expect(st).toMatchObject({ required: false, secret_enc: null, pending: null, n: 0 });
    const api = await loggedIn(app, e.user);
    expect((await api.call('get', '/me')).status).toBe(200);
    expect((await api.call('get', '/auth/session')).body).toMatchObject({ mfa: false, two_factor: { enabled: false } });
    const audit = await db.query(`SELECT before, after FROM audit_log WHERE action = 'two_factor_disabled' AND entity_id = $1`, [e.user.id]);
    expect(audit.rows[0].before).toMatchObject({ two_factor: 'on', recovery_codes_remaining: 10 });
    expect(audit.rows[0].after).toMatchObject({ two_factor: 'off', recovery_codes_remaining: 0 });
    // setting what is already set changes nothing and writes nothing
    const again = await admin.call('put', `/users/${e.user.id}/two-factor`, { enabled: false, reason: 'again' });
    expect(again.body).toEqual({ two_factor: 'off' });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'two_factor_disabled' AND entity_id = $1`, [e.user.id])).rowCount).toBe(1);
  });

  it('a reset clears the secret and the codes, ends the sessions, and forces a new enrolment', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const second = await signIn(e); // a second session
    expect((await second.api.call('get', '/me')).status).toBe(200);
    tick();
    const r = await admin.call('post', `/users/${e.user.id}/two-factor/reset`, { reason: 'Lost phone, confirmed by phone call' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ two_factor: 'pending_enrolment', enrol_code: expect.stringMatching(ENROL_CODE_RE), enrol_code_expires_at: expect.any(String) });
    const newCode = r.body.enrol_code as string;
    expect((await e.api.call('get', '/me')).status).toBe(401);
    expect((await second.api.call('get', '/me')).status).toBe(401);
    const st = await state(e.user.id);
    expect(st).toMatchObject({ required: true, secret_enc: null, n: 0 });
    const open = await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [e.user.id]);
    expect(open.rowCount).toBe(0);
    const audit = await db.query(`SELECT before, after, reason FROM audit_log WHERE action = 'two_factor_reset' AND entity_id = $1`, [e.user.id]);
    expect(audit.rows[0].before).toMatchObject({ two_factor: 'on', recovery_codes_remaining: 10 });
    expect(audit.rows[0].after).toMatchObject({ two_factor: 'pending_enrolment', recovery_codes_remaining: 0 });
    expect(audit.rows[0].reason).toMatch(/Lost phone/);
    // old recovery codes and the old authenticator are useless; the next sign-in is an enrolment
    const api = new Api(app);
    const login = await api.login(e.user.email, e.user.password);
    expect(login.body).toMatchObject({ authenticated: false, next: 'enrol' });
    expect((await api.pendingCall('/auth/local/2fa', { recovery_code: e.codes[0]! })).status).toBe(401);
    const start = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: newCode });
    expect(start.body.secret).not.toBe(e.secret);
    tick();
    const confirm = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret as string), enrol_code: newCode });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recovery_codes).toHaveLength(10);
  });

  it('a reset of a user whose two-factor is off is refused (409), and a pending enrolment can be reset', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    expect((await admin.call('post', `/users/${u.id}/two-factor/reset`, { reason: 'nothing to do' })).status).toBe(409);
    await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'policy' });
    expect((await admin.call('post', `/users/${u.id}/two-factor/reset`, { reason: 'half-way enrolment' })).status).toBe(200);
  });

  it('the installer can reset or switch off the sole admin on the server (migration role only)', async () => {
    const { api: admin } = await adminApi(app, db);
    const victim = await makeAdmin(db);
    await admin.call('put', `/users/${victim.id}/two-factor`, { enabled: true, reason: 'policy for admins' });
    const code = app.get(TwoFactorService).newEnrolCode(victim.id);
    const done = await db.query('SELECT idm_installer_reset_two_factor($1, false, $2) AS until', [victim.email, code.hash]);
    expect(done.rows[0].until.getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
    expect(await state(victim.id)).toMatchObject({ required: true, secret_enc: null });
    // a reset without a code is refused: the installer path issues one too
    await expect(db.query('SELECT idm_installer_reset_two_factor($1)', [victim.email])).rejects.toMatchObject({ code: '22023' });
    await db.query('SELECT idm_installer_reset_two_factor($1, true)', [victim.email]);
    expect((await state(victim.id)).required).toBe(false);
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await appDb.connect();
    try {
      await expect(appDb.query('SELECT idm_installer_reset_two_factor($1, false, $2)', [victim.email, code.hash])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appDb.end();
    }
  });
});

describe('the database guard and the grants', () => {
  async function asApp<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const mint = (c: PgClient, userId: string) =>
    c.query(`SELECT auth_session_create($1::uuid, $2, 'local'::"AuthMethod", $3, NULL, 'test')`, [userId, 'a'.repeat(64), 'c'.repeat(43)]);

  it('a session cannot be created for a two-factor user with only a password check, nor with a code but no consumed pending sign-in', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [e.user.id]);
      await c.query('SELECT auth_local_result($1::uuid, true)', [e.user.id]); // a fresh password success
      await expect(mint(c, e.user.id)).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/with a code/) });
      await c.query('ROLLBACK');
    });
    // code success recorded, but no pending sign-in consumed (the one used at enrolment is made old)
    await db.query(`UPDATE auth_pending SET used_at = now() - interval '5 minutes' WHERE user_id = $1`, [e.user.id]);
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [e.user.id]);
      await c.query('SELECT auth_local_result($1::uuid, true)', [e.user.id]);
      tick();
      const ok = await c.query('SELECT auth_totp_result($1::uuid, true, $2::bigint) AS r', [e.user.id, stepOf(clock.t)]);
      expect(ok.rows[0].r).toBe('ok');
      await expect(mint(c, e.user.id)).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    expect((await db.query('SELECT 1 FROM user_sessions WHERE token_hash = $1', ['a'.repeat(64)])).rowCount).toBe(0);
  });

  it('a user without two-factor still gets a session after a recent password check, and another user id is refused', async () => {
    const u = await makeUser(db, { assigned: true });
    const other = await makeUser(db, { assigned: true });
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      await expect(mint(c, u.id)).rejects.toMatchObject({ code: '42501' }); // no recent password check
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      await c.query('SELECT auth_local_result($1::uuid, true)', [u.id]);
      await expect(mint(c, other.id)).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });

  it('pmis_app cannot read or write the secrets, the recovery hashes or the pending sign-ins, and cannot read another user secret through the function', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    const other = await makeUser(db, { assigned: true });
    await asApp(async (c) => {
      for (const t of ['user_totp', 'user_recovery_codes', 'auth_pending']) {
        await expect(c.query(`SELECT * FROM ${t}`)).rejects.toMatchObject({ code: '42501' });
        await expect(c.query(`SELECT count(*) FROM ${t}`)).rejects.toMatchObject({ code: '42501' });
      }
      await expect(c.query(`SELECT secret_enc FROM user_totp`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`UPDATE user_totp SET required = false`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM user_recovery_codes`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`INSERT INTO auth_pending (token_hash, user_id, kind, expires_at) VALUES ('${'b'.repeat(64)}', '${e.user.id}', 'two_factor', now() + interval '5 minutes')`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`INSERT INTO user_totp (user_id, required) VALUES ('${other.id}', true)`)).rejects.toMatchObject({ code: '42501' });
      // another user's secret through the function
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [other.id]);
      await expect(c.query('SELECT * FROM auth_totp_secret($1::uuid)', [e.user.id])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
      // without an actor
      await expect(c.query('SELECT * FROM auth_totp_secret($1::uuid)', [e.user.id])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`SELECT auth_totp_use_recovery($1::uuid, '${'a'.repeat(64)}')`, [e.user.id])).rejects.toMatchObject({ code: '42501' });
      // the internal and installer-only functions are not callable
      await expect(c.query('SELECT auth_totp_note_failure($1::uuid)', [e.user.id])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`SELECT idm_two_factor_guard($1::uuid, 'x')`, [e.user.id])).rejects.toMatchObject({ code: '42501' });
      // the identity writes need an admin actor
      for (const sql of [`SELECT idm_set_two_factor($1::uuid, false, 'let me in')`, `SELECT idm_reset_two_factor($1::uuid, 'let me in')`]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [other.id]);
        await expect(c.query(sql, [e.user.id])).rejects.toMatchObject({ code: '42501' });
        await c.query('ROLLBACK');
      }
      await expect(c.query(`SELECT idm_set_two_factor($1::uuid, false, 'no actor')`, [e.user.id])).rejects.toMatchObject({ code: '42501' });
    });
    expect((await state(e.user.id)).required).toBe(true);
  });

  it('the state function gives no secret: only whether it is on, enrolled and how many codes remain', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    await asApp(async (c) => {
      const r = await c.query('SELECT * FROM auth_totp_state($1::uuid)', [e.user.id]);
      expect(r.rows[0]).toEqual({ required: true, enrolled: true, recovery_remaining: 10 });
      const none = await c.query('SELECT * FROM auth_totp_state($1::uuid)', ['00000000-0000-4000-8000-000000000000']);
      expect(none.rows[0]).toEqual({ required: false, enrolled: false, recovery_remaining: 0 });
    });
  });

  it('a delegate without users.administer is refused by the database itself, whatever the API says', async () => {
    const target = await makeUser(db, { assigned: true });
    const d = await makeUser(db, { assigned: true });
    await grantProfile(db, d.id, [['users', 'edit']]);
    await delegate(db, d.id, [['users', 'edit']]);
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [d.id]);
      await expect(c.query(`SELECT idm_set_two_factor($1::uuid, true, 'policy')`, [target.id])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    expect((await state(target.id)).required).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The one-time enrolment code (owner decision 2026-11-02): a password alone can never enrol a phone.
// ---------------------------------------------------------------------------------------------------------------------------------
describe('the enrolment code: issuing', () => {
  const codeRow = async (id: string): Promise<{ enrol_code_hash: string | null; enrol_code_expires_at: Date | null }> =>
    (await db.query('SELECT enrol_code_hash, enrol_code_expires_at FROM user_totp WHERE user_id = $1', [id])).rows[0];

  it('turning two-factor on returns a code of 8 characters (XXXX-XXXX) once; only a keyed hash is stored; it expires after 72 hours by default', async () => {
    const { api: admin, admin: a } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const before = Date.now();
    const res = await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'Finance accounts' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const code = res.body.enrol_code as string;
    expect(code).toMatch(ENROL_CODE_RE);
    expect(code).not.toMatch(/[01IO]/);
    const exp = new Date(res.body.enrol_code_expires_at as string).getTime();
    expect(exp - before).toBeGreaterThan(71.9 * 3600_000);
    expect(exp - before).toBeLessThan(72.1 * 3600_000);
    // the database holds the keyed hash only: not the code, not the bare code, not a plain SHA-256 of it
    const row = await codeRow(u.id);
    expect(row.enrol_code_hash).toMatch(/^[0-9a-f]{64}$/);
    const bare = code.replace('-', '');
    expect(row.enrol_code_hash).not.toBe(createHash('sha256').update(bare).digest('hex'));
    expect(row.enrol_code_hash).not.toBe(createHash('sha256').update(code).digest('hex'));
    expect(row.enrol_code_expires_at!.getTime()).toBe(exp);
    // the audit row says a code was issued, never which
    const audit = await db.query(`SELECT before, after, actor_id FROM audit_log WHERE action = 'two_factor_enabled' AND entity_id = $1`, [u.id]);
    expect(audit.rows[0].after).toMatchObject({ two_factor: 'pending_enrolment', enrol_code: 'issued' });
    expect(audit.rows[0].actor_id).toBe(a.id);
    const everything =
      JSON.stringify((await db.query(`SELECT * FROM audit_log WHERE entity_id = $1`, [u.id])).rows) +
      JSON.stringify((await db.query('SELECT message, context FROM system_log WHERE user_id = $1', [u.id])).rows);
    expect(everything).not.toContain(bare);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(row.enrol_code_hash!);
    // later reads never show it again: the user and the list show when it ends, not what it is
    const one = await admin.call('get', `/users/${u.id}`);
    expect(JSON.stringify(one.body)).not.toContain(bare);
    expect(new Date(one.body.two_factor_enrol_code_expires_at as string).getTime()).toBe(exp);
    const list = await admin.call('get', `/users?q=${encodeURIComponent(u.email)}`);
    expect(list.body.items[0].two_factor_enrol_code_expires_at).toBe(one.body.two_factor_enrol_code_expires_at);
    // setting what is already set issues nothing new
    const again = await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'again' });
    expect(again.body).toEqual({ two_factor: 'pending_enrolment' });
    expect((await codeRow(u.id)).enrol_code_hash).toBe(row.enrol_code_hash);
  });

  it('a reset issues a new code; turning it off clears it', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    expect((await codeRow(e.user.id)).enrol_code_hash).toBeNull(); // used at enrolment
    const r = await admin.call('post', `/users/${e.user.id}/two-factor/reset`, { reason: 'Lost phone' });
    expect(r.body.enrol_code).toMatch(ENROL_CODE_RE);
    expect((await codeRow(e.user.id)).enrol_code_hash).toMatch(/^[0-9a-f]{64}$/);
    const off = await admin.call('put', `/users/${e.user.id}/two-factor`, { enabled: false, reason: 'No longer needed' });
    expect(off.body).toEqual({ two_factor: 'off' });
    expect((await codeRow(e.user.id)).enrol_code_hash).toBeNull();
    expect((await admin.call('get', `/users/${e.user.id}`)).body.two_factor_enrol_code_expires_at).toBeNull();
  });

  it('the lifetime follows the setting two_factor.enrol_code_hours, kept between 1 and 720, and 72 when it is not a number', async () => {
    const { api: admin } = await adminApi(app, db);
    const hoursFor = async (value: string): Promise<number> => {
      await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'two_factor.enrol_code_hours'`, [value]);
      const u = await makeUser(db, { assigned: true });
      const t0 = Date.now();
      const r = await admin.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'setting test' });
      return Math.round((new Date(r.body.enrol_code_expires_at as string).getTime() - t0) / 3600_000);
    };
    try {
      expect((await db.query(`SELECT value FROM settings WHERE key = 'two_factor.enrol_code_hours'`)).rows[0].value).toBe(72);
      expect(await hoursFor('12')).toBe(12);
      expect(await hoursFor('0')).toBe(1);
      expect(await hoursFor('100000')).toBe(720);
      expect(await hoursFor('"soon"')).toBe(72);
    } finally {
      await db.query(`UPDATE settings SET value = '72'::jsonb WHERE key = 'two_factor.enrol_code_hours'`);
    }
  });

  it('issuing a new code needs a reason and the admin step-up, is audited, and the answer is never cached', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const { api: other } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const first = await turnOn(other, u.id);
    const noStep = await api.call('post', `/users/${u.id}/two-factor/enrol-code`, { reason: 'lost the note' });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    await api.stepUp(admin.password);
    expect((await api.call('post', `/users/${u.id}/two-factor/enrol-code`, {})).status).toBe(422);
    expect((await api.call('post', `/users/${u.id}/two-factor/enrol-code`, { reason: 'x' })).status).toBe(422);
    const hashBefore = (await codeRow(u.id)).enrol_code_hash;
    const ok = await api.call('post', `/users/${u.id}/two-factor/enrol-code`, { reason: 'The user lost the note' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toMatch(/no-store/);
    expect(ok.body).toEqual({ two_factor: 'pending_enrolment', enrol_code: expect.stringMatching(ENROL_CODE_RE), enrol_code_expires_at: expect.any(String) });
    expect(ok.body.enrol_code).not.toBe(first);
    expect((await codeRow(u.id)).enrol_code_hash).not.toBe(hashBefore);
    const audit = await db.query(`SELECT before, after, reason, actor_id FROM audit_log WHERE action = 'two_factor_enrol_code_issued' AND entity_id = $1`, [u.id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].before).toEqual({ two_factor: 'pending_enrolment', enrol_code: 'active' });
    expect(audit.rows[0].after).toMatchObject({ two_factor: 'pending_enrolment', enrol_code: 'issued' });
    expect(audit.rows[0].reason).toBe('The user lost the note');
    expect(audit.rows[0].actor_id).toBe(admin.id);
    expect(JSON.stringify(audit.rows)).not.toContain((ok.body.enrol_code as string).replace('-', ''));
  });

  it('only a user who is waiting for enrolment gets a code: 409 for off and for enrolled, 404 for an unknown user, 422 without a local account', async () => {
    const { api: admin } = await adminApi(app, db);
    const off = await makeUser(db, { assigned: true });
    const r1 = await admin.call('post', `/users/${off.id}/two-factor/enrol-code`, { reason: 'nothing to enrol' });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('invalid_transition');
    const e = await enrolledUser(admin);
    expect((await admin.call('post', `/users/${e.user.id}/two-factor/enrol-code`, { reason: 'already enrolled' })).status).toBe(409);
    expect((await admin.call('post', '/users/00000000-0000-4000-8000-000000000000/two-factor/enrol-code', { reason: 'unknown' })).status).toBe(404);
    expect((await admin.call('post', '/users/not-a-uuid/two-factor/enrol-code', { reason: 'unknown' })).status).toBe(404);
    const noLocal = await db.query(`INSERT INTO users (email, display_name, status, updated_at) VALUES ($1, 'No Local', 'active', now()) RETURNING id`, [`nolocal.${Date.now()}.c@example.test`]);
    expect((await admin.call('post', `/users/${noLocal.rows[0].id}/two-factor/enrol-code`, { reason: 'no local account' })).status).toBe(422);
  });
});

describe('the enrolment code: who may issue it', () => {
  it('a user without admin rights, an anonymous caller and a user with users.edit only are refused; the code is unchanged', async () => {
    const { api: admin } = await adminApi(app, db);
    const target = await makeUser(db, { assigned: true });
    await turnOn(admin, target.id);
    const hashBefore = (await db.query('SELECT enrol_code_hash FROM user_totp WHERE user_id = $1', [target.id])).rows[0].enrol_code_hash;
    const plain = await makeUser(db, { assigned: true });
    const pApi = await loggedIn(app, plain);
    await pApi.stepUp(plain.password);
    const denied = await pApi.call('post', `/users/${target.id}/two-factor/enrol-code`, { reason: 'let me in' });
    expect(denied.status).toBe(403);
    expect(denied.body.enrol_code).toBeUndefined();
    expect((await new Api(app).call('post', `/users/${target.id}/two-factor/enrol-code`, { reason: 'anonymous' })).status).toBe(401);
    const editor = await makeUser(db, { assigned: true });
    await delegate(db, editor.id, [['users', 'edit']]);
    const eApi = await loggedIn(app, editor);
    await eApi.stepUp(editor.password);
    expect((await eApi.call('post', `/users/${target.id}/two-factor/enrol-code`, { reason: 'edit only' })).status).toBe(403);
    expect((await db.query('SELECT enrol_code_hash FROM user_totp WHERE user_id = $1', [target.id])).rows[0].enrol_code_hash).toBe(hashBefore);
  });

  it('nobody issues a code for themselves, an admin included; a delegate needs the grant and cannot issue for an admin', async () => {
    const { api: admin, admin: a } = await adminApi(app, db);
    const r = await admin.call('post', `/users/${a.id}/two-factor/enrol-code`, { reason: 'for myself' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('self_beneficiary');

    // an enrolled user (no admin rights) cannot issue one for their own account either
    const e = await enrolledUser(admin);
    await e.api.stepUp(e.user.password, { code: codeOf(e.secret, 1) });
    const self = await e.api.call('post', `/users/${e.user.id}/two-factor/enrol-code`, { reason: 'for myself' });
    expect(self.status).toBe(403);

    const target = await makeUser(db, { assigned: true });
    await turnOn(admin, target.id);
    const d = await makeUser(db, { assigned: true });
    await delegate(db, d.id, [['users', 'administer']]);
    const dApi = await loggedIn(app, d);
    await dApi.stepUp(d.password);
    const ok = await dApi.call('post', `/users/${target.id}/two-factor/enrol-code`, { reason: 'helpdesk call' });
    expect(ok.status).toBe(200);
    expect(ok.body.enrol_code).toMatch(ENROL_CODE_RE);
    const behalf = await db.query(`SELECT on_behalf_of FROM audit_log WHERE action = 'two_factor_enrol_code_issued' AND entity_id = $1`, [target.id]);
    expect(behalf.rows[0].on_behalf_of).toBeTruthy();
    expect((await dApi.call('post', `/users/${d.id}/two-factor/enrol-code`, { reason: 'for myself' })).status).toBe(403);
    const otherAdmin = await makeAdmin(db);
    expect((await dApi.call('post', `/users/${otherAdmin.id}/two-factor/enrol-code`, { reason: 'for an admin' })).status).toBe(403);
  });
});

describe('the enrolment code: using it', () => {
  const pendingOf = (id: string) => db.query('SELECT pending_secret_enc, pending_owner, failed_count FROM user_totp WHERE user_id = $1', [id]).then((r) => r.rows[0]);

  /** An admin turns it on for a fresh user; the user's password sign-in waits for enrolment. */
  async function waiting(admin: Api) {
    const user = await makeUser(db, { assigned: true });
    const enrolCode = await turnOn(admin, user.id);
    const api = new Api(app);
    const login = await api.login(user.email, user.password);
    expect(login.body).toMatchObject({ authenticated: false, next: 'enrol' });
    return { user, api, enrolCode };
  }

  it('enrolment without a code is refused: no QR, no secret in the answer, no pending secret written, nothing counted', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    limiter.reset();
    for (const body of [undefined, {}, { enrol_code: '' }, { enrol_code: '   ' }, { enrol_code: 5 }, { code: '123456' }, { enrol_code: w.enrolCode, extra: 1 }]) {
      const r = await w.api.pendingCall('/auth/local/2fa/enrol/start', body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.secret).toBeUndefined();
      expect(r.body.otpauth_uri).toBeUndefined();
    }
    const st = await pendingOf(w.user.id);
    expect(st.pending_secret_enc).toBeNull();
    expect(st.pending_owner).toBeNull();
    expect(st.failed_count).toBe(0);
    // a confirm without the code is refused as well
    const c = await w.api.pendingCall('/auth/local/2fa/enrol/confirm', { code: '123456' });
    expect(c.status).toBe(422);
    expect((await state(w.user.id)).secret_enc).toBeNull();
    // and the right code still works after all that
    expect((await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode })).status).toBe(200);
  });

  it('a wrong code is 401 invalid_enrol_code, shows no QR, writes no pending secret and counts toward the lock like a wrong TOTP code', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    limiter.reset();
    const wrong = ['AAAA-BBBB', 'short', 'AAAA-BBBB', '1111-2222', 'ZZZZ-ZZZZ'];
    for (let i = 0; i < 4; i++) {
      const r = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: wrong[i] });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_enrol_code');
      expect(r.body.secret).toBeUndefined();
      expect(r.body.detail).toMatch(/administrator/i);
      expect((await pendingOf(w.user.id)).failed_count).toBe(i + 1);
    }
    expect((await pendingOf(w.user.id)).pending_secret_enc).toBeNull();
    // the fifth wrong one locks the account for 15 minutes (the password lock) and ends the pending sign-in
    expect((await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: wrong[4] })).status).toBe(401);
    const lock = await db.query('SELECT locked_until FROM local_credentials WHERE user_id = $1', [w.user.id]);
    expect(lock.rows[0].locked_until.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'two_factor_locked' AND entity_id = $1`, [w.user.id])).rowCount).toBe(1);
    // even the right code finds no pending sign-in now, and a new password sign-in is refused like any lock
    const late = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('unauthenticated');
    expect((await new Api(app).login(w.user.email, w.user.password)).status).toBe(401);
    expect((await pendingOf(w.user.id)).pending_secret_enc).toBeNull();
    const log = await db.query(`SELECT context FROM system_log WHERE message = 'local_two_factor_failed' AND user_id = $1 ORDER BY id`, [w.user.id]);
    expect(log.rows[0].context).toMatchObject({ reason: 'bad', via: 'enrol_code', purpose: 'enrol_start' });
    expect(JSON.stringify(log.rows)).not.toContain(w.enrolCode.replace('-', ''));
  });

  it('wrong enrolment codes and wrong TOTP codes share one counter', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    limiter.reset();
    const start = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(start.status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await w.api.pendingCall('/auth/local/2fa/enrol/confirm', { code: '000000', enrol_code: w.enrolCode })).status).toBe(401);
    for (let i = 0; i < 2; i++) {
      const r = await w.api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: 'AAAA-BBBB' });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_enrol_code');
    }
    expect((await pendingOf(w.user.id)).failed_count).toBe(4);
    expect((await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: 'AAAA-BBBB' })).status).toBe(401);
    const lock = await db.query('SELECT locked_until FROM local_credentials WHERE user_id = $1', [w.user.id]);
    expect(lock.rows[0].locked_until.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await state(w.user.id)).secret_enc).toBeNull();
  });

  it('an expired code is refused with its own error and counts; a new code from the admin works', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    limiter.reset();
    await db.query(`UPDATE user_totp SET enrol_code_expires_at = now() - interval '1 minute' WHERE user_id = $1`, [w.user.id]);
    expect((await admin.call('get', `/users/${w.user.id}`)).body.two_factor_enrol_code_expires_at).toBeTruthy(); // the admin sees it ended
    const r = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('enrol_code_expired');
    expect(r.body.detail).toMatch(/new one/i);
    expect(r.body.secret).toBeUndefined();
    const st = await pendingOf(w.user.id);
    expect(st.pending_secret_enc).toBeNull();
    expect(st.failed_count).toBe(1);
    const log = await db.query(`SELECT context FROM system_log WHERE message = 'local_two_factor_failed' AND user_id = $1`, [w.user.id]);
    expect(log.rows[0].context).toMatchObject({ purpose: 'enrol_start', detail: 'expired' });
    // the audit trail records the reissue as "expired -> issued"
    const fresh = await admin.call('post', `/users/${w.user.id}/two-factor/enrol-code`, { reason: 'Code had expired' });
    expect(fresh.status).toBe(200);
    const audit = await db.query(`SELECT before FROM audit_log WHERE action = 'two_factor_enrol_code_issued' AND entity_id = $1`, [w.user.id]);
    expect(audit.rows[0].before).toMatchObject({ enrol_code: 'expired' });
    const api = new Api(app);
    await api.login(w.user.email, w.user.password);
    const ok = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: fresh.body.enrol_code });
    expect(ok.status).toBe(200);
    // the code ends while the user is half-way: the confirm is refused too
    await db.query(`UPDATE user_totp SET enrol_code_expires_at = now() - interval '1 second' WHERE user_id = $1`, [w.user.id]);
    tick();
    const late = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(ok.body.secret), enrol_code: fresh.body.enrol_code });
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('enrol_code_expired');
    expect((await state(w.user.id)).secret_enc).toBeNull();
  });

  it('the code works once: it is used up when enrolment is confirmed, and is no use again', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    const typed = w.enrolCode.toLowerCase().replace('-', ' '); // typing variants are fine
    const start = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: typed });
    expect(start.status).toBe(200);
    // starting again with the same code is fine until the enrolment is confirmed (the QR code may be redrawn)
    const again = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(again.status).toBe(200);
    tick();
    const ok = await w.api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(again.body.secret), enrol_code: w.enrolCode });
    expect(ok.status).toBe(200);
    expect((await db.query('SELECT enrol_code_hash, enrol_code_expires_at FROM user_totp WHERE user_id = $1', [w.user.id])).rows[0]).toEqual({ enrol_code_hash: null, enrol_code_expires_at: null });
    const audit = await db.query(`SELECT before, after FROM audit_log WHERE action = 'two_factor_enrolled' AND entity_id = $1`, [w.user.id]);
    expect(audit.rows[0].before).toMatchObject({ enrol_code: 'active' });
    expect(audit.rows[0].after).toMatchObject({ enrol_code: 'used' });
    expect((await admin.call('get', `/users/${w.user.id}`)).body.two_factor_enrol_code_expires_at).toBeNull();
    // after a reset the user is waiting again; the used-up code opens nothing
    const reset = await admin.call('post', `/users/${w.user.id}/two-factor/reset`, { reason: 'Lost phone' });
    const api = new Api(app);
    await api.login(w.user.email, w.user.password);
    limiter.reset();
    const old = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('invalid_enrol_code');
    expect((await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: reset.body.enrol_code })).status).toBe(200);
  });

  it('issuing a new code makes the old one stop working, drops a half-made enrolment and ends the pending sign-ins', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    const start = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(start.status).toBe(200);
    expect((await pendingOf(w.user.id)).pending_secret_enc).toMatch(/^v1:/);
    const fresh = await admin.call('post', `/users/${w.user.id}/two-factor/enrol-code`, { reason: 'Possibly seen by someone else' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.enrol_code).not.toBe(w.enrolCode);
    // the half-made enrolment is gone, and so is the pending sign-in behind it
    expect((await pendingOf(w.user.id)).pending_secret_enc).toBeNull();
    tick();
    const stale = await w.api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: w.enrolCode });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('unauthenticated');
    // the old code is useless in a new sign-in; the new one works
    const api = new Api(app);
    await api.login(w.user.email, w.user.password);
    const old = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('invalid_enrol_code');
    const ok = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: fresh.body.enrol_code });
    expect(ok.status).toBe(200);
    // reissuing between start and confirm: the earlier code cannot finish the enrolment, even with a right TOTP code
    const fresh2 = await admin.call('post', `/users/${w.user.id}/two-factor/enrol-code`, { reason: 'Reissued again' });
    expect(fresh2.status).toBe(200);
    tick();
    const viaOld = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(ok.body.secret), enrol_code: fresh.body.enrol_code });
    expect(viaOld.status).toBe(401);
    expect((await state(w.user.id)).secret_enc).toBeNull();
  });

  it('the password plus the code of another user fails', async () => {
    const { api: admin } = await adminApi(app, db);
    const victim = await waiting(admin);
    const other = await waiting(admin);
    limiter.reset();
    const r = await victim.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: other.enrolCode });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_enrol_code');
    expect(r.body.secret).toBeUndefined();
    expect((await pendingOf(victim.user.id)).pending_secret_enc).toBeNull();
    expect((await pendingOf(victim.user.id)).failed_count).toBe(1);
    // the other user's own code is still good, and so is the victim's
    expect((await other.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: other.enrolCode })).status).toBe(200);
    expect((await victim.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: victim.enrolCode })).status).toBe(200);
    // the hash depends on the user: the same code text for two users gives two hashes
    const tf = app.get(TwoFactorService);
    const a = tf.newEnrolCode(victim.user.id);
    const b = tf.newEnrolCode(other.user.id);
    expect(a.hash).not.toBe(b.hash);
  });

  it('the hijack no longer works: an attacker with the password but not the code gets no QR and cannot enrol; the user still can', async () => {
    const { api: admin } = await adminApi(app, db);
    const user = await makeUser(db, { assigned: true });
    const enrolCode = await turnOn(admin, user.id);
    limiter.reset();

    // the attacker knows the password and signs in first (the trust-on-first-use gap of 0033)
    const attacker = new Api(app);
    const login = await attacker.login(user.email, user.password);
    expect(login.body).toMatchObject({ authenticated: false, next: 'enrol' });
    const grabbed = await attacker.pendingCall('/auth/local/2fa/enrol/start');
    expect(grabbed.status).toBe(422);
    expect(grabbed.body.secret).toBeUndefined();
    const guessed = await attacker.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: 'ABCD-EFGH' });
    expect(guessed.status).toBe(401);
    expect(guessed.body.secret).toBeUndefined();
    // a blind confirm with a TOTP code of the attacker's own app is refused too: there is no pending secret and no code
    const blind = await attacker.pendingCall('/auth/local/2fa/enrol/confirm', { code: '123456', enrol_code: 'ABCD-EFGH' });
    expect(blind.status).toBe(401);
    expect(await state(user.id)).toMatchObject({ required: true, secret_enc: null, pending: null });
    const noSession = await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    expect(noSession.rowCount).toBe(0);

    // the user signs in later with the code from the admin and enrols
    const real = new Api(app);
    await real.login(user.email, user.password);
    const start = await real.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: enrolCode });
    expect(start.status).toBe(200);
    tick();
    const ok = await real.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: enrolCode });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
  });

  it('the attacker cannot take over a QR code the user started either (the code is still needed and the first sign-in keeps it)', async () => {
    const { api: admin } = await adminApi(app, db);
    const w = await waiting(admin);
    limiter.reset();
    const start = await w.api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: w.enrolCode });
    expect(start.status).toBe(200);
    const attacker = new Api(app);
    await attacker.login(w.user.email, w.user.password);
    expect((await attacker.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: 'ABCD-EFGH' })).status).toBe(401);
    tick();
    expect((await attacker.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: 'ABCD-EFGH' })).status).toBe(401);
    expect((await w.api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(start.body.secret), enrol_code: w.enrolCode })).status).toBe(200);
  });
});

describe('the enrolment code: the database', () => {
  async function asApp<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  it('pmis_app cannot read or write the hash, cannot call the internal functions, and the old forms of the functions are gone', async () => {
    const { api: admin } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const other = await makeUser(db, { assigned: true });
    const code = await turnOn(admin, u.id);
    await asApp(async (c) => {
      await expect(c.query('SELECT enrol_code_hash FROM user_totp')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT enrol_code_expires_at FROM user_totp')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT * FROM user_totp')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`UPDATE user_totp SET enrol_code_hash = '${'a'.repeat(64)}', enrol_code_expires_at = now() + interval '1 day'`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT auth_totp_check_enrol_code($1::uuid, $2)', [u.id, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT idm_enrol_code_hours()')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`SELECT idm_installer_reset_two_factor('x@example.test', false, '${'a'.repeat(64)}')`)).rejects.toMatchObject({ code: '42501' });
      // the old forms (no code) do not exist any more: they would have enrolled without one
      await expect(c.query(`SELECT auth_totp_begin_enrol($1::uuid, 'v1:aaaaaaaaaaaaaaaaaaaaaaaa', '${'b'.repeat(64)}')`, [u.id])).rejects.toMatchObject({ code: '42883' });
      await expect(c.query(`SELECT auth_totp_confirm_enrol($1::uuid, 1, ARRAY[]::text[], '${'b'.repeat(64)}')`, [u.id])).rejects.toMatchObject({ code: '42883' });
      // what it may read: when the code ends, not the code
      const st = await c.query('SELECT auth_totp_enrol_code_state($1::uuid) AS until', [u.id]);
      expect(st.rows[0].until).toBeInstanceOf(Date);
      expect(JSON.stringify(st.rows)).not.toContain(code.replace('-', ''));
      // enrolment functions act only for the signed-in user
      await expect(c.query(`SELECT auth_totp_begin_enrol($1::uuid, 'v1:aaaaaaaaaaaaaaaaaaaaaaaa', '${'b'.repeat(64)}', '${'c'.repeat(64)}')`, [u.id])).rejects.toMatchObject({ code: '42501' });
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [other.id]);
      await expect(c.query(`SELECT auth_totp_begin_enrol($1::uuid, 'v1:aaaaaaaaaaaaaaaaaaaaaaaa', '${'b'.repeat(64)}', '${'c'.repeat(64)}')`, [u.id])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
      // the user's own call with a made-up hash is a miss: counted, no secret stored
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      const miss = await c.query(`SELECT auth_totp_begin_enrol($1::uuid, 'v1:aaaaaaaaaaaaaaaaaaaaaaaa', '${'b'.repeat(64)}', '${'c'.repeat(64)}') AS r`, [u.id]);
      expect(miss.rows[0].r).toBe('bad');
      await c.query('COMMIT');
      // a malformed hash is refused outright
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [u.id]);
      await expect(c.query(`SELECT auth_totp_begin_enrol($1::uuid, 'v1:aaaaaaaaaaaaaaaaaaaaaaaa', '${'b'.repeat(64)}', 'nothex')`, [u.id])).rejects.toMatchObject({ code: '22023' });
      await c.query('ROLLBACK');
    });
    const st = await db.query('SELECT pending_secret_enc, failed_count FROM user_totp WHERE user_id = $1', [u.id]);
    expect(st.rows[0]).toEqual({ pending_secret_enc: null, failed_count: 1 });
  });

  it('the issue, turn-on and reset functions refuse a caller who is not an admin, whatever the API says', async () => {
    const { api: admin } = await adminApi(app, db);
    const target = await makeUser(db, { assigned: true });
    await turnOn(admin, target.id);
    const nobody = await makeUser(db, { assigned: true });
    const h = 'd'.repeat(64);
    await asApp(async (c) => {
      for (const sql of [
        `SELECT idm_issue_two_factor_enrol_code($1::uuid, 'let me in', '${h}')`,
        `SELECT * FROM idm_set_two_factor($1::uuid, true, 'let me in', '${h}')`,
        `SELECT * FROM idm_reset_two_factor($1::uuid, 'let me in', '${h}')`,
      ]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [nobody.id]);
        await expect(c.query(sql, [target.id])).rejects.toMatchObject({ code: '42501' });
        await c.query('ROLLBACK');
        await expect(c.query(sql, [target.id])).rejects.toMatchObject({ code: '42501' }); // no actor at all
      }
    });
    const row = await db.query('SELECT enrol_code_hash FROM user_totp WHERE user_id = $1', [target.id]);
    expect(row.rows[0].enrol_code_hash).not.toBe(h);
  });

  it('the table refuses a code on a user who is not waiting for enrolment', async () => {
    const { api: admin } = await adminApi(app, db);
    const e = await enrolledUser(admin);
    await expect(db.query(`UPDATE user_totp SET enrol_code_hash = $2, enrol_code_expires_at = now() + interval '1 day' WHERE user_id = $1`, [e.user.id, 'a'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query(`UPDATE user_totp SET enrol_code_hash = $2 WHERE user_id = $1`, [e.user.id, 'a'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('time steps do not depend on the weekday', () => {
  it('uses the injected clock, and totpCode agrees with hotp for the step', () => {
    for (let d = 0; d < 7; d++) {
      const t = Date.UTC(2026, 10, 1 + d, 9, 30, 0);
      const s = Buffer.from('12345678901234567890');
      expect(totpCode(s, t)).toBe(hotp(s, stepOf(t)));
    }
  });
});
