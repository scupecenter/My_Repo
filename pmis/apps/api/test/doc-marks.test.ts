import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, plainAdmin, type Actor } from './wf-helpers';

/** Migration 0555: the signed and stamped copy markers. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let nobody: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  nobody = await actor(app, db, { level: 'view', grants: [], regions: [5], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('document marks (0555)', () => {
  it('reads nothing set by default and takes a change from an admin with a reason, audited', async () => {
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Receipt', now()) RETURNING code`, [`MK${Date.now()}`]);
    const code = dt.rows[0].code as string;
    const before = await admin.api.call('get', '/settings/document-marks');
    expect(before.status).toBe(200);
    expect(before.body.types[code]).toBeUndefined();
    const noReason = await admin.api.call('put', `/settings/document-marks/${code}`, { signature: true, stamp: true });
    expect(noReason.status).toBe(422);
    const set = await admin.api.call('put', `/settings/document-marks/${code}`, { signature: true, stamp: false, reason: 'Receipts are signed' });
    expect(set.status).toBe(200);
    expect(set.body.types[code]).toEqual({ signature: true, stamp: false });
    const a = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'document_type_marks_update' AND entity_id = 'documents.marks'`);
    expect(a.rows[0].n).toBeGreaterThanOrEqual(1);
    const off = await admin.api.call('put', `/settings/document-marks/${code}`, { signature: false, stamp: false, reason: 'No longer needed' });
    expect(off.body.types[code]).toBeUndefined();
    expect((await admin.api.call('put', '/settings/document-marks/NO_SUCH_TYPE', { signature: true, stamp: true, reason: 'x test' })).status).toBe(422);
  });

  it('refuses a change from a caller without the right', async () => {
    const r = await nobody.api.call('put', '/settings/document-marks/A1', { signature: true, stamp: true, reason: 'not allowed' });
    expect([403, 401]).toContain(r.status);
  });
});
