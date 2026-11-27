import { Client as PgClient } from 'pg';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { beginAs, makeUser, startApp, superDb } from './helpers';
import { Actor, plainAdmin } from './wf-helpers';

/** Passkey doors (migration 0294), straight against the database: off by default, single-use challenge, atomic counter, revoke never deletes, admin recovery, KEEP in reset plan. */
let db: Pg;
let app: NestExpressApplication;
let admin: Actor;
beforeAll(async () => { app = await startApp(); db = await superDb(); admin = await plainAdmin(app, db); });
afterAll(async () => { await db.end(); await app.close(); });

const CRED = 'A'.repeat(22), KEY = 'B'.repeat(40);
async function tx(fn: (c: PgClient) => Promise<void>): Promise<void> {
  const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); await c.end(); }
}

describe('passkey doors', () => {
  it('is off by default: no creds, no challenge, no add; the setting row exists and reads false', async () => {
    const u = await makeUser(db, { assigned: true });
    expect((await db.query(`SELECT value FROM settings WHERE key = 'security.passkeys'`)).rows[0].value).toEqual({ enabled: false });
    await tx(async (c) => {
      await beginAs(c, u.id);
      expect((await c.query('SELECT * FROM auth_passkey_creds($1::uuid)', [u.id])).rowCount).toBe(0);
      await c.query('SAVEPOINT s');
      await expect(c.query(`SELECT auth_passkey_challenge_create($1::uuid, $2, 'register')`, [u.id, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK TO s');
      await expect(c.query(`SELECT passkey_add($1, $2, 0, '{}', 'singleDevice', false, 'Phone')`, [CRED, KEY])).rejects.toBeTruthy();
    });
  });

  it('a user cannot act for another user', async () => {
    const u = await makeUser(db, { assigned: true }), v = await makeUser(db, { assigned: true });
    await tx(async (c) => {
      await beginAs(c, u.id);
      await expect(c.query('SELECT * FROM auth_passkey_creds($1::uuid)', [v.id])).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('enabled: add, single-use challenge, atomic counter, revoke keeps the row, admin revoke, and the audit rows', async () => {
    const u = await makeUser(db, { assigned: true });
    const adm = admin.user;
    await tx(async (c) => {
      await beginAs(c, adm.id);
      await c.query(`SELECT admin_set_passkeys(true, 'Owner decision for the test', NULL)`);
      await c.query('SAVEPOINT d');
      await expect(c.query(`SELECT admin_set_passkeys(true, 'Owner decision for the test', NULL)`)).rejects.toBeTruthy();
      await c.query('ROLLBACK TO d');
      await beginAs(c, u.id);
      const h = 'c'.repeat(64);
      await c.query(`SELECT auth_passkey_challenge_create($1::uuid, $2, 'authenticate')`, [u.id, h]);
      expect((await c.query(`SELECT auth_passkey_challenge_take($1::uuid, $2, 'register') AS ok`, [u.id, h])).rows[0].ok).toBe(false);
      expect((await c.query(`SELECT auth_passkey_challenge_take($1::uuid, $2, 'authenticate') AS ok`, [u.id, h])).rows[0].ok).toBe(true);
      expect((await c.query(`SELECT auth_passkey_challenge_take($1::uuid, $2, 'authenticate') AS ok`, [u.id, h])).rows[0].ok).toBe(false); // replay
      const added = (await c.query(`SELECT passkey_add($1, $2, 0, '{internal}', 'multiDevice', true, 'Phone') AS r`, [CRED, KEY])).rows[0].r;
      expect(added).toMatchObject({ label: 'Phone', device_type: 'multiDevice' });
      expect(JSON.stringify(added)).not.toContain(KEY);
      expect((await c.query('SELECT * FROM auth_passkey_creds($1::uuid)', [u.id])).rows[0]).toMatchObject({ credential_id: CRED, public_key: KEY });
      expect((await c.query(`SELECT auth_passkey_used($1::uuid, $2, 5) AS r`, [u.id, CRED])).rows[0].r).toBe('ok');
      expect((await c.query(`SELECT auth_passkey_used($1::uuid, $2, 5) AS r`, [u.id, CRED])).rows[0].r).toBe('clone');
      expect((await c.query(`SELECT auth_passkey_used($1::uuid, $2, 2) AS r`, [u.id, CRED])).rows[0].r).toBe('clone');
      expect((await c.query(`SELECT auth_passkey_used($1::uuid, $2, 6) AS r`, [u.id, 'Z'.repeat(22)])).rows[0].r).toBe('unknown');
      expect((await c.query(`SELECT auth_passkey_used($1::uuid, $2, 9) AS r`, [u.id, CRED])).rows[0].r).toBe('ok');
      // someone else cannot revoke it; the admin can, the row stays
      await beginAs(c, adm.id);
      expect((await c.query(`SELECT passkey_revoke($1::uuid) AS r`, [added.id])).rows[0].r).toBe(false);
      await expect(c.query(`SELECT admin_passkey_revoke($1::uuid, 'ab')`, [u.id])).rejects.toBeTruthy();
    });
    await tx(async (c) => {
      await beginAs(c, adm.id);
      await c.query(`SELECT admin_set_passkeys(true, 'Owner decision for the test', NULL)`);
      await beginAs(c, u.id);
      await c.query(`SELECT passkey_add($1, $2, 0, '{}', 'singleDevice', false, 'Key')`, [CRED, KEY]);
      await beginAs(c, adm.id);
      expect((await c.query(`SELECT admin_passkey_revoke($1::uuid, 'Lost device, owner asked') AS n`, [u.id])).rows[0].n).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM auth_passkey WHERE user_id = $1 AND revoked_at IS NOT NULL`, [u.id])).rows[0].n).toBe(1);
      await beginAs(c, u.id);
      expect((await c.query('SELECT * FROM auth_passkey_creds($1::uuid)', [u.id])).rowCount).toBe(0);
      const a = await c.query(`SELECT action FROM audit_log WHERE entity_id = $1 `, [u.id]);
      expect(a.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['passkey_added', 'passkeys_revoked_by_admin']));
    });
  });

  it('both tables are in the data reset plan and the reset role can read them', async () => {
    const r = await db.query(`SELECT pg_get_functiondef('public.data_reset_plan()'::regprocedure) AS d`);
    expect(r.rows[0].d).toContain('auth_passkey_challenge');
    const g = await db.query(`SELECT has_table_privilege('pmis_reset_owner', 'public.auth_passkey', 'SELECT') AS a, has_table_privilege('pmis_reset_owner', 'public.auth_passkey_challenge', 'UPDATE') AS b`);
    expect(g.rows[0]).toEqual({ a: true, b: true });
  });
});
