import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, groupWith, newRole, plainAdmin } from './wf-helpers';

/**
 * Staff registry (B13; migration 0142, contract 0.15.56): GET /staff-registry/{employee_id} (the hover card, visibility applied by the database),
 * GET and PUT /staff-registry/visibility, PATCH /staff-registry/{employee_id}. Only this suite writes the registry and its visibility settings; it puts the
 * settings back to the default (everyone sees email and phone) at the end. All people and numbers are synthetic.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let roleHolder: Actor;
let groupMember: Actor;
let denied: Actor;
let allDelegate: Actor;
let regDelegate: Actor;
let roleId: string;
let groupId: string;
const REASON = 'Registry maintenance (test)';

async function freeRow(db: PgClient, over: Partial<Record<'status' | 'name_en', string>> = {}): Promise<{ id: string; email: string; phone: string }> {
  for (;;) {
    const id = String(randomInt(2000, 9000));
    const phone = `+218 9${randomInt(0, 10)} ${String(randomInt(0, 1000)).padStart(3, '0')} ${String(randomInt(0, 10000)).padStart(4, '0')}`;
    const email = `staff.${id}.${randomInt(0, 1e6)}@example.com`;
    const r = await db.query(
      `INSERT INTO staff_registry (employee_id, name_en, name_ar, email, phone, position, team, region, status)
       VALUES ($1, $2, 'موظف تجريبي', $3, $4, 'Site Engineer (CW)', 'cw', 'Tripoli', $5) ON CONFLICT DO NOTHING RETURNING employee_id`,
      [id, over.name_en ?? `Test Staff ${id}`, email, phone, over.status ?? 'active'],
    ).catch(() => ({ rowCount: 0 }));
    if (r.rowCount === 1) return { id, email, phone };
  }
}

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const card = (who: Actor, id: string) => who.api.call('get', `/staff-registry/${id}`);
const getVis = (who: Actor) => who.api.call('get', '/staff-registry/visibility');
const putVis = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/staff-registry/visibility', body, tag === undefined ? {} : { 'If-Match': tag });
const patch = (who: Actor, id: string, body: unknown, tag?: string) => who.api.call('patch', `/staff-registry/${id}`, body, tag === undefined ? {} : { 'If-Match': tag });
const DEFAULT_FIELD = { default_visible: true, allow: [], deny: [] };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  const view = G('sites', 'view');
  plain = await actor(app, db, { level: 'view', grants: view, regions: [1], modules: null });
  denied = await actor(app, db, { level: 'view', grants: view, regions: [1], modules: null });
  roleId = await newRole(db);
  roleHolder = await actor(app, db, { level: 'view', grants: view, regions: [1], modules: null });
  await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true)`, [roleHolder.user.id, roleId]);
  groupMember = await actor(app, db, { level: 'view', grants: view, regions: [1], modules: null });
  await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true)`, [groupMember.user.id, roleId]);
  groupId = await groupWith(db, [groupMember.user.id]);
  allDelegate = await actor(app, db, { level: 'view', grants: view, regions: [1], modules: null });
  await delegate(db, allDelegate.user.id, [['users', 'edit']]);
  regDelegate = await actor(app, db, { level: 'view', grants: view, regions: [1], modules: null });
  await delegate(db, regDelegate.user.id, [['users', 'edit']], [1]);
});

afterAll(async () => {
  await db.query('DELETE FROM staff_registry_visibility_entries');
  await db.query('UPDATE staff_registry_visibility_fields SET default_visible = true');
  await db.end();
  await app.close();
});

describe('GET /staff-registry/{employee_id}: the hover card', () => {
  it('shows the registry data, email and phone to every signed-in employee by default; 401 signed out, 404 unknown or malformed', async () => {
    const row = await freeRow(db);
    const r = await card(plain, row.id);
    expect(r.status).toBe(200);
    expect(etag(r)).toBe('"1"');
    expect(r.body).toEqual({
      employee_id: row.id, name_en: `Test Staff ${row.id}`, name_ar: 'موظف تجريبي', position: 'Site Engineer (CW)', team: 'cw', region: 'Tripoli',
      status: 'active', email: row.email, phone: row.phone, hidden_fields: [], version: 1,
    });
    expect((await new Api(app).raw('get', `/staff-registry/${row.id}`)).status).toBe(401);
    for (const id of ['0001', '12a4', '12345']) {
      const x = await card(plain, id);
      expect(x.status, id).toBe(404);
      expect(x.body.code).toBe('not_found');
    }
  });

  it('returns an inactive person with status inactive, and the seeded synthetic draft', async () => {
    const row = await freeRow(db, { status: 'inactive' });
    expect((await card(plain, row.id)).body).toMatchObject({ employee_id: row.id, status: 'inactive' });
    // the synthetic draft (25 rows) was seeded: no account existed when the migration ran (Q611 skips a row an account already holds)
    const seeded = await db.query(`SELECT count(*)::int AS n FROM staff_registry WHERE employee_id < '2000' AND email LIKE '%@example.com'`);
    expect(seeded.rows[0].n).toBe(25);
    expect((await card(plain, '1104')).body).toMatchObject({ name_en: 'Karim Zaroug', status: 'inactive', team: 'none', region: 'Benghazi' });
  });
});

describe('GET and PUT /staff-registry/visibility', () => {
  it('only a System Admin or an all-regions holder of users.edit reads the settings', async () => {
    for (const who of [plain, regDelegate]) {
      const r = await getVis(who);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    for (const who of [allDelegate, admin]) {
      const r = await getVis(who);
      expect(r.status).toBe(200);
      expect(r.body.fields).toEqual({ email: DEFAULT_FIELD, phone: DEFAULT_FIELD });
      expect(etag(r)).toBe(`"${r.body.version}"`);
    }
  });

  it('refuses a plain user (403 before the step-up), a missing step-up, a missing or stale If-Match, unknown keys and unknown holders', async () => {
    const tag = etag(await getVis(admin));
    const body = { fields: { email: DEFAULT_FIELD }, reason: REASON };
    expect((await putVis(plain, body, tag)).status).toBe(403);
    expect((await putVis(regDelegate, body, tag)).status).toBe(403);
    const ns = await putVis(noStep, body, tag);
    expect(ns.status).toBe(401);
    expect(ns.body.code).toBe('step_up_required');
    expect((await putVis(admin, body)).status).toBe(428);
    expect((await putVis(admin, body, '"999999"')).status).toBe(412);
    const bad = [
      { fields: { email: DEFAULT_FIELD, address: DEFAULT_FIELD }, reason: REASON },
      { fields: {}, reason: REASON },
      { fields: { email: DEFAULT_FIELD } },
      { fields: { email: { default_visible: true, allow: [] } }, reason: REASON },
      { fields: { email: { ...DEFAULT_FIELD, deny: [{ kind: 'department', ref_id: groupId, label: 'x' }] } }, reason: REASON },
    ];
    for (const b of bad) {
      const r = await putVis(admin, b, tag);
      expect(r.status, JSON.stringify(b)).toBe(422);
      expect(r.body.code).toBe('validation_failed');
    }
    const ghost = await putVis(admin, { fields: { phone: { ...DEFAULT_FIELD, deny: [{ kind: 'role', ref_id: '00000000-0000-4000-8000-0000000fffff', label: 'Ghost' }] } }, reason: REASON }, tag);
    expect(ghost.status).toBe(422);
    expect(ghost.body.errors[0].path).toBe('/fields/phone/deny/0');
    expect(etag(await getVis(admin))).toBe(tag);
  });

  it('applies roles, groups and persons per field on the card; deny wins; the admin sees everything; the change is audited', async () => {
    const row = await freeRow(db);
    const before = await getVis(admin);
    const body = {
      fields: {
        email: { default_visible: false, allow: [{ kind: 'role', ref_id: roleId, label: 'whatever the client says' }], deny: [{ kind: 'group', ref_id: groupId, label: 'g' }] },
        phone: { default_visible: true, allow: [], deny: [{ kind: 'user', ref_id: denied.user.id, label: 'p' }] },
      },
      reason: REASON,
    };
    const r = await putVis(allDelegate, body, etag(before));
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(before.body.version + 1);
    expect(r.body.fields.email.allow[0]).toMatchObject({ kind: 'role', ref_id: roleId, employee_id: null });
    expect(r.body.fields.email.allow[0].label).not.toBe('whatever the client says');
    expect(r.body.fields.phone.deny[0]).toMatchObject({ kind: 'user', ref_id: denied.user.id, user_id: denied.user.id, employee_id: denied.user.employeeId, account_status: 'active' });
    expect(r.body.updated_by).toMatchObject({ id: allDelegate.user.id });

    const seen = async (who: Actor) => (await card(who, row.id)).body as { email: string | null; phone: string | null; hidden_fields: string[] };
    // the role holder sees the email (allow); the plain user does not (default off)
    expect(await seen(roleHolder)).toMatchObject({ email: row.email, phone: row.phone, hidden_fields: [] });
    expect(await seen(plain)).toMatchObject({ email: null, phone: row.phone, hidden_fields: ['email'] });
    // the group member holds the role too, but the group is denied: deny wins
    expect(await seen(groupMember)).toMatchObject({ email: null, phone: row.phone, hidden_fields: ['email'] });
    // the person denied the phone
    expect(await seen(denied)).toMatchObject({ email: null, phone: null, hidden_fields: ['email', 'phone'] });
    // registry administrators see everything
    expect(await seen(admin)).toMatchObject({ email: row.email, phone: row.phone, hidden_fields: [] });
    expect(await seen(allDelegate)).toMatchObject({ email: row.email, phone: row.phone, hidden_fields: [] });
    // a region-limited delegate is not an administrator of the registry
    expect(await seen(regDelegate)).toMatchObject({ email: null, phone: row.phone });

    const a = await db.query(`SELECT before, after, reason, actor_id::text AS actor_id, on_behalf_of::text AS on_behalf_of FROM audit_log
      WHERE action = 'staff_registry.visibility_changed' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0]).toMatchObject({ reason: REASON, actor_id: allDelegate.user.id });
    expect(a.rows[0].on_behalf_of).not.toBeNull();
    expect(a.rows[0].before.email.default_visible).toBe(true);
    expect(a.rows[0].after.email.default_visible).toBe(false);

    // the same settings again change nothing: no new version, no new audit row
    const again = await putVis(admin, body, etag(r));
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(r.body.version);

    const back = await putVis(admin, { fields: { email: DEFAULT_FIELD, phone: DEFAULT_FIELD }, reason: REASON }, etag(again));
    expect(back.status).toBe(200);
    expect((await card(plain, row.id)).body).toMatchObject({ email: row.email, phone: row.phone, hidden_fields: [] });
  });
});

describe('PATCH /staff-registry/{employee_id}', () => {
  it('hides a field for one employee from everyone except the registry administrators', async () => {
    const row = await freeRow(db);
    const other = await freeRow(db);
    const tag = etag(await card(admin, row.id));
    const r = await patch(admin, row.id, { hidden_fields: ['email'], reason: 'Employee asked for privacy' }, tag);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ employee_id: row.id, hidden_fields: ['email'], version: 2, status: 'active', email: row.email, linked_user: null });
    expect(etag(r)).toBe('"2"');
    expect((await card(plain, row.id)).body).toMatchObject({ email: null, phone: row.phone, hidden_fields: ['email'] });
    expect((await card(roleHolder, row.id)).body).toMatchObject({ email: null, hidden_fields: ['email'] });
    expect((await card(admin, row.id)).body).toMatchObject({ email: row.email, hidden_fields: [] });
    expect((await card(plain, other.id)).body).toMatchObject({ email: other.email, hidden_fields: [] });
    const a = await db.query(`SELECT before, after FROM audit_log WHERE action = 'staff_registry.fields_hidden' AND entity_type = 'staff_registry' AND entity_id = $1`, [row.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].before.hidden_fields).toEqual([]);
    expect(a.rows[0].after.hidden_fields).toEqual(['email']);
  });

  it('edits a row with a reason, the step-up and If-Match; audited with before and after; never in the System Log', async () => {
    const row = await freeRow(db);
    const newPhone = `+218 92 ${String(randomInt(0, 1000)).padStart(3, '0')} ${String(randomInt(0, 10000)).padStart(4, '0')}`;
    const r = await patch(allDelegate, row.id, { name_en: 'Renamed Staff', phone: newPhone, team: 'both', region: 'Sebha', notes: 'moved', reason: REASON }, '"1"');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name_en: 'Renamed Staff', phone: newPhone, team: 'both', region: 'Sebha', notes: 'moved', version: 2, updated_by: { id: allDelegate.user.id } });
    const a = await db.query(`SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'staff_registry.updated' AND entity_id = $1`, [row.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ reason: REASON, actor_id: allDelegate.user.id });
    expect(a.rows[0].before).toMatchObject({ phone: row.phone, name_en: `Test Staff ${row.id}`, region: 'Tripoli' });
    expect(a.rows[0].after).toMatchObject({ phone: newPhone, name_en: 'Renamed Staff', region: 'Sebha' });
    const sys = await db.query(`SELECT count(*)::int AS n FROM system_log WHERE message LIKE $1 OR context::text LIKE $1 OR message LIKE $2 OR context::text LIKE $2`,
      [`%${newPhone}%`, `%${row.email}%`]);
    expect(sys.rows[0].n).toBe(0);
    // nothing changes: same version, no audit row
    const same = await patch(admin, row.id, { region: 'Sebha', reason: REASON }, '"2"');
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(2);
  });

  it('refuses plain users, missing step-up, missing or stale If-Match, the employee ID, unknown keys, bad values and duplicates', async () => {
    const row = await freeRow(db);
    const other = await freeRow(db);
    const ok = { position: 'HOTO Engineer', reason: REASON };
    expect((await patch(plain, row.id, ok, '"1"')).status).toBe(403);
    expect((await patch(regDelegate, row.id, ok, '"1"')).status).toBe(403);
    const ns = await patch(noStep, row.id, ok, '"1"');
    expect(ns.status).toBe(401);
    expect(ns.body.code).toBe('step_up_required');
    expect((await patch(admin, row.id, ok)).status).toBe(428);
    expect((await patch(admin, row.id, ok, '"7"')).status).toBe(412);
    expect((await patch(admin, '0001', ok, '"1"')).status).toBe(404);
    const bad: [unknown, string][] = [
      [{ employee_id: '1234', reason: REASON }, '/employee_id'],
      [{ status: 'inactive', reason: REASON }, '/'],
      [{ reason: REASON }, '/'],
      [{ position: 'x' }, '/reason'],
      [{ phone: '+218912345678', reason: REASON }, '/phone'],
      [{ email: 'not-an-email', reason: REASON }, '/email'],
      [{ team: 'CW', reason: REASON }, '/team'],
      [{ region: 'Misrata', reason: REASON }, '/region'],
      [{ hidden_fields: ['position'], reason: REASON }, '/hidden_fields/0'],
      [{ name_ar: 'x', reason: REASON }, '/name_ar'],
    ];
    for (const [b, path] of bad) {
      const r = await patch(admin, row.id, b, '"1"');
      expect(r.status, JSON.stringify(b)).toBe(422);
      expect(r.body.errors.map((e: { path: string }) => e.path), JSON.stringify(b)).toContain(path);
    }
    const dupPhone = await patch(admin, row.id, { phone: other.phone, reason: REASON }, '"1"');
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.code).toBe('duplicate');
    expect(JSON.stringify(dupPhone.body)).not.toContain(other.phone);
    const dupEmail = await patch(admin, row.id, { email: other.email.toUpperCase(), reason: REASON }, '"1"');
    expect(dupEmail.status).toBe(409);
    expect(JSON.stringify(dupEmail.body)).not.toContain(other.email);
    const still = await db.query('SELECT version, position FROM staff_registry WHERE employee_id = $1', [row.id]);
    expect(still.rows[0]).toEqual({ version: 1, position: 'Site Engineer (CW)' });
  });

  it('links the row to the account that holds the same employee ID', async () => {
    const row = await freeRow(db);
    await db.query('UPDATE users SET employee_id = $1 WHERE id = $2', [row.id, plain.user.id]);
    try {
      const r = await patch(admin, row.id, { notes: 'linked', reason: REASON }, '"1"');
      expect(r.status).toBe(200);
      expect(r.body.linked_user).toMatchObject({ id: plain.user.id, employee_id: row.id });
    } finally {
      await db.query('UPDATE users SET employee_id = $1 WHERE id = $2', [plain.user.employeeId, plain.user.id]);
    }
  });

  it('never hard-deletes a row, not even as the superuser', async () => {
    const row = await freeRow(db);
    await expect(db.query('DELETE FROM staff_registry WHERE employee_id = $1', [row.id])).rejects.toThrow(/never deleted/);
  });
});
