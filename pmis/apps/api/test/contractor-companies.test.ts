import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.88: GET /registers/contractor-companies (the pick list of the Contractor of a Procurement, GECOL or HLC record). */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

describe('contractor companies', () => {
  it('a caller without view on Procurement, GECOL or HLC is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await a.api.call('get', '/registers/contractor-companies')).status).toBe(403);
  });

  it('lists active companies with an active contract and their scopes, never an inactive company or a terminated contract', async () => {
    const tag = `CC${Date.now()}`;
    const mk = async (name: string, active: boolean, status: string, scopes: string[] | null) => {
      const p = await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', $2) RETURNING id`, [name, active]);
      await db.query(`INSERT INTO external_party_contracts (id, party_id, scopes, status, origin) VALUES (gen_random_uuid(), $1, $2, $3, 'company')`, [p.rows[0].id, scopes, status]);
    };
    await mk(`${tag} Active`, true, 'active', ['Fiber', 'Tower RT']);
    await mk(`${tag} Open`, true, 'active', null);
    await mk(`${tag} Inactive`, false, 'active', ['Fiber']);
    await mk(`${tag} Terminated`, true, 'terminated', ['Fiber']);
    const api = await loggedIn(app, await makeAdmin(db));
    const r = await api.call('get', '/registers/contractor-companies');
    expect(r.status).toBe(200);
    const mine = (r.body.items as { name: string; scopes: string[] | null }[]).filter((i) => i.name.startsWith(tag));
    expect(mine.map((i) => i.name).sort()).toEqual([`${tag} Active`, `${tag} Open`]);
    expect(mine.find((i) => i.name.endsWith('Active'))?.scopes).toEqual(['Fiber', 'Tower RT']);
    expect(mine.find((i) => i.name.endsWith('Open'))?.scopes).toBeNull();
    // it only reads
    const before = await db.query(`SELECT count(*)::int AS n FROM external_parties`);
    await api.call('get', '/registers/contractor-companies');
    expect((await db.query(`SELECT count(*)::int AS n FROM external_parties`)).rows[0].n).toBe(before.rows[0].n);
  });
});
