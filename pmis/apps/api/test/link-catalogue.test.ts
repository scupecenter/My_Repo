import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { Team, recPath, team } from './reg-helpers';

/** Contract 0.15.332 (migration 0431): the one catalogue of the links between registers. */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;
let field: string;
type L = { from_register: string; field: string; to_register: string; enabled?: boolean; validate?: boolean; builtin?: boolean };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, 'lessons_learned', 'lessons_learned', 6);
  const f = await db.query(`SELECT code FROM register_fields WHERE register_key = 'lessons_learned' AND field_type = 'text' AND NOT derived AND NOT required ORDER BY sort_order LIMIT 1`);
  field = f.rows[0].code as string;
});
afterAll(async () => {
  await db.end();
});

describe('register link catalogue', () => {
  it('is seeded from the links record_related listed, readable by everyone, editable by the System Admin only', async () => {
    const r = await t.entry.api.call('get', '/settings/register-links');
    expect(r.status).toBe(200);
    expect(r.body.can_edit).toBe(false);
    const links = r.body.links as L[];
    for (const [f, k, to] of [['warehouse', 'procurement_order_id', 'procurement'], ['issues', 'risk_entity_id', 'risks'], ['invoices', 'procurement_record_id', 'procurement'], ['invoices', 'supplier_entity_id', 'contractors']]) {
      expect(links.find((l) => l.from_register === f && l.field === k)).toMatchObject({ to_register: to, builtin: true, enabled: true });
    }
    expect((await t.entry.api.call('put', '/settings/register-links', { links: links.map((l) => l), reason: 'no admin' })).status).toBe(403);
  });

  it('refuses a removal, an unknown register or field, and a missing reason', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const cur = (await admin.call('get', '/settings/register-links')).body.links as L[];
    expect(admin).toBeTruthy();
    const noDelete = await admin.call('put', '/settings/register-links', { links: cur.slice(1), reason: 'remove one' });
    expect(noDelete.status).toBe(422);
    expect(JSON.stringify(noDelete.body)).toContain('no_delete');
    const unknown = await admin.call('put', '/settings/register-links', { links: [...cur, { from_register: 'nope', field: 'x', to_register: 'incidents' }], reason: 'bad register' });
    expect(unknown.status).toBe(422);
    const badField = await admin.call('put', '/settings/register-links', { links: [...cur, { from_register: 'lessons_learned', field: 'no_such_field', to_register: 'incidents' }], reason: 'bad field' });
    expect(badField.status).toBe(422);
    expect((await admin.call('put', '/settings/register-links', { links: cur, reason: 'x' })).status).toBe(422);
  });

  it('adds a link by data, checks it on write (only when the field changes), and switches it off', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const get = async () => (await admin.call('get', '/settings/register-links')).body as { links: L[]; version: number };
    const add = await get();
    const put = await admin.call('put', '/settings/register-links', { links: [...add.links, { from_register: 'lessons_learned', field, to_register: 'incidents', label_en: 'Test link' }], reason: 'add a test link' });
    expect(put.status).toBe(200);
    try {
      const bad = await t.entry.api.call('post', recPath('lessons_learned'), { site_id: t.site.id, data: { [field]: 'not-an-id' } });
      expect(bad.status).toBe(422);
      expect(JSON.stringify(bad.body)).toContain('link_invalid');
      const missing = await t.entry.api.call('post', recPath('lessons_learned'), { site_id: t.site.id, data: { [field]: '00000000-0000-4000-8000-000000000000' } });
      expect(missing.status).toBe(422);
      expect(JSON.stringify(missing.body)).toContain('link_not_found');
      const opts = await t.entry.api.call('get', `/registers/lessons_learned/link-options?field=${field}`);
      expect(opts.status).toBe(200);
      expect(Array.isArray(opts.body.items)).toBe(true);
      const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'register_links_update' AND reason = 'add a test link'`);
      expect(audit.rows[0].n).toBe(1);
    } finally {
      const now = await get();
      const off = await admin.call('put', '/settings/register-links', { links: now.links.map((l) => (l.from_register === 'lessons_learned' && l.field === field ? { ...l, enabled: false } : l)), reason: 'switch the test link off' });
      expect(off.status).toBe(200);
    }
    const free = await t.entry.api.call('post', recPath('lessons_learned'), { site_id: t.site.id, data: { [field]: 'free text again' } });
    expect(free.status).toBe(201);
  });

  it('lists the order candidates of a Procurement link and keeps the Related-records reader on the catalogue', async () => {
    const def = await db.query(`SELECT pg_get_functiondef('public.record_related(text,uuid)'::regprocedure) AS d`);
    expect(def.rows[0].d).toContain('register_links_active');
    expect(def.rows[0].d).not.toContain(`'procurement_order_id'`);
  });
});
