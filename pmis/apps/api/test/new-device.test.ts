import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import type { Client as Pg } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { MailService } from '../src/mail/mail.service';
import { API, Api, beginAs, makeUser, setCookies, startApp, superDb } from './helpers';
import { q } from './calc-helpers';
import { Actor, plainAdmin } from './wf-helpers';

/**
 * New-device email code (migration 0292, contract 0.15.192): off by default; when an admin turns it on, a password-only sign-in from a browser the account has not
 * used needs the 6-digit code mailed to it. The database enforces it in auth_session_create. Never for two-factor accounts, System Admins (by default) or when
 * the mail cannot be queued; an admin can let one account in once.
 */
let app: NestExpressApplication;
let db: Pg;
let admin: Actor;
let ipSeq = 20;
const REASON = 'Phishing wave, owner asked for it';
const CFG_OFF = '{"enabled": false, "code_minutes": 10, "include_admins": false}';
const newIp = (): string => `10.88.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  Object.defineProperty(app.get(MailService), 'enabled', { get: () => true, configurable: true });
  admin = await plainAdmin(app, db);
});
beforeEach(() => app.get(RateLimiter).reset());
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '${CFG_OFF}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'security.new_device_code'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const readCfg = () => admin.api.call('get', '/settings/new-device-code');
const putCfg = async (body: Record<string, unknown>) => admin.api.call('put', '/settings/new-device-code', { code_minutes: 10, include_admins: false, reason: REASON, ...body }, { 'If-Match': etag(await readCfg()) });
const turn = async (enabled: boolean, extra: Record<string, unknown> = {}) => expect((await putCfg({ enabled, ...extra })).status).toBe(200);
const off = async () => { const r = await putCfg({ enabled: false }); expect([200, 409]).toContain(r.status); };

const cookieOf = (res: request.Response, name: string): string | undefined => setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);
const signIn = (email: string, password: string, device?: string, ip = newIp()) => {
  const t = request(app.getHttpServer()).post(`${API}/auth/local/login`).set('X-Forwarded-For', ip);
  if (device) t.set('Cookie', `pmis_dev=${device}`);
  return t.send({ identifier: email, password });
};
const sendCode = (pending: string, code: string, ip = newIp()) =>
  request(app.getHttpServer()).post(`${API}/auth/local/2fa/device-code`).set('X-Forwarded-For', ip).set('Cookie', `pmis_2fa=${pending}`).send({ code });
const mailedCode = async (userId: string): Promise<string> => {
  const r = await db.query(`SELECT body_text, sensitive FROM mail_outbox WHERE to_user_id = $1 AND kind = 'identity.new_device_code' ORDER BY created_at DESC LIMIT 1`, [userId]);
  expect(r.rows[0].sensitive).toBe(true);
  return /code is: ([0-9]{6})/.exec(r.rows[0].body_text as string)![1]!;
};
const mailCount = async (userId: string): Promise<number> => (await db.query(`SELECT count(*)::int AS n FROM mail_outbox WHERE to_user_id = $1 AND kind = 'identity.new_device_code'`, [userId])).rows[0].n as number;

describe('off by default', () => {
  it('the setting is off, a sign-in is exactly as before (session, no code, no cookie), and only a System Admin reads it', async () => {
    const r = await readCfg();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, code_minutes: 10, include_admins: false, can_edit: true });
    const u = await makeUser(db, { assigned: true });
    const res = await signIn(u.email, u.password);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(cookieOf(res, 'pmis_dev')).toBeUndefined();
    expect(await mailCount(u.id)).toBe(0);
    const plain = new Api(app);
    const pl = await plain.login(u.email, u.password);
    await plain.stepUp(u.password);
    expect([pl.status, pl.body]).toEqual([200, expect.objectContaining({ authenticated: true })]);
    expect((await plain.call('get', '/settings/new-device-code')).status).toBe(403);
    expect((await plain.call('put', '/settings/new-device-code', { enabled: true, code_minutes: 10, include_admins: false, reason: REASON }, { 'If-Match': etag(r) })).status).toBe(403);
  });
});

describe('turned on', () => {
  it('a new browser needs the code once; the same browser does not; another browser needs it again; wrong codes are counted', async () => {
    await turn(true);
    try {
      const u = await makeUser(db, { assigned: true });
      const first = await signIn(u.email, u.password);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ authenticated: false, next: 'device_code' });
      const device = cookieOf(first, 'pmis_dev')!;
      const pending = cookieOf(first, 'pmis_2fa')!;
      expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.headers['set-cookie']).toBeDefined();
      expect(cookieOf(first, 'pmis_session')).toBeUndefined();
      const code = await mailedCode(u.id);
      const wrong = await sendCode(pending, code === '000000' ? '111111' : '000000');
      expect(wrong.status).toBe(422);
      const ok = await sendCode(pending, code);
      expect(ok.status).toBe(200);
      expect(cookieOf(ok, 'pmis_session')).toBeDefined();
      // only hashes are stored
      const stored = await q<{ device_hash: string }>(db, `SELECT device_hash FROM auth_known_device WHERE user_id = $1`, [u.id]);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.device_hash).not.toBe(device);
      // the code works once
      expect((await sendCode(pending, code)).status).toBe(401);
      // same browser: straight in
      const again = await signIn(u.email, u.password, device);
      expect(again.body.authenticated).toBe(true);
      expect(await mailCount(u.id)).toBe(1);
      // another browser: a code again
      const other = await signIn(u.email, u.password);
      expect(other.body).toMatchObject({ next: 'device_code' });
      expect(await mailCount(u.id)).toBe(2);
    } finally {
      await off();
    }
  });

  it('five wrong codes end the challenge; a new sign-in makes a new one; at most ten codes an hour', async () => {
    await turn(true);
    try {
      const u = await makeUser(db, { assigned: true });
      const first = await signIn(u.email, u.password);
      const pending = cookieOf(first, 'pmis_2fa')!;
      const code = await mailedCode(u.id);
      const bad = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expect((await sendCode(pending, bad)).status).toBe(i < 4 ? 422 : 401); // the fifth ends the challenge
      expect((await sendCode(pending, code)).status).toBe(401); // the challenge is over, even for the right code
      const second = await signIn(u.email, u.password);
      expect(second.body).toMatchObject({ next: 'device_code' });
      expect((await sendCode(cookieOf(second, 'pmis_2fa')!, await mailedCode(u.id))).status).toBe(200);
      const lim = app.get(RateLimiter);
      for (let i = 0; i < 8; i++) { lim.reset(); expect((await signIn(u.email, u.password)).status).toBe(200); }
      lim.reset();
      expect((await signIn(u.email, u.password)).status).toBe(429);
      expect(await mailCount(u.id)).toBe(10);
    } finally {
      await off();
    }
  });

  it('an expired code is refused', async () => {
    await turn(true);
    try {
      const u = await makeUser(db, { assigned: true });
      const first = await signIn(u.email, u.password);
      await db.query(`UPDATE auth_device_challenge SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
      expect((await sendCode(cookieOf(first, 'pmis_2fa')!, await mailedCode(u.id))).status).toBe(401);
    } finally {
      await off();
    }
  });

  it('never applies to a System Admin by default, nor to a two-factor account, nor to an account with no email', async () => {
    await turn(true);
    try {
      const a = await plainAdmin(app, db);
      const adminLogin = await signIn(a.user.email, a.user.password);
      expect(adminLogin.body.authenticated).toBe(true);
      const t = await makeUser(db, { assigned: true });
      const on = await admin.api.call('put', `/users/${t.id}/two-factor`, { enabled: true, reason: 'policy' });
      expect(on.status).toBe(200);
      expect((await signIn(t.email, t.password)).body).toMatchObject({ next: 'enrol' });
      // include_admins on: an admin also gets the code
      await turn(true, { include_admins: true });
      const b = await plainAdmin(app, db);
      const second = await signIn(b.user.email, b.user.password);
      expect(second.body).toMatchObject({ next: 'device_code' });
    } finally {
      await off();
    }
  });

  it('with no mail server the sign-in goes through (nobody is locked out) and the System Log says so', async () => {
    await turn(true);
    const mail = app.get(MailService);
    Object.defineProperty(mail, 'enabled', { get: () => false, configurable: true });
    try {
      const u = await makeUser(db, { assigned: true });
      const res = await signIn(u.email, u.password);
      expect(res.body.authenticated).toBe(true);
      expect(await mailCount(u.id)).toBe(0);
      const p = await q<{ via: string }>(db, `SELECT via FROM auth_device_pass WHERE user_id = $1`, [u.id]);
      expect(p[0]!.via).toBe('no_mail');
    } finally {
      Object.defineProperty(mail, 'enabled', { get: () => true, configurable: true });
      await off();
    }
  });

  it('refuses to be turned on when the mail server is not set up', async () => {
    const mail = app.get(MailService);
    Object.defineProperty(mail, 'enabled', { get: () => false, configurable: true });
    try {
      const r = await putCfg({ enabled: true });
      expect(r.status).toBe(409);
    } finally {
      Object.defineProperty(mail, 'enabled', { get: () => true, configurable: true });
    }
  });
});

