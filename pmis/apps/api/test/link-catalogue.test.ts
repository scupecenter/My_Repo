import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { Team, recPath, team } from './reg-helpers';

/** Contract 0.15.584 (migration 0713): Settings > Register links, on the D60 table register_links. */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;
let field: string;
type L = { from_register: string; field: string; to_register: string; enabled?: boolean; enforce?: boolean; same_site?: boolean; target_state?: string };

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

describe('register link settings (table register_links)', () => {
  it('lists the declared links of the table, readable by everyone, editable by the System Admin only', async () => {
    const r = await t.entry.api.call('get', '/settings/register-links');
    expect(r.status).toBe(200);
    expect(r.body.can_edit).toBe(false);
    const links = r.body.links as L[];
    for (const [f, k, to] of [['warehouse', 'procurement_order_id', 'procurement'], ['issues', 'risk_entity_id', 'risks'], ['invoices', 'procurement_record_id', 'procurement']]) {
      expect(links.find((l) => l.from_register === f && l.field === k)).toMatchObject({ to_register: to, enabled: true, target_state: 'approved' });
    }
    expect((await t.entry.api.call('put', '/settings/register-links', { links, reason: 'no admin' })).status).toBe(403);
  });

  it('refuses a removal, a changed target, an unknown register or field, and a missing reason', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const cur = (await admin.call('get', '/settings/register-links')).body.links as L[];
    const noDelete = await admin.call('put', '/settings/register-links', { links: cur.slice(1), reason: 'remove one' });
    expect(noDelete.status).toBe(422);
    expect(JSON.stringify(noDelete.body)).toContain('no_delete');
    const retarget = await admin.call('put', '/settings/register-links', { links: cur.map((l, i) => (i === 0 ? { ...l, to_register: 'incidents' } : l)), reason: 'retarget' });
    expect(retarget.status).toBe(422);
    const unknown = await admin.call('put', '/settings/register-links', { links: [...cur, { from_register: 'nope', field: 'x', to_register: 'incidents' }], reason: 'bad register' });
    expect(unknown.status).toBe(422);
    const badField = await admin.call('put', '/settings/register-links', { links: [...cur, { from_register: 'lessons_learned', field: 'no_such_field', to_register: 'incidents' }], reason: 'bad field' });
    expect(badField.status).toBe(422);
    expect((await admin.call('put', '/settings/register-links', { links: cur, reason: 'x' })).status).toBe(422);
  });

  it('declares a link, switches the check on (D60 refuses a wrong id), audits it and switches it off', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const get = async () => (await admin.call('get', '/settings/register-links')).body as { links: L[]; version: number };
    const before = await get();
    const put = await admin.call('put', '/settings/register-links', { links: [...before.links, { from_register: 'lessons_learned', field, to_register: 'incidents', enforce: true }], reason: 'add a test link' });
    expect(put.status).toBe(200);
    try {
      const row = await db.query(`SELECT target_register, target_state, enforce, is_active FROM register_links WHERE register_key = 'lessons_learned' AND field_code = $1`, [field]);
      expect(row.rows[0]).toMatchObject({ target_register: 'incidents', target_state: 'approved', enforce: true, is_active: true });
      const bad = await t.entry.api.call('post', recPath('lessons_learned'), { site_id: t.site.id, data: { [field]: 'not-an-id' } });
      expect(bad.status).toBe(422);
      const links = await t.entry.api.call('get', '/registers/lessons_learned/links');
      expect(JSON.stringify(links.body)).toContain(field);
      const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'register_links_update' AND reason = 'add a test link'`);
      expect(audit.rows[0].n).toBe(1);
      const stale = await admin.call('put', '/settings/register-links', { links: before.links, reason: 'stale version' }, { 'If-Match': `"${before.version}"` });
      expect(stale.status).toBe(412);
    } finally {
      const now = await get();
      const off = await admin.call('put', '/settings/register-links', { links: now.links.map((l) => (l.from_register === 'lessons_learned' && l.field === field ? { ...l, enabled: false } : l)), reason: 'switch the test link off' });
      expect(off.status).toBe(200);
    }
    const free = await t.entry.api.call('post', recPath('lessons_learned'), { site_id: t.site.id, data: { [field]: 'free text again' } });
    expect(free.status).toBe(201);
    const after = await db.query(`SELECT is_active FROM register_links WHERE register_key = 'lessons_learned' AND field_code = $1`, [field]);
    expect(after.rows[0].is_active).toBe(false);
  });
});
