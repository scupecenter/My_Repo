import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { Team, approveAll, createRec, post, recPath, team } from './reg-helpers';

/** Contract 0.15.136 (migrations 0185, 0380): the Invoices register (owner approval 2026-11-27). */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;

const OK = { invoice_no: 'INV-001', invoice_date: '2026-11-20', amount: 1500 };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, 'invoices', 'invoices', 5);
});
afterAll(async () => {
  await db.end();
});

describe('invoices register', () => {
  it('is listed with the standard two levels, its lists and the template', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const res = await api.call('get', '/registers');
    expect(res.status).toBe(200);
    const def = (res.body.items as { register_key: string; approval_levels: number; site_scoped: boolean; fields: { code: string }[] }[]).find((r) => r.register_key === 'invoices');
    expect(def?.approval_levels).toBe(2);
    expect(def?.site_scoped).toBe(true);
    expect(def?.fields.map((f) => f.code)).toEqual(expect.arrayContaining(['invoice_no', 'invoice_date', 'received_date', 'due_date', 'amount', 'invoice_state', 'paid_date', 'procurement_record_id']));
    const lists = await db.query(`SELECT catalogue_code, count(*)::int AS n FROM list_values WHERE catalogue_code IN ('InvoiceState', 'InvoiceKind') GROUP BY 1 ORDER BY 1`);
    expect(lists.rows).toEqual([{ catalogue_code: 'InvoiceKind', n: 4 }, { catalogue_code: 'InvoiceState', n: 6 }]);
    const tpl = await db.query(`SELECT 1 FROM template_definitions WHERE template_id = 'TPL-INVOICES' AND register_key = 'invoices'`);
    expect(tpl.rowCount).toBe(1);
  });

  it('seeds no matrix holder and no permission grant, and keeps the data reset part', async () => {
    const holders = await db.query(`SELECT count(*)::int AS n FROM matrix_cells WHERE register_key = 'invoices' AND region_id IS NULL`);
    expect(holders.rows[0].n).toBe(0);
    const part = await db.query(`SELECT data_reset_register_part('invoices') AS p, (SELECT count(*)::int FROM data_reset_parts() WHERE code IN ('incidents', 'lessons_learned', 'invoices')) AS n`);
    expect(part.rows[0]).toEqual({ p: 'invoices', n: 3 });
  });

  it('lists the order link in the related-records reader', async () => {
    const def = await db.query(`SELECT pg_get_functiondef('public.record_related(text,uuid)'::regprocedure) AS d`);
    const links = await db.query(`SELECT 1 FROM register_links_active() WHERE from_register = 'invoices' AND field = 'procurement_record_id'`);
    expect(def.rows[0].d.includes(`'invoices'`) || (def.rows[0].d.includes('register_links_active') && links.rowCount === 1)).toBe(true);
    const hlc = await db.query(`SELECT 1 FROM register_links_active() WHERE from_register = 'hlc' AND field = 'procurement_record_id'`);
    expect(def.rows[0].d.includes(`'hlc'`) || hlc.rowCount === 1).toBe(true); // D58 (0407): the HLC <-> Procurement link
  });

  it('checks the order link and the supplier company, and fills the supplier name (D58)', async () => {
    const badOrder = await t.entry.api.call('post', recPath('invoices'), { site_id: t.site.id, data: { ...OK, procurement_record_id: '00000000-0000-4000-8000-000000000001' } });
    expect(badOrder.status).toBe(422);
    expect(badOrder.body.errors[0].code).toBe('order_not_found');
    const badParty = await t.entry.api.call('post', recPath('invoices'), { site_id: t.site.id, data: { ...OK, supplier_party_id: '00000000-0000-4000-8000-000000000002' } });
    expect(badParty.status).toBe(422);
    expect(badParty.body.errors[0].code).toBe('unknown_company');
    const party = await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`, [`Supplier ${Date.now()}`]);
    const name = (await db.query(`SELECT name FROM external_parties WHERE id = $1`, [party.rows[0].id])).rows[0].name;
    const ok = await t.entry.api.call('post', recPath('invoices'), { site_id: t.site.id, data: { ...OK, invoice_no: 'INV-SUP', supplier_party_id: party.rows[0].id } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.supplier).toBe(name);
    const opts = await t.entry.api.call('get', '/registers/invoices/supplier-options');
    expect(opts.status).toBe(200);
    expect((opts.body.items as { id: string }[]).map((i) => i.id)).toContain(party.rows[0].id);
    expect((await t.entry.api.call('get', '/registers/invoices/order-options')).status).toBe(200);
  });

  it('runs entry to approval and keeps the required fields and the actual-date rule', async () => {
    const missing = await createRec(t, { invoice_no: 'INV-X' });
    expect((await post(t.entry.api, 'invoices', missing.id, 'submit', missing.version)).status).toBe(422);
    const future = await t.entry.api.call('post', recPath('invoices'), { site_id: t.site.id, data: { ...OK, invoice_date: '2030-06-15' } });
    expect(future.status).toBe(422);
    const rec = await createRec(t, OK);
    expect(rec.state).toBe('entry');
    const done = await approveAll(t, rec.id, rec.version);
    expect(done.state).toBe('approved');
  });
});
