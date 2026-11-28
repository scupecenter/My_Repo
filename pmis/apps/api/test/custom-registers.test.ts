import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { approveAll, createRec, recPath, team, type Team } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0592: admin-defined custom registers. Create (disabled), add columns through the ordinary column door, enable (menu key, template, permission module),
 * run a record through submit and approve, rename, hide. A plain user cannot create; no permission is granted by the creation. The tests build on one another.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let key = '';
const REASON = 'Custom register test';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('custom registers', () => {
  it('only the System Admin reads or creates; a create needs the step-up and a reason', async () => {
    expect((await plain.api.call('get', '/custom-registers')).status).toBe(403);
    expect((await plain.api.call('post', '/custom-registers', { name_en: 'Tower Audit', site_scoped: true, reason: REASON })).status).toBe(403);
    expect((await noStep.api.call('post', '/custom-registers', { name_en: 'Tower Audit', site_scoped: true, reason: REASON })).status).toBe(401);
    expect((await admin.api.call('post', '/custom-registers', { name_en: 'Tower Audit', site_scoped: true })).status).toBe(422);
  });

  it('creates a disabled register with a key made from the name, and the same name is refused and a name with the same letters gets a suffix', async () => {
    const r = await admin.api.call('post', '/custom-registers', { name_en: 'Tower Audit', name_ar: 'تدقيق الأبراج', site_scoped: true, multiple_per_site: true, reason: REASON });
    expect(r.status).toBe(201);
    key = r.body.register_key as string;
    expect(key).toMatch(/^custom_[a-z_]+$/);
    expect(r.body).toMatchObject({ module_key: key, enabled: false, is_active: true, field_count: 0, record_count: 0 });
    expect(r.headers.etag).toBeTruthy();
    const dup = await admin.api.call('post', '/custom-registers', { name_en: 'tower audit', site_scoped: false, reason: REASON });
    expect(dup.status).toBe(422);
    const again = await admin.api.call('post', '/custom-registers', { name_en: 'Tower-Audit', site_scoped: false, reason: REASON });
    expect(again.status).toBe(201);
    expect(again.body.register_key).toBe(`${key}_aa`);
    await admin.api.call('patch', `/custom-registers/${again.body.register_key}`, { is_active: false, reason: REASON }, { 'If-Match': `"${again.body.version}"` });
    // the register is not in the register list until it is enabled
    const list = await admin.api.call('get', '/registers');
    expect((list.body.items as { register_key: string }[]).some((d) => d.register_key === key)).toBe(false);
  });

  it('refuses to enable without a required column, then enables once one exists; the template, the menu hub key and the permission module appear', async () => {
    const d = (await admin.api.call('get', `/custom-registers/${key}`)).body;
    const early = await admin.api.call('post', `/custom-registers/${key}/enable`, { reason: REASON }, { 'If-Match': `"${d.version}"` });
    expect(early.status).toBe(422);
    const col = await admin.api.call('post', `/registers/${key}/fields`, { code: 'tower_ref', label_en: 'Tower reference', field_type: 'text', required: true, reason: REASON });
    expect(col.status).toBe(201);
    const note = await admin.api.call('post', `/registers/${key}/fields`, { code: 'finding', label_en: 'Finding', field_type: 'long_text', reason: REASON });
    expect(note.status).toBe(201);
    const fresh = (await admin.api.call('get', `/custom-registers/${key}`)).body;
    expect(fresh).toMatchObject({ field_count: 2, required_count: 1 });
    const on = await admin.api.call('post', `/custom-registers/${key}/enable`, { reason: REASON }, { 'If-Match': `"${fresh.version}"` });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true });
    expect(on.body.template_id).toBeTruthy();
    expect((await q(db, `SELECT 1 FROM template_definitions WHERE register_key = $1 AND kind = 'register'`, [key])).length).toBe(1);
    expect((await q(db, `SELECT 1 FROM nav_item_catalogue WHERE key = 'registers.custom'`)).length).toBe(1);
    const cat = await admin.api.call('get', '/permissions/catalogue');
    expect((cat.body.modules as { key: string }[]).some((m) => m.key === key)).toBe(true);
    const list = await admin.api.call('get', '/registers');
    expect((list.body.items as { register_key: string }[]).some((d) => d.register_key === key)).toBe(true);
    expect((await admin.api.call('post', `/custom-registers/${key}/enable`, { reason: REASON }, { 'If-Match': `"${on.body.version}"` })).status).toBe(409);
  });

  it('a record goes through submit and approve like any register record, and the menu hub key reaches a viewer', async () => {
    const t: Team = await team(app, db, key, key, 5);
    const rec = await createRec(t, { tower_ref: 'TWR-001', finding: 'Rust on the ladder' });
    const done = await approveAll(t, rec.id as string, rec.version as number);
    expect(done.state).toBe('approved');
    const me = await t.entry.api.call('get', '/me');
    expect(me.status).toBe(200);
    expect((me.body.effective.nav as string[]).includes('registers.custom')).toBe(true);
    const search = await t.entry.api.call('get', '/search', undefined);
    expect([200, 400, 422]).toContain(search.status);
    const rows = await t.entry.api.call('get', recPath(key));
    expect(rows.status).toBe(200);
    expect((rows.body.items as unknown[]).length).toBe(1);
  });

  it('renames and hides without deleting; hidden registers leave the list and the grid editor, keep their records, and show again', async () => {
    const d = (await admin.api.call('get', `/custom-registers/${key}`)).body;
    const ren = await admin.api.call('patch', `/custom-registers/${key}`, { name_en: 'Tower Audit 2', reason: REASON }, { 'If-Match': `"${d.version}"` });
    expect(ren.status).toBe(200);
    expect(ren.body.name_en).toBe('Tower Audit 2');
    expect(ren.body.register_key).toBe(key);
    const stale = await admin.api.call('patch', `/custom-registers/${key}`, { name_en: 'Late', reason: REASON }, { 'If-Match': `"${d.version}"` });
    expect([409, 412]).toContain(stale.status);
    const hid = await admin.api.call('patch', `/custom-registers/${key}`, { is_active: false, reason: REASON }, { 'If-Match': `"${ren.body.version}"` });
    expect(hid.status).toBe(200);
    expect(hid.body).toMatchObject({ is_active: false, record_count: 1 });
    const list = await admin.api.call('get', '/registers');
    expect((list.body.items as { register_key: string }[]).some((x) => x.register_key === key)).toBe(false);
    const cat = await admin.api.call('get', '/permissions/catalogue');
    expect((cat.body.modules as { key: string }[]).some((m) => m.key === key)).toBe(false);
    const show = await admin.api.call('patch', `/custom-registers/${key}`, { is_active: true, reason: REASON }, { 'If-Match': `"${hid.body.version}"` });
    expect(show.status).toBe(200);
    expect(show.body.is_active).toBe(true);
  });

  it('the limit registers.custom_max is listed with its default of 20', async () => {
    const lim = await admin.api.call('get', '/custom-registers');
    expect(lim.body.limit.max).toBe(20);
    const ops = await q<{ d: number }>(db, `SELECT (e->>'default')::int AS d FROM jsonb_array_elements(ops_limits_catalogue()) e WHERE e->>'key' = 'registers.custom_max'`);
    expect(ops[0]!.d).toBe(20);
  });
});
