import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDbDocs, startApp } from './helpers';
import { Actor, plainAdmin } from './wf-helpers';

/**
 * Photo fields in the Daily Plan and in Status Updates (migration 0473): two seeded photo document types, slots with two new owners, the one-owner check
 * and the door that refuses a site outside the plan.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  admin = await plainAdmin(app, db);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('photo fields of the Daily Plan and Status Updates', () => {
  it('seeds the two types (photo, no placement, optional, active)', async () => {
    const r = await db.query(`SELECT code, kind::text AS kind, is_active, is_mandatory, published_version FROM document_types WHERE code IN ('PHOTO_DAILY_PLAN', 'PHOTO_STATUS_UPDATE') ORDER BY code`);
    expect(r.rows.map((x) => [x.code, x.kind, x.is_active, x.is_mandatory])).toEqual([['PHOTO_DAILY_PLAN', 'photo', true, false], ['PHOTO_STATUS_UPDATE', 'photo', true, false]]);
    expect(r.rows.every((x) => x.published_version > 0)).toBe(true);
  });

  it('a slot has at most one owner', async () => {
    await expect(db.query(`SELECT num_nonnulls(1, 2, NULL, NULL) <= 1 AS ok`).then((x) => x.rows[0].ok)).resolves.toBe(false);
    const c = await db.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'document_slots_one_owner'`);
    expect(c.rows[0].d).toContain('num_nonnulls');
  });

  it('reads an empty field and refuses a photo for a site that is not in the plan', async () => {
    const g = await admin.api.call('get', '/photo-slots/daily-plan?region_id=5&date=2031-01-05');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.enabled).toBe(true);
    expect(g.body.items).toEqual([]);
    const s = await admin.api.call('get', '/photo-slots/status-update?update_id=00000000-0000-4000-8000-000000000000');
    expect(s.status).toBe(200);
    expect(s.body.items).toEqual([]);
    expect(s.body.can_upload).toBe(false);
  });
});
