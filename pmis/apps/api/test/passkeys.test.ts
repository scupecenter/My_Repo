import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { base32Decode, hotp, stepOf } from '../src/auth/totp';
import { Api, makeUser, startApp, superDb, TestUser } from './helpers';
import { Actor, plainAdmin } from './wf-helpers';
import { authenticator } from './webauthn-authenticator';

/**
 * Passkeys (migration 0294, contract 0.15.194): off by default; an admin turns them on; an account with two-step verification adds a passkey and signs in with it instead
 * of the code; the code path, replay, counter rollback, revoke and the admin recovery all hold; turning the setting off changes nothing for the code path.
 */
const BASE = 'https://pmis.example.test';
const rp = { rpId: 'pmis.example.test', rpName: 'GSDN Workspace', origins: [BASE] };
const REASON = 'Owner decision for the test';
let app: NestExpressApplication;
let db: Pg;
let admin: Actor;
const clock = { t: Date.UTC(2026, 10, 3, 10, 0, 0), now(): number { return this.t; } };
const tick = (): void => { clock.t += 30_000; };

beforeAll(async () => {
  app = await startApp({ appBaseUrl: BASE });
  db = await superDb();
  app.get(TwoFactorService).setClock(clock);
  admin = await plainAdmin(app, db);
});
beforeEach(() => app.get(RateLimiter).reset());
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '{"enabled": false}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'security.passkeys'`);
  await db.end();
  await app.close();
});

const codeOf = (secret: string): string => hotp(base32Decode(secret), stepOf(clock.t));
const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const setting = (enabled: boolean) => admin.api.call('get', '/settings/passkeys').then((r) => admin.api.call('put', '/settings/passkeys', { enabled, reason: REASON }, { 'If-Match': etag(r) }));

interface Enrolled { user: TestUser; api: Api; secret: string }
async function enrolledUser(): Promise<Enrolled> {
  const user = await makeUser(db, { assigned: true });
  const on = await admin.api.call('put', `/users/${user.id}/two-factor`, { enabled: true, reason: 'policy' });
  expect(on.status).toBe(200);
  const api = new Api(app);
  await api.login(user.email, user.password);
  const start = await api.pendingCall('/auth/local/2fa/enrol/start', { enrol_code: on.body.enrol_code });
  const secret = start.body.secret as string;
  tick();
  const confirm = await api.pendingCall('/auth/local/2fa/enrol/confirm', { code: codeOf(secret), enrol_code: on.body.enrol_code });
  expect(confirm.status).toBe(200);
  api.adopt(confirm, confirm.body.session);
  return { user, api, secret };
}
const addPasskey = async (e: Enrolled, label = 'Phone') => {
  const a = authenticator(rp);
  tick();
  expect((await e.api.stepUp(e.user.password, { code: codeOf(e.secret) })).status).toBe(200);
  const o = await e.api.call('post', '/me/passkeys/register/options');
  expect(o.status).toBe(200);
  const v = await e.api.call('post', '/me/passkeys/register/verify', { label, response: a.register(o.body.challenge as string) });
  return { a, o, v };
};
const startSignIn = async (e: Enrolled) => {
  app.get(RateLimiter).reset();
  const api = new Api(app);
  const login = await api.login(e.user.email, e.user.password);
  expect(login.body).toMatchObject({ authenticated: false, next: 'two_factor' });
  return api;
};

