import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * Migration 0406, contract 0.15.361: the Finance hub. The setting section finance_hub of ui.features is closed and complete; GET /finance-hub/summary
 * answers every signed-in user; a register whose module the caller cannot view is null; the counted rows are the rows the register screen would show
 * (module, regions, latest version); advance amounts follow fin_amounts_visible (an admin sees them, a custodian-less viewer does not).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const codes = (res: { body: any }): string[] => (res.body.errors ?? []).map((e: { path: string; code: string }) => `${e.path}:${e.code}`).sort();
const HUB = { widgets: { advances: true, invoices: false, quick_links: true, templates: true }, settle_warn_days: 45, aging_days: [15, 90] };

describe('Finance hub', () => {
  it('validates the finance_hub section: closed, complete, known keys and ranges', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const tag = { 'If-Match': String(cur.headers.etag) };
    const bad = await admin.api.call('put', '/settings/ui-features', { sections: { finance_hub: { widgets: { advances: 'yes' }, settle_warn_days: 0, aging_days: [60, 30] } }, reason: 'Bad hub' }, tag);
    expect(bad.status).toBe(422);
    expect(codes(bad).every((c) => c.startsWith('/sections/finance_hub'))).toBe(true);
    expect(codes(bad).length).toBeGreaterThan(0);
    const unknown = await admin.api.call('put', '/settings/ui-features', { sections: { finance_hub: { widgets: { balances: true } } }, reason: 'Unknown widget' }, tag);
    expect(unknown.status).toBe(422);
    const ok = await admin.api.call('put', '/settings/ui-features', { sections: { finance_hub: HUB }, reason: 'Set the hub thresholds' }, tag);
    expect(ok.status).toBe(200);
    expect(ok.body.sections.finance_hub).toEqual(HUB);
    expect((await plain.api.call('put', '/settings/ui-features', { sections: { finance_hub: HUB }, reason: 'No' }, { 'If-Match': String(ok.headers.etag) })).status).toBe(403);
  });

  it('summary: a caller without a finance module gets null cards; the admin gets real counts under the threshold', async () => {
    const set = await admin.api.call('put', '/settings/ui-features', { sections: { finance_hub: HUB }, reason: 'Set the hub thresholds' }, { 'If-Match': String((await admin.api.call('get', '/settings/ui-features')).headers.etag) });
    expect(set.status).toBe(200);
    // the database is shared with other suites that also leave advances and invoices: compare with the figures before this test adds its own
    const base = (await admin.api.call('get', '/finance-hub/summary')).body;
    const mk = await makeSite(db, 5);
    const site = (await db.query(`SELECT id, region_id FROM sites WHERE id = $1`, [mk.id])).rows[0] as { id: string; region_id: number };
    const mkRec = (key: string, type: string | null, data: object) =>
      db.query(
        `INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, is_global, is_current, state, current_level, levels_required, level_round, data, created_by, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, false, true, 'approved', 2, 2, 1, $5::jsonb, $6, now())`,
        [key, type, site.id, site.region_id, JSON.stringify(data), admin.user.id]);
    await mkRec('financial_advances', 'advance', { advance_state: 'disbursed', disbursed_date: '2026-10-01', disbursed_amount: 100, custodian_user_id: '' });
    await mkRec('financial_advances', 'advance', { advance_state: 'settled', disbursed_date: '2026-10-01', disbursed_amount: 50, custodian_user_id: '' });
    await mkRec('invoices', null, { invoice_state: 'Received', received_date: '2026-11-20', due_date: '2026-11-01', amount: 70 });
    await mkRec('invoices', null, { invoice_state: 'Paid', received_date: '2026-09-01', due_date: '2026-10-01', amount: 30 });

    const mine = await plain.api.call('get', '/finance-hub/summary');
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ advances: null, invoices: null });

    const full = await admin.api.call('get', '/finance-hub/summary');
    expect(full.status).toBe(200);
    expect(full.body.advances.open_count - base.advances.open_count).toBe(1);
    // 2026-10-01 is more than 45 days before today: the disbursed, unsettled advance warns
    expect(full.body.advances.overdue_count - base.advances.overdue_count).toBe(1);
    expect((full.body.advances.open_amount ?? 0) - (base.advances.open_amount ?? 0)).toBe(100);
    expect(full.body.invoices.open_count - base.invoices.open_count).toBe(1);
    expect(full.body.invoices.by_state.Received - base.invoices.by_state.Received).toBe(1);
    expect(full.body.invoices.overdue_count - base.invoices.overdue_count).toBe(1);
  });
});
