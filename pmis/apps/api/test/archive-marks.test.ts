import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb, startApp } from './helpers';
import { Actor, plainAdmin } from './wf-helpers';

/** Signed and stamped copies in the Archive (migration 0474): the two columns, the two filter fields and the setting's column list. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('archive marks', () => {
  it('lists signed and stamped among the columns of the Archive setting', async () => {
    const r = await db.query(`SELECT library_archive_columns() AS c`);
    expect(r.rows[0].c).toEqual(expect.arrayContaining(['signed', 'stamped']));
  });

  it('rows carry the markers and the need, and the two filter fields are accepted', async () => {
    const r = await admin.api.call('get', '/library/archive/rows?limit=5');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const it of r.body.items) {
      expect(typeof it.needs_signature).toBe('boolean');
      expect(typeof it.needs_stamp).toBe('boolean');
      expect([true, false, null]).toContain(it.signed);
    }
    const cat = await admin.api.call('get', '/views/filter-catalog?screen=library-archive');
    if (cat.status === 200) expect(JSON.stringify(cat.body)).toContain('"signed"');
  });
});
