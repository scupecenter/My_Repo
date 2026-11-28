import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { PROC, createRec, team } from './reg-helpers';
import { plainAdmin } from './wf-helpers';

/**
 * The "open record" link of a Gallery card carries the ROW id of the register record (the id the register page matches ?record= against, like every other
 * in-app link), not the logical entity id that document slots are keyed on.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
}, 120_000);
afterAll(async () => {
  await db?.end();
  await app?.close();
});

describe('Media gallery record link', () => {
  it('a register-slot item links to the record row id, not the entity id', async () => {
    const admin = await plainAdmin(app, db);
    const t = await team(app, db, 'procurement', 'procurement', 5);
    const rec = await createRec(t, PROC);
    expect(rec.entity_id).not.toBe(rec.id);
    const dt = await db.query(`INSERT INTO document_types (code, name_en, kind, updated_at) VALUES ($1, 'Link test photo', 'photo', now()) RETURNING id`, [`LNK_${randomUUID().slice(0, 6).toUpperCase()}`]);
    const slot = await db.query(
      `INSERT INTO document_slots (site_id, region_id, doc_type_id, register_key, register_entity_id) VALUES ($1, 5, $2, 'procurement', $3) RETURNING id`,
      [t.site.id, dt.rows[0].id, rec.entity_id]);
    const f = await db.query(
      `INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by, is_current)
       VALUES ($1, gen_random_uuid(), 'l.png', 'l.png', $2, 'image/png', 'png', 10, $3, $4, true) RETURNING id`,
      [slot.rows[0].id, `docs/2026/11/${randomUUID()}`, 'c'.repeat(64), admin.user.id]);
    const r = await admin.api.call('get', `/media/items?site_id=${t.site.id}`);
    expect(r.status).toBe(200);
    const it0 = (r.body.items as { id: string; link: { kind: string; record_id?: string } }[]).find((x) => x.id === f.rows[0].id);
    expect(it0?.link).toMatchObject({ kind: 'register', record_id: rec.id });
  });
});
