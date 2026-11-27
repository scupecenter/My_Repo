import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor } from './wf-helpers';

/** Migration 0257: a site that looks like an existing one gets a warning (name, coordinates, similar Site ID), never an error. Region 7 is the working region. */
let app: NestExpressApplication;
let db: PgClient;
const R = 7;
const TAG = randomBytes(3).toString('hex').toUpperCase();
let l1: Actor;
type W = { field: string; code: string; message: string };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  l1 = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites', 'create']] });
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = 1 AND region_id = $2', ['site_creation', R]);
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('site_creation', 1, 'any_one', $1, false, now()) RETURNING id`, [R]);
  await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, l1.user.id]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const base = (over: Record<string, unknown>): Record<string, unknown> => ({ region_id: R, delivery_scenario: 'new_build', ...over });

describe('duplicate-site warnings', () => {
  it('warns on the same name and on close coordinates of a waiting draft, never blocks, and names the site of the same region', async () => {
    const a = `DW${TAG}A`;
    const first = await l1.api.call('post', '/sites', base({ site_code: a, name: `Dup Name ${TAG}`, latitude: '32.887000', longitude: '13.191000' }));
    expect(first.status).toBe(201);
    const b = `DW${TAG}B`;
    const second = await l1.api.call('post', '/sites', base({ site_code: b, name: `  dup  name ${TAG} `, latitude: '32.887200', longitude: '13.191000' }));
    expect(second.status).toBe(201);
    const w = second.body.warnings as W[];
    expect(w.find((x) => x.code === 'duplicate_name')?.message).toContain(a);
    expect(w.find((x) => x.code === 'close_coordinates')?.message).toContain(a);
    // 0.002 degrees of latitude is about 220 metres: not close
    const far = await l1.api.call('post', '/sites', base({ site_code: `DW${TAG}C`, name: `Other ${TAG}`, latitude: '32.889000', longitude: '13.191000' }));
    expect(far.status).toBe(201);
    expect((far.body.warnings as W[]).map((x) => x.code)).not.toContain('close_coordinates');
  });

  it('warns on a Site ID that differs only by case, dashes or spaces, and the exact Site ID is still refused', async () => {
    const a = `DW${TAG}-X1`;
    expect((await l1.api.call('post', '/sites', base({ site_code: a, name: `Code A ${TAG}` }))).status).toBe(201);
    const near = await l1.api.call('post', '/sites', base({ site_code: `DW${TAG}X1`, name: `Code B ${TAG}` }));
    expect(near.status).toBe(201);
    expect((near.body.warnings as W[]).find((x) => x.code === 'similar_site_code')?.message).toContain(a);
    expect((await l1.api.call('post', '/sites', base({ site_code: a, name: `Code C ${TAG}` }))).status).toBe(422);
  });

  it('says only that a match exists when it is in another region (no Site ID, no name)', async () => {
    const r = await db.query(`SELECT site_new_dup_warnings($1::jsonb, NULL) AS w`, [JSON.stringify({ site_code: `DW${TAG}Z`, region_id: 98, name: `Dup Name ${TAG}`, latitude: 32.8871, longitude: 13.191 })]);
    const w = r.rows[0].w as W[];
    const msgs = w.filter((x) => x.code === 'duplicate_name' || x.code === 'close_coordinates').map((x) => x.message);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    for (const m of msgs) {
      expect(m).toContain('another region');
      expect(m).not.toContain(`DW${TAG}`);
    }
  });
});
