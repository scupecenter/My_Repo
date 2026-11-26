import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { recPath, team } from './reg-helpers';

/** Migration 0173: the flat 16-value Procurement Delivery Scope list (owner design 2026-11-26). */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

const ORDER = [
  'CW', 'Tower Erection', 'Site Adaption', 'Grounding', 'CW Dismantle', 'TE Dismantle', 'TE Installation',
  'STA', 'ST', 'GECOL', 'HLC', 'Survey', 'Acquisition Visit', 'Inspection', 'Maintenance', 'Emergency',
];

describe('procurement scope flat list (0173)', () => {
  it('ProcScope holds the 16 values, active, in the owner order, with the agreed labels', async () => {
    const v = await db.query(
      `SELECT code, label_en FROM list_values WHERE catalogue_code = 'ProcScope' AND is_active ORDER BY sort_order, code`,
    );
    expect(v.rows.map((r: { code: string }) => r.code)).toEqual(ORDER);
    const label = (code: string) => v.rows.find((r: { code: string }) => r.code === code)?.label_en;
    expect(label('CW')).toBe('Full Civil Work');
    expect(label('GECOL')).toBe('Power (GECOL)');
    expect(label('HLC')).toBe('HLC Fiber');
    expect(label('Grounding')).toBe('Grounding');
  });

  it('the scope field options of the Procurement register are refreshed from the list, in the same order', async () => {
    const f = await db.query(
      `SELECT options FROM register_fields WHERE register_key = 'procurement' AND code = 'scope'`,
    );
    expect(f.rows[0].options).toEqual(ORDER);
  });

  it('a Procurement record with scope GECOL is still refused wrong_register (the refusal lifts with P1, not here)', async () => {
    const t = await team(app, db, 'procurement', 'procurement', 7);
    const r = await t.entry.api.call('post', recPath('procurement'), {
      site_id: t.site.id,
      data: { scope: 'GECOL', order_status: 'Active' },
    });
    expect(r.status).toBe(422);
    expect(r.body.errors).toContainEqual(expect.objectContaining({ path: '/data/scope', code: 'wrong_register' }));
  });
});
