import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { G, PROC, Team, approveAll, createRec, patch, recPath, regCell, team } from './reg-helpers';
import { partyWithContract } from './p4b-helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.331 (migration 0430): an invoice reads PR / PO from its Procurement order, and the register rules (order_required, supplier_required) are edited in Settings. */
let app: NestExpressApplication;
let db: PgClient;
let inv: Team;
let proc: Team;
let order: string;

const OK = { invoice_no: 'INV-L1', invoice_date: '2026-11-20', amount: 900 };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  const REGION = 6;
  inv = await team(app, db, 'invoices', 'invoices', REGION);
  proc = await team(app, db, 'procurement', 'procurement', REGION);
  const o = await createRec({ ...proc, site: inv.site }, { ...PROC, pr_no: 'PR-L1', po_wo_no: 'PO-L1', po_wo_date: '2026-01-06' }, { external_party_id: await partyWithContract(db, { scopes: ['CW'] }) });
  order = (await approveAll({ ...proc, site: inv.site }, o.id, o.version)).entity_id as string;
  // one user who enters invoices and also reads Procurement in the region (the matrix decides who may pick and check an order)
  const both = await actor(app, db, { level: 'entry', grants: [...G('invoices', 'view', 'create', 'edit'), ...G('procurement', 'view')], regions: [REGION], modules: null });
  await regCell(db, 'invoices', REGION, 'entry', { user: [both.user.id] });
  await regCell(db, 'procurement', REGION, 'review', { user: [both.user.id] });
  inv = { ...inv, entry: both };
});
afterAll(async () => {
  await db.end();
});

const create = (t: Team, data: Record<string, unknown>) => t.entry.api.call('post', recPath('invoices'), { site_id: t.site.id, data });

describe('invoice order', () => {
  it('reads PR and PO numbers from the order, and they cannot be typed', async () => {
    const typed = await create(inv, { ...OK, invoice_no: 'INV-L1T', procurement_record_id: order, order_pr_no: 'TYPED', order_po_wo_no: 'TYPED' });
    expect(typed.status).toBe(422);
    expect(JSON.stringify(typed.body)).toContain('field_read_only');
    const res = await create(inv, { ...OK, invoice_no: 'INV-L1B', procurement_record_id: order });
    expect(res.status).toBe(201);
    expect(res.body.data.order_pr_no).toBe('PR-L1');
    expect(res.body.data.order_po_wo_no).toBe('PO-L1');
  });

  it('drops the derived numbers when the order is cleared', async () => {
    const rec = await createRec(inv, { ...OK, invoice_no: 'INV-L1C', procurement_record_id: order });
    expect(rec.data.order_pr_no).toBe('PR-L1');
    const cleared = await patch(inv.entry.api, 'invoices', rec.id, rec.version, { data: { procurement_record_id: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.order_pr_no).toBeUndefined();
    expect(cleared.body.data.procurement_record_id).toBeUndefined();
  });
});

describe('register rules', () => {
  it('is for the System Admin only, lists the catalogue and refuses an unknown key and a wrong type', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const res = await admin.call('get', '/settings/register-rules');
    expect(res.status).toBe(200);
    expect((res.body.catalogue as { key: string }[]).map((c) => c.key)).toEqual(expect.arrayContaining(['currency', 'order_required', 'supplier_required']));
    // 0643: the keys of other registers are offered, and the system keys of a register are listed read only under `other`
    const cat = res.body.catalogue as { register_key: string; key: string }[];
    expect(cat).toEqual(expect.arrayContaining([expect.objectContaining({ register_key: 'financial_advances', key: 'currency' }), expect.objectContaining({ register_key: 'car_dispatcher', key: 'master_export' })]));
    const items = res.body.items as { register_key: string; other: Record<string, unknown> }[];
    expect(items.find((i) => i.register_key === 'procurement')?.other).toHaveProperty('scope_rows');
    expect(items.find((i) => i.register_key === 'invoices')?.other).toEqual({});
    expect((await inv.entry.api.call('get', '/settings/register-rules')).status).toBe(403);
    expect((await admin.call('put', '/settings/register-rules/invoices', { rules: { nope: true }, reason: 'valid reason' })).status).toBe(422);
    expect((await admin.call('put', '/settings/register-rules/invoices', { rules: { order_required: 'yes' }, reason: 'valid reason' })).status).toBe(422);
    expect((await admin.call('put', '/settings/register-rules/invoices', { rules: { currency: 'LYD' }, reason: 'x' })).status).toBe(422);
    const ok = await admin.call('put', '/settings/register-rules/invoices', { rules: { currency: 'LYD' }, reason: 'keep the currency' });
    expect(ok.status).toBe(200);
    expect(ok.body.rules.currency).toBe('LYD');
  });

  it('enforces order_required and supplier_required (checked in a rolled back transaction, so parallel suites see nothing)', async () => {
    const rec = await createRec(inv, { ...OK, invoice_no: 'INV-RULE' });
    for (const [rule, code] of [['order_required', 'order_required'], ['supplier_required', 'supplier_required']] as const) {
      await db.query('BEGIN');
      try {
        await db.query(`UPDATE register_definitions SET rules = rules || $1::jsonb WHERE register_key = 'invoices'`, [JSON.stringify({ [rule]: true })]);
        await expect(db.query(`UPDATE register_records SET data = data || '{"invoice_no": "INV-RULE2"}'::jsonb WHERE id = $1`, [rec.id])).rejects.toThrow(new RegExp(`${code}|validation_failed`));
      } finally {
        await db.query('ROLLBACK');
      }
    }
    expect((await patch(inv.entry.api, 'invoices', rec.id, rec.version, { data: { invoice_no: 'INV-RULE4' } })).status).toBe(200);
  });
});
