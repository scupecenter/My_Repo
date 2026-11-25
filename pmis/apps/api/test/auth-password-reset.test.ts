import { createHash, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, Api, makeAdmin, makeUser, startApp, superDb } from './helpers';

let app: NestExpressApplication;
let db: Pg;
let ipSeq = 100;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const newIp = (): string => `10.77.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const ask = (identifier: string, ip = newIp()): request.Test =>
  request(app.getHttpServer()).post(`${API}/auth/local/password-reset/request`).set('X-Forwarded-For', ip).send({ identifier });
const confirm = (token: string, new_password: string, ip = newIp()): request.Test =>
  request(app.getHttpServer()).post(`${API}/auth/local/password-reset/confirm`).set('X-Forwarded-For', ip).send({ token, new_password });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });

/** The mail text queued for the user, and the token inside its link. */
async function resetMail(userId: string): Promise<{ token: string; body: string; sensitive: boolean } | null> {
  const r = await db.query(`SELECT body_text, sensitive FROM mail_outbox WHERE to_user_id = $1 AND kind = 'identity.password_reset' ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (r.rowCount === 0) return null;
  const body = r.rows[0].body_text as string;
  const m = /\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(body);
  return { token: m![1]!, body, sensitive: r.rows[0].sensitive as boolean };
}
const mailCount = async (userId: string): Promise<number> => (await db.query(`SELECT count(*)::int AS n FROM mail_outbox WHERE to_user_id = $1 AND kind = 'identity.password_reset'`, [userId])).rows[0].n as number;

