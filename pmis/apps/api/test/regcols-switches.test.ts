import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/**
 * Migration 0167: the Register columns switches "In filters" and "In the export" act. Each test makes its own column (a unique code), so no other test
 * sees a changed column. A switch that is off only removes the column from that place; on adds nothing that was not there.
 */
const TAG = randomBytes(3).toString('hex');
let app: NestExpressApplication;
let db: PgClient;
const made: [string, string][] = [];

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  for (const [r, c] of made) await db.query('DELETE FROM register_fields WHERE register_key = $1 AND code = $2', [r, c]);
  await db.end();
});

async function field(register: string, code: string, sw: { in_filter: boolean; in_export: boolean }): Promise<void> {
  await db.query(
    `INSERT INTO register_fields (register_key, code, label_en, field_type, in_list, sort_order, is_active, in_filter, in_template, in_export)
     VALUES ($1, $2, $3, 'text', true, 9000, true, $4, true, $5)`,
    [register, code, `Switch ${code}`, sw.in_filter, sw.in_export],
  );
  made.push([register, code]);
}

describe('register column switches', () => {
  it('a new column is offered in filters by default (the column default is now true), and the old data kept every column', async () => {
    const d = await db.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'register_fields' AND column_name = 'in_filter'`);
    expect(String(d.rows[0].column_default)).toBe('true');
    const off = await db.query('SELECT count(*)::int AS n FROM register_fields WHERE NOT in_export');
    expect(off.rows[0].n).toBe(0);
  });

  it('In filters: off removes the column from the filter builder of the register list, on keeps it', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view'], ['issues', 'view']] });
    const on = `sw_on_${TAG}`, off = `sw_off_${TAG}`;
    await field('issues', on, { in_filter: true, in_export: true });
    await field('issues', off, { in_filter: false, in_export: true });
    const r = await a.api.call('get', '/saved-views/filter-fields?screen_key=register-issues');
    expect(r.status).toBe(200);
    const keys = r.body.items.map((f: { key: string }) => f.key);
    expect(keys).toContain(`f:${on}`);
    expect(keys).not.toContain(`f:${off}`);
  });

  it('In the export: off removes the column from the columns the register export offers, on keeps it', async () => {
    const a = await actor(app, db, { regions: [7], grants: [['sites', 'view'], ['gecol', 'view'], ['gecol', 'export'], ['sites', 'export']] });
    const on = `sx_on_${TAG}`, off = `sx_off_${TAG}`;
    await field('gecol', on, { in_filter: true, in_export: true });
    await field('gecol', off, { in_filter: true, in_export: false });
    const res = await a.api.call('get', '/exports/parts?include_columns=true');
    expect(res.status).toBe(200);
    const gecol = res.body.items.find((p: { key: string }) => p.key === 'gecol').columns.map((c: { code: string }) => c.code);
    expect(gecol).toContain(on);
    expect(gecol).not.toContain(off);
  });
});
