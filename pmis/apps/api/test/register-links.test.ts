import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, superDb } from './helpers';
import { makeSite } from './wf-helpers';

/**
 * Migration 0409 (D60, phase 1): the generic link declaration. register_links declares a link field; record_related() reads it, register_link_options() is
 * the generic picker, register_link_rules() checks an enforced link in entry, register_link_orphans() reports ids that point nowhere. Every case runs inside
 * a transaction that is rolled back, so no declaration or record stays in the shared database.
 */
const REGION = 7;
const PREFIX = `rl${randomBytes(3).toString('hex')}`;
let db: PgClient;
let adminId: string;

beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

const insert = (key: string, siteId: string, state: string, data: Record<string, unknown>, type: string | null = null) => db.query(
  `INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, is_global, is_current, state, current_level, levels_required, level_round, created_by, data)
   VALUES (gen_random_uuid(), $1, $2, $3, $4, false, true, $5, 1, 3, 0, $6, $7::jsonb) RETURNING id, entity_id`,
  [key, type, siteId, REGION, state, adminId, JSON.stringify(data)]);

describe('register links (migration 0409)', () => {
  it('declares the existing links, with the check off', async () => {
    const r = await db.query(`SELECT field_code, enforce FROM register_links WHERE register_key = 'invoices' AND field_code = 'procurement_record_id'`);
    expect(r.rows).toEqual([{ field_code: 'procurement_record_id', enforce: false }]);
    const l = await db.query(`SELECT register_links_of('financial_advances') AS j`);
    expect((l.rows[0].j as { field: string }[]).map((x) => x.field)).toEqual(expect.arrayContaining(['procurement_record_id', 'advance_id']));
  });

  it('checks an enforced link in entry, offers the picker, lists the relation and reports orphans', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const site = await makeSite(db, REGION, { prefix: PREFIX.toUpperCase() });
    await db.query(`INSERT INTO register_links (register_key, field_code, target_register, same_site, label_fields, enforce, sort_order)
                    VALUES ('issues', 'link_test_id', 'risks', true, ARRAY['title'], true, 900)`);
    const target = await insert('risks', site.id, 'approved', { title: `${PREFIX} target risk` });
    const other = await makeSite(db, REGION, { prefix: `${PREFIX}X`.toUpperCase() });
    const farTarget = await insert('risks', other.id, 'approved', { title: 'other site' });

    await db.query('SAVEPOINT a');
    await expect(insert('issues', site.id, 'entry', { link_test_id: 'not-an-id' })).rejects.toThrow();
    await db.query('ROLLBACK TO a');
    await expect(insert('issues', site.id, 'entry', { link_test_id: '11111111-1111-4111-8111-111111111111' })).rejects.toThrow();
    await db.query('ROLLBACK TO a');
    await expect(insert('issues', site.id, 'entry', { link_test_id: farTarget.rows[0].entity_id })).rejects.toThrow();
    await db.query('ROLLBACK TO a');

    const ok = await insert('issues', site.id, 'entry', { link_test_id: target.rows[0].entity_id });
    await insert('issues', site.id, 'entry', { link_test_id: '' });   // empty is fine

    const opts = await db.query(`SELECT register_link_options('issues', 'link_test_id', $1::uuid, $2) AS j`, [site.id, PREFIX]);
    expect((opts.rows[0].j as { entity_id: string; label: string }[]).map((o) => [o.entity_id, o.label])).toEqual([[target.rows[0].entity_id, `${PREFIX} target risk`]]);

    const rel = await db.query(`SELECT record_related('risks', $1::uuid) AS j`, [target.rows[0].entity_id]);
    const groups = rel.rows[0].j as { direction: string; register_key: string; field: string; items: { id?: string }[] }[];
    expect(groups.some((g) => g.direction === 'from' && g.register_key === 'issues' && g.field === 'link_test_id' && g.items.length === 1)).toBe(true);

    const orphans = await db.query(`SELECT orphan_rows::int AS n FROM register_link_orphans() WHERE register_key = 'issues' AND field_code = 'link_test_id'`);
    expect(orphans.rows[0].n).toBe(0);
    expect(ok.rows[0].id).toBeTruthy();
    await db.query('ROLLBACK');
  });

  it('applies the data filters, the label tokens and the seeded picker rules (0410)', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const site = await makeSite(db, REGION, { prefix: `${PREFIX}F`.toUpperCase() });
    const adv = await db.query(`SELECT data_in, same_site FROM register_links WHERE register_key = 'financial_advances' AND field_code = 'advance_id'`);
    expect(adv.rows[0].data_in).toEqual({ advance_state: ['disbursed', 'settlement_in_progress'] });
    expect(adv.rows[0].same_site).toBe(true);
    expect((await db.query(`SELECT register_link_filter_ok('{"s":"a"}'::jsonb, '{"s":["a","b"]}'::jsonb, NULL) AS ok`)).rows[0].ok).toBe(true);
    expect((await db.query(`SELECT register_link_filter_ok('{"s":"c"}'::jsonb, '{"s":["a","b"]}'::jsonb, NULL) AS ok`)).rows[0].ok).toBe(false);
    expect((await db.query(`SELECT register_link_filter_ok('{}'::jsonb, '{"s":["a"]}'::jsonb, NULL) AS ok`)).rows[0].ok).toBe(false);
    expect((await db.query(`SELECT register_link_filter_ok('{"o":"Cancelled"}'::jsonb, NULL, '{"o":["cancel%"]}'::jsonb) AS ok`)).rows[0].ok).toBe(false);
    expect((await db.query(`SELECT register_link_filter_ok('{"o":"Active"}'::jsonb, NULL, '{"o":["cancel%"]}'::jsonb) AS ok`)).rows[0].ok).toBe(true);
    // the order picker: approved, not cancelled, of the site; the label is PO / WO No. (or PR No.)
    await insert('procurement', site.id, 'approved', { po_wo_no: `${PREFIX}-PO1`, order_status: 'Active' });
    await insert('procurement', site.id, 'approved', { pr_no: `${PREFIX}-PR2`, order_status: 'Cancelled' });
    const opts = await db.query(`SELECT register_link_options('invoices', 'procurement_record_id', $1::uuid, $2) AS j`, [site.id, PREFIX]);
    expect((opts.rows[0].j as { label: string }[]).map((o) => o.label)).toEqual([`${PREFIX}-PO1`]);
    await db.query('ROLLBACK');
  });
});

