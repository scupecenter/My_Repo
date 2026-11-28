import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { G, Team, approveAll, createRec, recPath, team } from './reg-helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.457 (migration 0597): the Tools & Equipment register (C4). */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;

const OK = { equipment_no: 'EQ-001', name: 'Total station', category: 'Survey', next_due_date: '2027-03-01' };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, 'tools_equipment', 'tools_equipment', 5);
});
afterAll(async () => {
  await db.end();
});

describe('tools and equipment register', () => {
  it('is listed with two levels, its fields and the template', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const res = await api.call('get', '/registers');
    expect(res.status).toBe(200);
    const def = (res.body.items as { register_key: string; approval_levels: number; site_scoped: boolean; fields: { code: string }[] }[]).find((r) => r.register_key === 'tools_equipment');
    expect(def?.approval_levels).toBe(2);
    expect(def?.site_scoped).toBe(true);
    expect(def?.fields.map((f) => f.code)).toEqual(expect.arrayContaining(['equipment_no', 'name', 'category', 'custodian', 'due_kind', 'next_due_date']));
    const tpl = await db.query(`SELECT 1 FROM template_definitions WHERE template_id = 'TPL-TOOLS-EQUIPMENT' AND register_key = 'tools_equipment'`);
    expect(tpl.rowCount).toBe(1);
  });

  it('feeds the expiry radar and seeds no matrix holder', async () => {
    const radar = await db.query(`SELECT value->'registers'->'tools_equipment'->>'field' AS f FROM settings WHERE key = 'expiry.radar'`);
    expect(radar.rows[0]?.f).toBe('next_due_date');
    const holders = await db.query(`SELECT count(*)::int AS n FROM matrix_cells WHERE register_key = 'tools_equipment' AND region_id IS NULL`);
    expect(holders.rows[0].n).toBe(0);
  });

  it('runs entry to approval', async () => {
    const rec = await createRec(t, OK);
    expect(rec.state).toBe('entry');
    expect((await approveAll(t, rec.id, rec.version)).state).toBe('approved');
  });

  it('refuses a caller without the module grant', async () => {
    const a = await actor(app, db, { grants: G('sites', 'view'), regions: [5], modules: null });
    expect((await a.api.call('get', recPath('tools_equipment'))).status).toBe(403);
  });
});