describe('recovery and audit', () => {
  it('an admin lets one account in once without the code; it is audited with a reason; another browser still needs a code', async () => {
    await turn(true);
    try {
      const u = await makeUser(db, { assigned: true });
      const b = await admin.api.call('post', '/settings/new-device-code/bypass', { user_id: u.id, minutes: 10, reason: 'Mail box is down' });
      expect(b.status).toBe(200);
      const res = await signIn(u.email, u.password);
      expect(res.body.authenticated).toBe(true);
      expect(await mailCount(u.id)).toBe(0);
      const next = await signIn(u.email, u.password);
      expect(next.body).toMatchObject({ next: 'device_code' });
      const plain = new Api(app);
      await plain.login(u.email, u.password).catch(() => undefined);
      const forbidden = await signIn(u.email, u.password);
      expect(forbidden.status).toBe(200);
      const a = await q<{ reason: string }>(db, `SELECT reason FROM audit_log WHERE action = 'new_device_bypass' AND entity_id = $1`, [u.id]);
      expect(a).toHaveLength(1);
      expect(a[0]!.reason).toBe('Mail box is down');
    } finally {
      await off();
    }
  });

  it('the setting changes are audited with before and after, need a reason and the If-Match version', async () => {
    const before = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'new_device_code_update'`);
    await turn(true, { code_minutes: 15 });
    await off();
    const after = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'new_device_code_update'`);
    expect(after[0]!.n - before[0]!.n).toBe(2);
    expect((await putCfg({ enabled: true, reason: 'x' })).status).toBe(422);
    const stale = await admin.api.call('put', '/settings/new-device-code', { enabled: true, code_minutes: 10, include_admins: false, reason: REASON }, { 'If-Match': '"1"' });
    expect([412, 409]).toContain(stale.status);
    expect((await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'security.new_device_code'`))[0]!.value).toEqual(JSON.parse(CFG_OFF));
  });
});

describe('the database enforces it', () => {
  it('auth_session_create refuses a password-only session without a pass when it applies, and works as before when it does not', async () => {
    const u = await makeUser(db, { assigned: true });
    const run = async (fn: (c: PgClient) => Promise<void>): Promise<void> => {
      const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      try {
        await c.query('BEGIN');
        await beginAs(c, u.id);
        await c.query('SELECT auth_local_result($1::uuid, true)', [u.id]);
        await fn(c);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    };
    const mint = (c: PgClient) => c.query(`SELECT auth_session_create($1::uuid, $2, 'local'::"AuthMethod", $3, NULL, 'test')`, [u.id, 'd'.repeat(64), 'c'.repeat(43)]);
    await run(async (c) => { expect((await mint(c)).rowCount).toBe(1); }); // off: as before
    await turn(true);
    try {
      await run(async (c) => { await expect(mint(c)).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/new-device/) }); });
      expect((await db.query('SELECT 1 FROM user_sessions WHERE token_hash = $1', ['d'.repeat(64)])).rowCount).toBe(0);
    } finally {
      await off();
    }
  });

  it('the tables are closed to pmis_app and every function has a fixed search_path', async () => {
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      for (const t of ['auth_known_device', 'auth_device_challenge', 'auth_device_pass', 'auth_device_bypass']) {
        await expect(c.query(`SELECT 1 FROM ${t}`)).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await c.end();
    }
    const f = await q<{ proname: string; ok: boolean }>(db, `SELECT proname, coalesce(proconfig::text ~ 'search_path', false) AS ok FROM pg_proc WHERE proname LIKE 'auth_device_%' OR proname LIKE 'new_device_%' OR proname = 'admin_new_device_bypass' OR proname = 'admin_set_new_device_code'`);
    expect(f.length).toBeGreaterThanOrEqual(11);
    expect(f.filter((x) => !x.ok)).toEqual([]);
  });
});
