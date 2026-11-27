import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.94: GET /matrix/coverage is read only, admin only, and its counts are consistent. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

describe('GET /matrix/coverage', () => {
  it('a caller without admin.matrix is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    const r = await a.api.call('get', '/matrix/coverage');
    expect(r.status).toBe(403);
  });

  it('refuses a bad workflow_version and an unknown one', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    expect((await api.call('get', '/matrix/coverage?workflow_version=abc')).status).toBe(422);
    expect((await api.call('get', '/matrix/coverage?workflow_version=999999')).status).toBe(404);
  });

  it('a System Admin gets every region and both levels per row, the summary adds up and no matrix cell changes', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const before = await db.query(`SELECT count(*)::int AS n, max(updated_at) AS u FROM matrix_cells`);
    const r = await api.call('get', '/matrix/coverage');
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.regions.length).toBe(7);
    let cells = 0;
    const by: Record<string, number> = { ok: 0, empty: 0, no_active_holder: 0 };
    for (const row of b.rows) {
      expect(row.cells.length).toBe(b.regions.length * 2);
      expect(row.gaps).toBe(row.cells.filter((c: { status: string }) => c.status !== 'ok').length);
      for (const c of row.cells) {
        cells += 1;
        by[c.status] = (by[c.status] ?? 0) + 1;
        if (c.status === 'empty') expect(c.assignees === 0).toBe(true);
        if (c.status === 'ok') expect(c.holders).toBeGreaterThan(0);
        if (c.source === 'none') expect(c.assignees).toBe(0);
      }
    }
    expect(b.summary).toEqual({ cells, ok: by.ok, empty: by.empty, no_active_holder: by.no_active_holder });
    const after = await db.query(`SELECT count(*)::int AS n, max(updated_at) AS u FROM matrix_cells`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