describe('POST /auth/local/password-reset/request', () => {
  it('answers the same 202 for a known account and an unknown one, and queues a mail only for the known one', async () => {
    const u = await makeUser(db, { assigned: true });
    const known = await ask(u.email);
    const unknown = await ask('nobody.here@example.test');
    const unknownId = await ask('0042');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(strip(known.body)).toEqual(strip(unknown.body));
    expect(strip(unknownId.body)).toEqual(strip(unknown.body));
    expect(await mailCount(u.id)).toBe(1);
  });

  it('stores only the SHA-256 of the token, expiring in 30 minutes, and marks the mail sensitive', async () => {
    const u = await makeUser(db, { assigned: true });
    expect((await ask(u.employeeId)).status).toBe(202);
    const mail = (await resetMail(u.id))!;
    expect(mail.sensitive).toBe(true);
    expect(mail.body).not.toContain(u.password);
    const row = (await db.query('SELECT reset_hash, reset_expires_at - reset_requested_at AS span FROM local_credentials WHERE user_id = $1', [u.id])).rows[0];
    expect(row.reset_hash).toBe(sha(mail.token));
    expect(row.reset_hash).not.toContain(mail.token);
    expect(row.span.minutes).toBe(30);
    const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'password_reset_requested' AND entity_id = $1`, [u.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('works by phone and email in any case', async () => {
    const a = await makeUser(db, { assigned: true });
    const b = await makeUser(db, { assigned: true });
    await ask(a.email.toUpperCase());
    await ask(b.phone);
    expect(await mailCount(a.id)).toBe(1);
    expect(await mailCount(b.id)).toBe(1);
  });

  it('sends one link per account every 2 minutes', async () => {
    const u = await makeUser(db, { assigned: true });
    await ask(u.email);
    const first = (await resetMail(u.id))!.token;
    expect((await ask(u.email)).status).toBe(202);
    expect(await mailCount(u.id)).toBe(1);
    expect((await resetMail(u.id))!.token).toBe(first);
  });

  it('gives no link to a System Admin, a suspended account, a pending one, a break-glass or an M365 account, with the same answer', async () => {
    const admin = await makeAdmin(db);
    const suspended = await makeUser(db, { status: 'suspended' });
    const pending = await makeUser(db, { assigned: false });
    const m365 = await makeUser(db, { assigned: true });
    await db.query(`UPDATE users SET m365_object_id = $2 WHERE id = $1`, [m365.id, `oid-${randomBytes(6).toString('hex')}`]);
    const bg = await makeUser(db, { assigned: true });
    await db.query(`UPDATE users SET is_break_glass = true WHERE id = $1`, [bg.id]);
    const ref = await ask('nobody.here@example.test');
    for (const u of [admin, suspended, pending, m365, bg]) {
      const res = await ask(u.email);
      expect(res.status).toBe(202);
      expect(strip(res.body)).toEqual(strip(ref.body));
      expect(await mailCount(u.id), u.email).toBe(0);
    }
  });

  it('gives no link when local sign-in is off for the account', async () => {
    const u = await makeUser(db, { assigned: true });
    await db.query('UPDATE local_credentials SET enabled = false WHERE user_id = $1', [u.id]);
    expect((await ask(u.email)).status).toBe(202);
    expect(await mailCount(u.id)).toBe(0);
  });

  it('drops requests quietly over 3 per identifier per hour (same 202), and answers 429 over 10 per IP', async () => {
    const u = await makeUser(db, { assigned: true });
    for (let i = 0; i < 5; i++) expect((await ask(u.email)).status).toBe(202);
    const ip = newIp();
    let last = 202;
    for (let i = 0; i < 11; i++) last = (await ask(`someone.${i}@example.test`, ip)).status;
    expect(last).toBe(429);
  });

  it('rejects a malformed body', async () => {
    const res = await request(app.getHttpServer()).post(`${API}/auth/local/password-reset/request`).set('X-Forwarded-For', newIp()).send({ nothing: true });
    expect(res.status).toBe(422);
  });
});

describe('POST /auth/local/password-reset/confirm', () => {
  const NEW = 'Fresh-Phrase-For-2026-xq';

  async function issue(): Promise<{ u: Awaited<ReturnType<typeof makeUser>>; token: string }> {
    const u = await makeUser(db, { assigned: true });
    await ask(u.email);
    return { u, token: (await resetMail(u.id))!.token };
  }

  it('sets the new password once, ends every session, signs nobody in and tells the account by mail', async () => {
    const { u, token } = await issue();
    const api = new Api(app);
    expect((await api.login(u.email, u.password)).status).toBe(200);
    const res = await confirm(token, NEW);
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await api.call('get', '/me')).status).toBe(401);
    expect((await new Api(app).login(u.email, u.password)).status).toBe(401);
    expect((await new Api(app).login(u.email, NEW)).status).toBe(200);
    const cred = (await db.query('SELECT must_change, reset_hash, reset_expires_at FROM local_credentials WHERE user_id = $1', [u.id])).rows[0];
    expect(cred).toMatchObject({ must_change: false, reset_hash: null, reset_expires_at: null });
    const audits = (await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('password_reset_by_email', 'password_changed')`, [u.id])).rows.map((r) => r.action as string);
    expect(audits).toContain('password_reset_by_email');
    const notice = await db.query(`SELECT 1 FROM mail_outbox WHERE to_user_id = $1 AND kind = 'identity.password_reset_done'`, [u.id]);
    expect(notice.rowCount).toBe(1);
  });

  it('is single use: the same link a second time is the generic 422', async () => {
    const { token } = await issue();
    expect((await confirm(token, NEW)).status).toBe(204);
    const again = await confirm(token, 'Another-Phrase-For-2026-zz');
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('invalid_code');
  });

  it('refuses an unknown link and an expired link with the same answer', async () => {
    const { u, token } = await issue();
    const unknown = await confirm(randomBytes(32).toString('base64url'), NEW);
    await db.query(`UPDATE local_credentials SET reset_expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
    const expired = await confirm(token, NEW);
    expect(unknown.status).toBe(422);
    expect(expired.status).toBe(422);
    expect(strip(expired.body)).toEqual(strip(unknown.body));
    expect((await confirm('short', NEW)).status).toBe(422);
    expect((await new Api(app).login(u.email, u.password)).status).toBe(200);
  });

  it('enforces the password policy and keeps the link alive after a weak attempt', async () => {
    const { u, token } = await issue();
    for (const pw of ['short', 'Password123456', u.email.split('@')[0]! + '-extra-2026', u.password]) {
      const res = await confirm(token, pw);
      expect(res.status, pw).toBe(422);
      expect(res.body.code, pw).toBe('weak_password');
    }
    expect((await confirm(token, NEW)).status).toBe(204);
  });

  it('does not clear a lockout and does not skip two-factor', async () => {
    const { u, token } = await issue();
    await db.query(`UPDATE local_credentials SET failed_count = 3, locked_until = now() + interval '10 minutes' WHERE user_id = $1`, [u.id]);
    expect((await confirm(token, NEW)).status).toBe(204);
    const row = (await db.query('SELECT failed_count, locked_until FROM local_credentials WHERE user_id = $1', [u.id])).rows[0];
    expect(row.failed_count).toBe(3);
    expect(row.locked_until).not.toBeNull();
    expect((await new Api(app).login(u.email, NEW)).status).toBe(401);
  });

  it('a new request replaces the old link', async () => {
    const { u, token } = await issue();
    await db.query(`UPDATE local_credentials SET reset_requested_at = now() - interval '5 minutes' WHERE user_id = $1`, [u.id]);
    await ask(u.email);
    const fresh = (await resetMail(u.id))!.token;
    expect(fresh).not.toBe(token);
    expect((await confirm(token, NEW)).status).toBe(422);
    expect((await confirm(fresh, NEW)).status).toBe(204);
  });

  it('answers 429 over 20 attempts per IP and hour', async () => {
    const ip = newIp();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await confirm(randomBytes(32).toString('base64url'), NEW, ip)).status;
    expect(last).toBe(429);
  });
});
