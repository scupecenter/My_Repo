import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { plainAdmin } from './wf-helpers';

/**
 * Drift guard: every active column of a register (register_fields) is also in the column admin screen (the form), in the register template (tpl_columns,
 * the source of the template header, the export of the template and the import map: the import finds a column by its header in the template version).
 * A column that is added or reactivated in one place and missing in another fails here, with the register and the code in the message.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('register columns drift', () => {
  it('every active register column is in the template columns', async () => {
    const regs = await q<{ register_key: string }>(db, `SELECT register_key FROM register_definitions ORDER BY register_key`);
    expect(regs.length).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const r of regs) {
      const active = await q<{ code: string }>(db, `SELECT code FROM register_fields WHERE register_key = $1 AND is_active`, [r.register_key]);
      const cols = (await q<{ c: { kind: string; code: string }[] }>(db, `SELECT tpl_columns($1) AS c`, [r.register_key]))[0]!.c;
      const inTemplate = new Set(cols.filter((c) => c.kind === 'field').map((c) => c.code));
      for (const f of active) if (!inTemplate.has(f.code)) missing.push(`${r.register_key}.${f.code}`);
    }
    expect(missing).toEqual([]);
  });

  it('every active register column is on the column admin screen (the form)', async () => {
    const admin = await plainAdmin(app, db, true);
    const regs = await q<{ register_key: string }>(db, `SELECT register_key FROM register_definitions ORDER BY register_key`);
    const missing: string[] = [];
    for (const r of regs) {
      const active = await q<{ code: string }>(db, `SELECT code FROM register_fields WHERE register_key = $1 AND is_active`, [r.register_key]);
      const res = await admin.api.call('get', `/registers/${r.register_key}/fields`);
      expect(res.status, r.register_key).toBe(200);
      const codes = new Set((res.body.fields as { code: string }[]).map((f) => f.code));
      for (const f of active) if (!codes.has(f.code)) missing.push(`${r.register_key}.${f.code}`);
    }
    expect(missing).toEqual([]);
  });
});
