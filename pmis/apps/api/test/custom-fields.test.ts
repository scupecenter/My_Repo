import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delegate, startApp, superDb } from './helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** GET /custom-fields and /custom-fields/{id} (contract 0.15.264): the definitions of the custom fields, with the field rules and the admin-only parts. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;
let fieldsDelegate: Actor;
const TAG = randomBytes(3).toString('hex');
const code = (s: string) => `cf_${s}_${TAG}`;
let active = '';
let inactive = '';
let hidden = '';
let roleId = '';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
  plain = await actor(app, db, { level: 'entry' });
  fieldsDelegate = await actor(app, db, { level: 'entry' });
  await delegate(db, fieldsDelegate.user.id, [['fields', 'edit']]);
  const ins = async (c: string, active_: boolean, type = 'list'): Promise<string> => (await db.query(
    `INSERT INTO field_definitions (entity_type, code, label_en, label_ar, data_type, is_active, in_list_filters) VALUES ('site', $1, $2, 'حقل', $3, $4, true) RETURNING id`,
    [c, `Field ${c}`, type, active_])).rows[0].id as string;
  active = await ins(code('active'), true);
  inactive = await ins(code('inactive'), false, 'text');
  hidden = await ins(code('hidden'), true, 'text');
  await db.query(`INSERT INTO field_list_values (field_id, code, label_en, label_ar, sort_order) VALUES ($1, 'b', 'Beta', 'بيتا', 2), ($1, 'a', 'Alpha', 'ألفا', 1)`, [active]);
  roleId = (await db.query(`SELECT id::text AS id FROM roles ORDER BY id LIMIT 1`)).rows[0].id as string;
  await db.query(`INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'edit')`, [active, roleId]);
  await db.query(`INSERT INTO field_permissions (field_id, role_id, access) SELECT $1, r.id, 'hidden' FROM roles r`, [hidden]);
});
afterAll(async () => { await db.end(); await app.close(); });

describe('GET /custom-fields', () => {
  it('lists the active fields of an entity for a signed-in user, with their list values in order, and no admin parts', async () => {
    const res = await plain.api.call('get', '/custom-fields?entity_type=site');
    expect(res.status).toBe(200);
    const f = res.body.items.find((x: { id: string }) => x.id === active);
    expect(f).toMatchObject({ entity_type: 'site', code: code('active'), data_type: 'list', label_ar: 'حقل', in_list_filters: true, is_active: true });
    expect(f.list_values.map((v: { value: string }) => v.value)).toEqual(['a', 'b']);
    expect(f.visible_to_role_ids).toBeUndefined();
    expect(res.body.items.some((x: { id: string }) => x.id === inactive)).toBe(false);
    expect(typeof res.body.field_set_version).toBe('number');
  });
  it('hides a field the caller\'s field rules hide', async () => {
    const res = await plain.api.call('get', '/custom-fields?entity_type=site');
    expect(res.body.items.some((x: { id: string }) => x.id === hidden)).toBe(false);
    expect((await plain.api.call('get', `/custom-fields/${hidden}`)).status).toBe(404);
  });
  it('an admin reads inactive fields and the role lists; a delegate of the custom fields too; a plain user gets 403 for inactive ones', async () => {
    for (const who of [admin, fieldsDelegate]) {
      const res = await who.api.call('get', '/custom-fields?entity_type=site&include_inactive=true');
      expect(res.status).toBe(200);
      expect(res.body.items.some((x: { id: string }) => x.id === inactive)).toBe(true);
      expect(res.body.items.find((x: { id: string }) => x.id === active).editable_by_role_ids).toContain(roleId);
    }
    expect((await plain.api.call('get', '/custom-fields?include_inactive=true')).status).toBe(403);
  });
  it('validates the query and answers one field with an ETag, 404 for an unknown or malformed id', async () => {
    expect((await plain.api.call('get', '/custom-fields?entity_type=nonsense')).status).toBe(422);
    expect((await plain.api.call('get', '/custom-fields?entity_type=site&task_code=')).status).toBe(422);
    const one = await plain.api.call('get', `/custom-fields/${active}`);
    expect(one.status).toBe(200);
    expect(one.headers.etag).toBe('"1"');
    expect(one.body.code).toBe(code('active'));
    expect((await plain.api.call('get', '/custom-fields/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await plain.api.call('get', '/custom-fields/not-a-uuid')).status).toBe(404);
    expect((await plain.api.call('get', `/custom-fields/${inactive}`)).status).toBe(404);
    expect((await admin.api.call('get', `/custom-fields/${inactive}`)).status).toBe(200);
  });
  it('is signed-in only', async () => {
    const res = await (await import('supertest')).default(app.getHttpServer()).get('/api/v1/custom-fields');
    expect(res.status).toBe(401);
  });
});