describe('off by default', () => {
  it('the setting reads off and ready, a user cannot add a passkey, and the code sign-in is as before', async () => {
    const r = await admin.api.call('get', '/settings/passkeys');
    expect(r.body).toMatchObject({ enabled: false, ready: true, can_edit: true });
    const e = await enrolledUser();
    tick();
    expect((await e.api.stepUp(e.user.password, { code: codeOf(e.secret) })).status).toBe(200);
    expect((await e.api.call('post', '/me/passkeys/register/options')).status).toBe(409);
    const api = await startSignIn(e);
    const o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect(o.status).toBe(200);
    expect(o.body).toEqual({ available: false, options: null });
    tick();
    const ok = await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.authenticated).toBe(true);
  });

  it('only a System Admin changes it, with a reason, a step-up and If-Match; each change is audited', async () => {
    const plain = new Api(app);
    const u = await makeUser(db, { assigned: true });
    await plain.login(u.email, u.password);
    const tag = etag(await admin.api.call('get', '/settings/passkeys'));
    expect((await admin.api.call('put', '/settings/passkeys', { enabled: true, reason: REASON })).status).toBe(428);
    expect((await admin.api.call('put', '/settings/passkeys', { enabled: true, reason: 'ab' }, { 'If-Match': tag })).status).toBe(422);
    expect([401, 403]).toContain((await plain.call('put', '/settings/passkeys', { enabled: true, reason: REASON }, { 'If-Match': tag })).status);
    const on = await setting(true);
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect((await setting(true)).status).toBe(409);
    expect((await setting(false)).status).toBe(200);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'passkeys_update' AND entity_id = 'security.passkeys'`);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('with passkeys on', () => {
  beforeAll(async () => { expect((await setting(true)).status).toBe(200); });

  it('an account without two-step verification cannot add a passkey (it is next to the code, never instead of the password)', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = new Api(app);
    const login = await api.login(u.email, u.password);
    api.adopt(login, login.body);
    await api.stepUp(u.password);
    const r = await api.call('post', '/me/passkeys/register/options');
    expect(r.status).toBe(409);
    const mine = await api.call('get', '/me/passkeys');
    expect(mine.body).toMatchObject({ enabled: true, can_add: false, items: [] });
  });

  it('adds a passkey (step-up needed, no key material in the answer), lists it, signs in with it, and the code still works', async () => {
    const e = await enrolledUser();
    const noStep = await e.api.call('post', '/me/passkeys/register/options');
    expect([401, 409]).toContain(noStep.status);
    const { a, v } = await addPasskey(e);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ label: 'Phone' });
    expect(JSON.stringify(v.body)).not.toMatch(/public_key|credential_id/);
    const mine = await e.api.call('get', '/me/passkeys');
    expect(mine.body.items).toHaveLength(1);

    const api = await startSignIn(e);
    const o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect(o.body.available).toBe(true);
    const ch = o.body.options.challenge as string;
    const ok = await api.pendingCall('/auth/local/2fa/passkey', { response: a.assert(ch, 3) });
    expect(ok.status).toBe(200);
    expect(ok.body.authenticated).toBe(true);
    // the pending sign-in is single use
    const again = await api.pendingCall('/auth/local/2fa/passkey', { response: a.assert(ch, 4) });
    expect(again.status).toBe(401);

    // the code path is untouched
    const api2 = await startSignIn(e);
    tick();
    expect((await api2.pendingCall('/auth/local/2fa', { code: codeOf(e.secret) })).status).toBe(200);
    const sec = await db.query(`SELECT detail FROM security_log WHERE user_id = $1 AND event = 'two_factor_passed' ORDER BY id DESC`, [e.user.id]);
    expect(sec.rows.map((r) => r.detail.via)).toContain('passkey');
  });

  it('refuses a replayed challenge, a counter that did not move forward, another account\'s key, and a wrong origin', async () => {
    const e = await enrolledUser();
    const { a } = await addPasskey(e);
    const other = authenticator(rp);
    // first use at counter 5
    let api = await startSignIn(e);
    let o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    const ch1 = o.body.options.challenge as string;
    const good = a.assert(ch1, 5);
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: good })).status).toBe(200);
    // replay of the same signed response on a fresh sign-in (old challenge is spent)
    api = await startSignIn(e);
    o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: good })).status).toBe(401);
    // counter not forward
    api = await startSignIn(e);
    o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: a.assert(o.body.options.challenge as string, 5) })).status).toBe(401);
    // unknown key, wrong origin
    api = await startSignIn(e);
    o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: other.assert(o.body.options.challenge as string, 9) })).status).toBe(401);
    api = await startSignIn(e);
    o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: a.assert(o.body.options.challenge as string, 9, { origin: 'https://evil.test' }) })).status).toBe(401);
    // junk
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: { id: 'x' } })).status).toBe(422);
    expect((await api.pendingCall('/auth/local/2fa/passkey', { nope: 1 })).status).toBe(422);
    // no pending cookie at all
    expect((await new Api(app).call('post', '/auth/local/2fa/passkey', { response: good })).status).toBe(401);
  });

  it('the account holder removes a passkey (the row stays, revoked), an admin revokes the rest, and the code path works the whole time', async () => {
    const e = await enrolledUser();
    const { v } = await addPasskey(e, 'One');
    await addPasskey(e, 'Two');
    tick();
    expect((await e.api.stepUp(e.user.password, { code: codeOf(e.secret) })).status).toBe(200);
    expect((await e.api.call('delete', `/me/passkeys/${v.body.id as string}`)).status).toBe(204);
    expect((await e.api.call('delete', `/me/passkeys/${v.body.id as string}`)).status).toBe(404);
    expect((await e.api.call('get', '/me/passkeys')).body.items).toHaveLength(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM auth_passkey WHERE user_id = $1`, [e.user.id])).rows[0].n).toBe(2);
    expect((await e.api.call('post', `/users/${e.user.id}/passkeys/revoke`, { reason: REASON })).status).toBe(403);
    const rev = await admin.api.call('post', `/users/${e.user.id}/passkeys/revoke`, { reason: 'Lost phone, owner asked' });
    expect(rev.status).toBe(200);
    expect(rev.body).toEqual({ revoked: 1 });
    const api = await startSignIn(e);
    expect((await api.pendingCall('/auth/local/2fa/passkey/options', {})).body.available).toBe(false);
    tick();
    expect((await api.pendingCall('/auth/local/2fa', { code: codeOf(e.secret) })).status).toBe(200);
  });

  it('turning the setting off stops the passkey option and keeps the rows; turning it on again brings them back', async () => {
    const e = await enrolledUser();
    const { a } = await addPasskey(e);
    expect((await setting(false)).status).toBe(200);
    let api = await startSignIn(e);
    expect((await api.pendingCall('/auth/local/2fa/passkey/options', {})).body.available).toBe(false);
    expect((await db.query(`SELECT count(*)::int AS n FROM auth_passkey WHERE user_id = $1 AND revoked_at IS NULL`, [e.user.id])).rows[0].n).toBe(1);
    expect((await setting(true)).status).toBe(200);
    api = await startSignIn(e);
    const o = await api.pendingCall('/auth/local/2fa/passkey/options', {});
    expect(o.body.available).toBe(true);
    expect((await api.pendingCall('/auth/local/2fa/passkey', { response: a.assert(o.body.options.challenge as string, 2) })).status).toBe(200);
  });
});
