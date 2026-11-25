import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { day, downloadTemplate, fillTemplate, uploadFile } from './tpl-helpers';
import { plainAdmin } from './wf-helpers';

/**
 * Owner decision D112 (migration 0060): a file of an older template version is accepted when only non-input columns changed between its version and the
 * current one, and refused, with the changed typed columns named, when any input column changed. Meetings (TPL-MEETINGS). The suites that issue new template
 * versions share the advisory lock 770101.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });
afterAll(async () => {
  await db.end();
  await app.close();
});

const version = async (): Promise<number> => (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MEETINGS'`))[0]!.v;

describe('older template versions (D112)', () => {
  it('accepts a file of an older version when only a grey (calculated) column was added, and records the version of the file', async () => {
    const admin = await plainAdmin(app, db);
    const v0 = await version();
    const dl = await downloadTemplate(admin.api, 'TPL-MEETINGS');
    const code = `calc_probe_${Date.now()}`;
    await db.query(`INSERT INTO register_fields (register_key, code, label_en, field_type, required, derived, sort_order) VALUES ('meetings', $1, 'Calculated probe', 'number', false, true, 990)`, [code]);
    try {
      expect(await version()).toBe(v0 + 1);
      const compat = (await q<{ c: Record<string, any> }>(db, `SELECT tpl_version_compat('TPL-MEETINGS', $1) AS c`, [v0]))[0]!.c;
      expect(compat).toMatchObject({ compatible: true, from_version: v0, to_version: v0 + 1, input_changes: [] });
      expect(compat.other_changes).toEqual([expect.objectContaining({ key: code, change: 'added' })]);
      const buf = await fillTemplate(dl.buffer, [{ Date: day('2026-01-12'), Title: `Compat meeting ${Date.now()}` }]);
      const res = await uploadFile(admin.api, buf);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ template_id: 'TPL-MEETINGS', file_template_version: v0, template_version: v0 + 1 });
      const rows = (await admin.api.call('get', `/import-batches/${res.body.id}/rows`)).body.items as { action: string; errors: unknown[] }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.errors.map((e) => (e as { code: string }).code)).not.toContain('outdated_version');
      const au = await q<{ after: Record<string, unknown> }>(db, `SELECT after FROM audit_log WHERE action = 'template.old_version_accepted' AND entity_id = $1`, [res.body.id]);
      expect(au[0]!.after).toMatchObject({ template_id: 'TPL-MEETINGS', file_version: v0, current_version: v0 + 1 });
    } finally {
      await db.query(`DELETE FROM register_fields WHERE register_key = 'meetings' AND code = $1`, [code]);
    }
  });

  it('accepts a file of an older version when a typed column was added to a register (0095, tolerant upload), with the summary for the confirm step', async () => {
    const admin = await plainAdmin(app, db);
    const v0 = await version();
    const dl = await downloadTemplate(admin.api, 'TPL-MEETINGS');
    const code = `typed_probe_${Date.now()}`;
    await db.query(`INSERT INTO register_fields (register_key, code, label_en, field_type, required, derived, sort_order) VALUES ('meetings', $1, 'Typed probe', 'text', false, false, 991)`, [code]);
    try {
      const buf = await fillTemplate(dl.buffer, [{ Date: day('2026-01-13'), Title: `Tolerated meeting ${Date.now()}` }]);
      const res = await uploadFile(admin.api, buf);
      expect([200, 201, 202]).toContain(res.status);
      expect(res.body.older_template.added_columns.map((c: { key: string }) => c.key)).toContain(code);
      const db2 = await q<{ c: Record<string, unknown> }>(db, `SELECT tpl_version_compat('TPL-MEETINGS', $1) AS c`, [v0]);
      expect(db2[0]!.c).toMatchObject({ compatible: true, input_changes: [] });
    } finally {
      await db.query(`DELETE FROM register_fields WHERE register_key = 'meetings' AND code = $1`, [code]);
    }
    expect((await q<{ c: Record<string, unknown> }>(db, `SELECT tpl_version_compat('TPL-MEETINGS', $1) AS c`, [v0]))[0]!.c).toMatchObject({ compatible: true });
  });

  it('refuses a stream file of an older version when a typed task column was added (the B10 start of Q205)', async () => {
    const c = (await q<{ c: Record<string, any> }>(db, `SELECT tpl_version_compat('TPL-CIVIL', 1) AS c`))[0]!.c;
    expect(c.compatible).toBe(false);
    expect(c.input_changes).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'B10:actual_start', change: 'added' })]));
    expect(c.other_changes).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'B10:planned_start' })]));        // grey: not an input change
  });
});
