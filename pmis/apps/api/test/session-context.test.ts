import { createHmac, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';
import { canonicalContext, parseContextKey, signContext, toWire } from '../src/db/session-context';
import { TEST_CONTEXT_KEY } from './global-setup';
import { beginAs, ensureRole, makeAdmin, makeUser, superDb, type TestUser } from './helpers';

/**
 * The helper that builds, signs and starts the verified session context (migration 0069), and what the database does with it.
 * The database-only attacks (forged settings, tampered MAC, replay) are in tests/db-security/cases/C3_session_context.sql; here the API helper itself
 * is exercised against the real database as pmis_app.
 */
describe('session context helper (app_begin, migration 0069)', () => {
  let sup: Client;
  let app: Client;
  let admin: TestUser;
  let tripoli: TestUser;
  let nobody: TestUser;

  beforeAll(async () => {
    sup = await superDb();
    app = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await app.connect();
    admin = await makeAdmin(sup);
    tripoli = await makeUser(sup, { status: 'active' });
    nobody = await makeUser(sup, { status: 'active' });
    const role = await ensureRole(sup, 'CTX_ROLE');
    // one transaction: the assignment needs its region before it commits (a deferred check)
    await sup.query('BEGIN');
    const a = await sup.query(
      `INSERT INTO user_role_assignments (user_id, role_id, permission_level, team, all_regions, all_modules, valid_from) VALUES ($1, $2, 'entry', 'cw', false, true, now() - interval '1 hour') RETURNING id`,
      [tripoli.id, role],
    );
    await sup.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1)', [a.rows[0].id]);
    await sup.query('COMMIT');
  });

  afterAll(async () => {
    await app.end();
    await sup.end();
  });

  /** A transaction on the pmis_app connection; always rolled back. */
  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  }

  it('canonical text: each field as <byte length>:<value>, a missing one as -, in the fixed order', () => {
    const w = toWire({ userId: '00000000-0000-4000-8000-000000000001', mfa: true, userAgent: 'été', requestId: 'r-1' }, new Date('2026-11-04T10:00:00.000Z'));
    expect(canonicalContext(w)).toBe(['1:1', '36:00000000-0000-4000-8000-000000000001', '-', '-', '-', '4:true', '-', '-', '3:r-1', '-', '5:été', '-', '-', '24:2026-11-04T10:00:00.000Z'].join('|'));
  });

  it('the signature is HMAC-SHA256 over begin|txid|canonical text, so another transaction id gives another signature', () => {
    const key = parseContextKey(TEST_CONTEXT_KEY) as Buffer;
    const w = toWire({ userId: admin.id });
    const sig = signContext(key, '100', w);
    expect(sig.equals(createHmac('sha256', key).update(`begin|100|${canonicalContext(w)}`).digest())).toBe(true);
    expect(sig.equals(signContext(key, '101', w))).toBe(false);
    expect(parseContextKey('abc')).toBeNull();
    expect(parseContextKey(randomBytes(32).toString('hex'))).not.toBeNull();
  });

  it('the API refuses to start without a valid PMIS_CONTEXT_KEY, and never prints it', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://x', LOG_HMAC_KEY: '0123456789abcdef0123', TOTP_ENC_KEY: 'a'.repeat(64), FILE_ENC_KEY: 'b'.repeat(64) };
    expect(() => loadConfig(env)).toThrow(/PMIS_CONTEXT_KEY/);
    const secret = 'z'.repeat(63);
    let message = '';
    try {
      loadConfig({ ...env, PMIS_CONTEXT_KEY: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/PMIS_CONTEXT_KEY/);
    expect(message).not.toContain(secret);
    expect(loadConfig({ ...env, PMIS_CONTEXT_KEY: TEST_CONTEXT_KEY }).contextKey).toBe(TEST_CONTEXT_KEY);
  });

  it('the database matches the helper byte for byte: the canonical text it computes is the one the API signs', async () => {
    const w = toWire({ userId: tripoli.id, mfa: false, userAgent: 'Mozilla/5.0 (été) | x', device: '{"os":"Linux"}', requestId: 'req|1' });
    const r = await sup.query('SELECT app_ctx_canon($1::jsonb) AS c', [JSON.stringify(w)]);
    expect(r.rows[0].c).toBe(canonicalContext(w));
  });

  it('derives the regions from the data: an assigned user gets their regions, a System Admin all, an unassigned user none', async () => {
    await inTx(async () => {
      expect((await beginAs(app, tripoli.id)).regions).toBe('1');
      expect((await app.query('SELECT app_ctx_regions() AS r, app_actor() AS a')).rows[0]).toEqual({ r: '1', a: tripoli.id });
    });
    await inTx(async () => {
      const r = await beginAs(app, admin.id);
      expect(r).toMatchObject({ admin: true, regions: '*' });
    });
    await inTx(async () => {
      expect((await beginAs(app, nobody.id)).regions).toBe('');
      expect((await app.query('SELECT count(*)::int AS n FROM clusters')).rows[0].n).toBe(0);
    });
  });

  it('a plain setting cannot widen a verified context', async () => {
    await inTx(async () => {
      await beginAs(app, tripoli.id);
      await app.query(`SELECT set_config('app.region_ids', '*', true), set_config('app.user_id', $1, true), set_config('app.stepup', 'true', true)`, [admin.id]);
      const r = await app.query('SELECT app_ctx_regions() AS r, app_actor() AS a, app_actor_is_system_admin() AS adm, app_ctx_stepup() AS su');
      expect(r.rows[0]).toEqual({ r: '1', a: tripoli.id, adm: false, su: false });
    });
  });

  it('a signed step-up is a step-up only while it runs, and the signed value is the only one that counts', async () => {
    await inTx(async () => {
      await beginAs(app, tripoli.id, { stepupUntil: new Date(Date.now() + 60_000) });
      expect((await app.query('SELECT app_ctx_stepup() AS su')).rows[0].su).toBe(true);
    });
    await inTx(async () => {
      await beginAs(app, tripoli.id, { stepupUntil: new Date(Date.now() - 1000) });
      expect((await app.query('SELECT app_ctx_stepup() AS su')).rows[0].su).toBe(false);
    });
  });

  it('the audit labels come from the signed context, not from plain settings', async () => {
    await inTx(async () => {
      await beginAs(app, tripoli.id, { ip: '203.0.113.7', requestId: 'req-ctx-1', sessionId: '00000000-0000-4000-8000-0000000000aa', jobName: 'x_job', via: 'job' });
      await app.query(`SELECT set_config('app.ip', '198.51.100.1', true), set_config('app.request_id', 'forged', true)`);
      const r = await app.query(`SELECT log_ctx('ip') AS ip, log_ctx('request_id') AS rid, log_ctx('session_id') AS sid, log_ctx('job_name') AS job, log_ctx('via') AS via`);
      expect(r.rows[0]).toEqual({ ip: '203.0.113.7', rid: 'req-ctx-1', sid: '00000000-0000-4000-8000-0000000000aa', job: 'x_job', via: 'job' });
    });
  });

  it('a job with no user gets no actor and no region', async () => {
    await inTx(async () => {
      expect(await beginAs(app, null, { via: 'job', jobName: 'mail_send' })).toMatchObject({ user_id: null, admin: false, regions: '' });
      expect((await app.query('SELECT app_actor() AS a, app_ctx_regions() AS r')).rows[0]).toEqual({ a: null, r: '' });
    });
  });

  it('is refused for a wrong key, a stale or future time, and a signature made for another transaction', async () => {
    const wrong = randomBytes(32);
    await inTx(async () => {
      const tx = (await app.query('SELECT txid_current()::text AS t')).rows[0].t as string;
      const w = toWire({ userId: tripoli.id });
      await expect(app.query('SELECT app_begin($1::jsonb, $2::bytea)', [JSON.stringify(w), signContext(wrong, tx, w)])).rejects.toThrow(/bad signature/);
    });
    for (const [offset, what] of [[-120_000, 'expired'], [3_600_000, 'expired']] as const) {
      await inTx(async () => {
        const tx = (await app.query('SELECT txid_current()::text AS t')).rows[0].t as string;
        const w = toWire({ userId: tripoli.id }, new Date(Date.now() + offset));
        await expect(app.query('SELECT app_begin($1::jsonb, $2::bytea)', [JSON.stringify(w), signContext(parseContextKey(TEST_CONTEXT_KEY) as Buffer, tx, w)])).rejects.toThrow(new RegExp(what));
      });
    }
    // replay: signed for this transaction, presented in the next one
    const key = parseContextKey(TEST_CONTEXT_KEY) as Buffer;
    const w = toWire({ userId: tripoli.id });
    let sig: Buffer = Buffer.alloc(0);
    await inTx(async () => {
      const tx = (await app.query('SELECT txid_current()::text AS t')).rows[0].t as string;
      sig = signContext(key, tx, w);
    });
    await inTx(async () => {
      await app.query('SELECT txid_current()');
      await expect(app.query('SELECT app_begin($1::jsonb, $2::bytea)', [JSON.stringify(w), sig])).rejects.toThrow(/bad signature/);
    });
  });

  it('a user deactivated after the context was signed is refused', async () => {
    const u = await makeUser(sup, { status: 'active' });
    await app.query('BEGIN');
    try {
      const key = parseContextKey(TEST_CONTEXT_KEY) as Buffer;
      const tx = (await app.query('SELECT txid_current()::text AS t')).rows[0].t as string;
      const w = toWire({ userId: u.id });
      const sig = signContext(key, tx, w);
      // the System Admin suspends the account between signing and the call (another connection, committed)
      await sup.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
      await expect(app.query('SELECT app_begin($1::jsonb, $2::bytea)', [JSON.stringify(w), sig])).rejects.toThrow(/unknown or inactive user/);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('a pending user may begin a context (they sign in today) and sees nothing', async () => {
    const u = await makeUser(sup, { status: 'pending_assignment' });
    await inTx(async () => {
      expect(await beginAs(app, u.id)).toMatchObject({ user_id: u.id, admin: false, regions: '' });
      expect((await app.query('SELECT app_actor() AS a')).rows[0].a).toBeNull();
    });
  });

  it('the application role cannot read the keys or install one', async () => {
    await expect(app.query('SELECT count(*) FROM pmis_context_keys')).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT app_ctx_key_install($1)`, [randomBytes(32).toString('hex')])).rejects.toThrow(/permission denied/);
  });

  it('keys rotate: a second key verifies beside the first, and a retired key stops verifying', async () => {
    const second = randomBytes(32);
    await sup.query('SELECT app_ctx_key_install($1)', [second.toString('hex')]);
    try {
      await inTx(async () => {
        const tx = (await app.query('SELECT txid_current()::text AS t')).rows[0].t as string;
        const w = toWire({ userId: tripoli.id });
        await app.query('SELECT app_begin($1::jsonb, $2::bytea)', [JSON.stringify(w), signContext(second, tx, w)]);
        expect((await app.query('SELECT app_actor() AS a')).rows[0].a).toBe(tripoli.id);
      });
      // retire the second key at once
      await sup.query(`UPDATE pmis_context_keys SET expires_at = now() - interval '1 second' WHERE key = $1`, [second]);
      await inTx(async () => {
        const tx = (await app.query('SELECT txid_current()::text AS t')).rows[0].t as string;
        const w = toWire({ userId: tripoli.id });
        await expect(app.query('SELECT app_begin($1::jsonb, $2::bytea)', [JSON.stringify(w), signContext(second, tx, w)])).rejects.toThrow(/bad signature/);
      });
      // the first key still works
      await inTx(async () => {
        expect((await beginAs(app, tripoli.id)).regions).toBe('1');
      });
    } finally {
      await sup.query('DELETE FROM pmis_context_keys WHERE key = $1', [second]);
    }
  });
});
