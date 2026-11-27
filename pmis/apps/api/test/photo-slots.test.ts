import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';

/**
 * Decision 32 (migration 0470): a photo field in five places, as document types of kind photo with a register placement. Optional by default, minimum 1,
 * images only, editable in Settings > Documents > Document types (the existing mandatory flag and min_files).
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

describe('photo fields of decision 32', () => {
  it('seeds one active photo type per place, optional, minimum 1, placed on the register', async () => {
    const r = await db.query(
      `SELECT dt.code, dt.kind::text AS kind, dt.is_active, dt.is_mandatory, dt.min_files, p.register_key, p.record_type
         FROM document_types dt JOIN document_type_placements p ON p.doc_type_id = dt.id
        WHERE dt.code LIKE 'PHOTO\\_%' ORDER BY dt.code`,
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.code as string, x]));
    expect(Object.keys(by).sort()).toEqual(['PHOTO_DEMO_AFTER', 'PHOTO_DEMO_BEFORE', 'PHOTO_HOTO', 'PHOTO_HSE', 'PHOTO_WH_RECEIPT', 'PHOTO_WH_RECEIPT_CW', 'PHOTO_WH_RETURN']);
    for (const x of r.rows) expect(x).toMatchObject({ kind: 'photo', is_active: true, is_mandatory: false, min_files: 1 });
    expect(by.PHOTO_DEMO_BEFORE).toMatchObject({ register_key: 'dismantle', record_type: null });
    expect(by.PHOTO_HOTO).toMatchObject({ register_key: 'readiness_handover' });
    expect(by.PHOTO_HSE).toMatchObject({ register_key: 'permits_hse' });
    expect(by.PHOTO_WH_RETURN).toMatchObject({ register_key: 'warehouse', record_type: 'sup_dn' });
  });
});
