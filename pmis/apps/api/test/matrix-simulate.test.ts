import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor, makeSite } from './wf-helpers';

/** Contract 0.15.100 (migration 0252): GET /matrix/simulate is read only, admin only, and answers per level. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
// the register cells are rewritten by several suites: one test at a time (same lock)
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('GET /matrix/simulate', () => {
  it('refuses a caller without admin.matrix and a bad query', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await a.api.call('get', '/matrix/simulate?site_id=x&kind=task&code=y')).status).toBe(422);
    const site = await makeSite(db, 7);
    expect((await a.api.call('get', `/matrix/simulate?site_id=${site.id}&kind=register&code=gecol`)).status).toBe(403);
    const api = await loggedIn(app, await makeAdmin(db));
    expect((await api.call('get', `/matrix/simulate?site_id=${site.id}&kind=other&code=gecol`)).status).toBe(422);
    expect((await api.call('get', `/matrix/simulate?site_id=${site.id}&kind=register&code=no_such_register`)).status).toBe(404);
  });

  it('answers L1 and L2 for a register, lists the named holder, falls back to the admins when a cell is empty, and writes nothing', async () => {
    const site = await makeSite(db, 7);
    const l1 = await actor(app, db, { level: 'entry', regions: [7], grants: [['gecol', 'view']] });
    await db.query(`DELETE FROM matrix_cells WHERE register_key = 'gecol' AND region_id = 7`);
    const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('gecol', 1, 'any_one', 7, false, now()) RETURNING id`);
    await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, l1.user.id]);
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const before = await db.query(`SELECT (SELECT count(*) FROM audit_log WHERE actor_id = $1)::int AS a, (SELECT count(*) FROM matrix_cells WHERE register_key = 'gecol' AND region_id = 7)::int AS m`, [admin.id]);
    const r = await api.call('get', `/matrix/simulate?site_id=${site.id}&kind=register&code=gecol`);
    expect(r.status).toBe(200);
    const lv = r.body.levels as { level_code: string; source: string; holders: { user_id: string; via: string[] }[]; fallback: { user_id: string; via: string }[] }[];
    expect(lv.map((x) => x.level_code)).toEqual(['L1', 'L2']);
    expect(lv[0]?.source).toBe('region');
    expect(lv[0]?.holders.map((h) => h.user_id)).toEqual([l1.user.id]);
    expect(lv[0]?.holders[0]?.via).toEqual(['named']);
    expect(lv[0]?.fallback).toEqual([]);
    if (lv[1]?.holders.length === 0) expect(lv[1].fallback.some((f) => f.user_id === admin.id && f.via === 'system_admin')).toBe(true);
    const after = await db.query(`SELECT (SELECT count(*) FROM audit_log WHERE actor_id = $1)::int AS a, (SELECT count(*) FROM matrix_cells WHERE register_key = 'gecol' AND region_id = 7)::int AS m`, [admin.id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