describe('extra register links (migration 0596, L10)', () => {
  it('declares the lesson and permit links with their optional fields, no check yet, and the migration runs again without error', async () => {
    const sql = readFileSync(join(__dirname, '..', '..', '..', 'db', 'sql', '595_extra_register_links.sql'), 'utf8');
    await db.query('BEGIN');
    await db.query(sql);
    await db.query(sql);
    const links = await db.query(
      `SELECT register_key || '.' || field_code AS k, target_register, same_site, enforce FROM register_links
        WHERE (register_key, field_code) IN (('lessons_learned', 'incident_id'), ('lessons_learned', 'issue_id'), ('incidents', 'permit_id'), ('car_dispatcher', 'parent_booking_id'), ('financial_advances', 'parent_advance_id')) ORDER BY 1`);
    expect(links.rows).toEqual([
      { k: 'car_dispatcher.parent_booking_id', target_register: 'car_dispatcher', same_site: true, enforce: false },
      { k: 'financial_advances.parent_advance_id', target_register: 'financial_advances', same_site: true, enforce: false },
      { k: 'incidents.permit_id', target_register: 'permits_hse', same_site: true, enforce: false },
      { k: 'lessons_learned.incident_id', target_register: 'incidents', same_site: true, enforce: false },
      { k: 'lessons_learned.issue_id', target_register: 'issues', same_site: true, enforce: false },
    ]);
    const fields = await db.query(
      `SELECT count(*)::int AS c FROM register_fields WHERE (register_key, code) IN (('lessons_learned', 'incident_id'), ('lessons_learned', 'issue_id'), ('incidents', 'permit_id')) AND required = false`);
    expect(fields.rows[0].c).toBe(3);
    await db.query('ROLLBACK');
  });
});
