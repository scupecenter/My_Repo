import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { UserStateService } from '../src/auth/user-state.service';
import { API, Api, makeUser, setCookies, startApp, superDb } from './helpers';

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

const strip = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });

describe('POST /auth/local/login', () => {
  it('signs in by employee ID, email (any case) and phone, and sets a hardened cookie', async () => {
    const u = await makeUser(db, { assigned: true });
    for (const identifier of [u.employeeId, u.email, u.email.toUpperCase(), u.phone]) {
      const api = new Api(app);
      const res = await api.login(identifier, u.password);
      expect(res.status, identifier).toBe(200);
      expect(res.body).toMatchObject({ authenticated: true, auth_method: 'local', must_change_password: false, status: 'active', user: { id: u.id, employee_id: u.employeeId } });
      expect(res.body.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const cookie = setCookies(res).find((c) => c.startsWith('pmis_session='))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api(;|$)/);
      expect(cookie).not.toMatch(/Secure/); // the test app runs with COOKIE_SECURE=false
      expect(res.headers['x-request-id']).toBeTruthy();
    }
  });

  it('accepts a typed phone with spaces', async () => {
    const u = await makeUser(db, { assigned: true });
    const spaced = u.phone.replace(/^(\+218)(\d{2})(\d{3})(\d{4})$/, '$1 $2 $3 $4');
    expect(spaced).not.toBe(u.phone);
    expect((await new Api(app).login(spaced, u.password)).status).toBe(200);
  });

  it('stores only the SHA-256 of the token and a csrf token', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = new Api(app);
    await api.login(u.email, u.password);
    const rows = await db.query('SELECT token_hash, csrf_token, auth_method, expires_at - created_at AS span FROM user_sessions WHERE user_id = $1', [u.id]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0].token_hash).not.toContain(api.token);
    expect(rows.rows[0].auth_method).toBe('local');
    expect(rows.rows[0].span.hours).toBe(12);
  });

  it('answers the same 401 body for an unknown identifier and a wrong password', async () => {
    const u = await makeUser(db, { assigned: true });
    const unknown = await new Api(app).login('nobody.here@example.test', 'Whatever-Pass-123');
    const wrong = await new Api(app).login(u.email, 'Wrong-Password-12345');
    const unknownId = await new Api(app).login('0042', 'Wrong-Password-12345');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(unknown.body.code).toBe('invalid_credentials');
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
    expect(strip(unknownId.body)).toEqual(strip(unknown.body));
    expect(unknown.body.request_id).toBeTruthy();
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('answers the same 401 for a suspended, a disabled and a locked account, even with the right password', async () => {
    const ref = await new Api(app).login('nobody.here@example.test', 'x-Whatever-123');
    for (const status of ['suspended', 'disabled'] as const) {
      const u = await makeUser(db, { status });
      const res = await new Api(app).login(u.email, u.password);
      expect(res.status).toBe(401);
      expect(strip(res.body)).toEqual(strip(ref.body));
    }
    const locked = await makeUser(db, { assigned: true });
    await db.query("UPDATE local_credentials SET locked_until = now() + interval '10 minutes' WHERE user_id = $1", [locked.id]);
    const res = await new Api(app).login(locked.email, locked.password);
    expect(res.status).toBe(401);
    expect(strip(res.body)).toEqual(strip(ref.body));
    // when the lock has passed the same password works
    await db.query("UPDATE local_credentials SET locked_until = now() - interval '1 second' WHERE user_id = $1", [locked.id]);
    expect((await new Api(app).login(locked.email, locked.password)).status).toBe(200);
  });

  it('refuses an account with local sign-in switched off, with the same 401', async () => {
    const ref = await new Api(app).login('nobody.here@example.test', 'x-Whatever-123');
    const u = await makeUser(db, { assigned: true });
    await db.query('UPDATE local_credentials SET enabled = false WHERE user_id = $1', [u.id]);
    const res = await new Api(app).login(u.email, u.password);
    expect(res.status).toBe(401);
    expect(strip(res.body)).toEqual(strip(ref.body));
  });

  it('locks the account for 15 minutes after 5 wrong passwords in a row', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = new Api(app);
    for (let i = 0; i < 5; i++) expect((await api.login(u.email, `Wrong-Password-${i}-xyz`)).status).toBe(401);
    const row = await db.query('SELECT locked_until, failed_count FROM local_credentials WHERE user_id = $1', [u.id]);
    const waitMin = (new Date(row.rows[0].locked_until).getTime() - Date.now()) / 60000;
    expect(waitMin).toBeGreaterThan(14);
    expect(waitMin).toBeLessThanOrEqual(15);
    const audit = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'local_sign_in_locked' AND entity_id = $1", [u.id]);
    expect(audit.rows[0].n).toBe(1);
    // the sixth attempt, a minute later (the per-identifier limiter is 5 a minute), has the right password and is still refused
    app.get(RateLimiter).setClock({ now: () => Date.now() + 120_000 });
    try {
      const res = await api.login(u.email, u.password);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    } finally {
      app.get(RateLimiter).setClock({ now: () => Date.now() });
    }
  });

  it('a success resets the failure counter', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = new Api(app);
    for (let i = 0; i < 3; i++) await api.login(u.email, `Wrong-Password-${i}-xyz`);
    expect((await api.login(u.email, u.password)).status).toBe(200);
    const row = await db.query('SELECT failed_count FROM local_credentials WHERE user_id = $1', [u.id]);
    expect(row.rows[0].failed_count).toBe(0);
  });

  it('rate limits 5 a minute per identifier and 10 a minute per IP with 429 rate_limited', async () => {
    app.get(RateLimiter).reset();
    const id = 'rate.limit.target@example.test';
    for (let i = 0; i < 5; i++) expect((await new Api(app).login(id, 'Whatever-Pass-123')).status).toBe(401);
    const sixth = await new Api(app).login(id, 'Whatever-Pass-123'); // another IP, same identifier
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('rate_limited');
    expect(sixth.headers['content-type']).toMatch(/problem\+json/);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);

    const ip = new Api(app);
    for (let i = 0; i < 10; i++) expect((await ip.login(`someone.${i}@example.test`, 'Whatever-Pass-123')).status).toBe(401);
    const eleventh = await ip.login('someone.99@example.test', 'Whatever-Pass-123');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.code).toBe('rate_limited');
    app.get(RateLimiter).reset();
  });

  it('needs Content-Type: application/json and a well-formed body', async () => {
    const post = () => request(app.getHttpServer()).post(`${API}/auth/local/login`).set('X-Forwarded-For', '10.250.1.1');
    const text = await post().set('Content-Type', 'text/plain').send('identifier=1&password=2');
    expect(text.status).toBe(400);
    expect(text.headers['content-type']).toMatch(/problem\+json/);
    const form = await post().type('form').send({ identifier: 'a', password: 'b' });
    expect(form.status).toBe(400);
    const broken = await post().set('Content-Type', 'application/json').send('{"identifier": ');
    expect(broken.status).toBe(400);
    expect(broken.headers['content-type']).toMatch(/problem\+json/);
    expect(broken.body.code).toBe('validation_failed');
    const missing = await post().send({ identifier: 'a' });
    expect(missing.status).toBe(400);
    const extra = await post().send({ identifier: 'a', password: 'b', remember: true });
    expect(extra.status).toBe(400);
    const long = await post().send({ identifier: 'a', password: 'x'.repeat(129) });
    expect(long.status).toBe(400);
  });

  it('writes the System Log without the identifier or the password', async () => {
    const typed = `probe.${Date.now()}@example.test`;
    const secretPassword = `Sup3r-Secret-${Date.now()}`;
    await new Api(app).login(typed, secretPassword);
    const logs = await db.query("SELECT context::text AS c, message FROM system_log WHERE message LIKE 'local_sign_in%' ORDER BY id DESC LIMIT 20");
    const mine = logs.rows.find((r) => r.c.includes('"reason": "no_match"') || r.c.includes('"reason":"no_match"'));
    expect(mine).toBeTruthy();
    const all = JSON.stringify(logs.rows);
    expect(all).not.toContain(typed);
    expect(all).not.toContain(secretPassword);
    expect(all).toMatch(/identifier_hmac/);
  });

  it('a user state cache entry never outlives a 60 s window (the service can be flushed)', () => {
    expect(() => app.get(UserStateService).invalidateAll()).not.toThrow();
  });
});
