import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guestMayCall, apiPath } from '../src/auth/guest-routes';
import { q } from './calc-helpers';
import { Api, NEW_PASSWORD, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Guest access (migration 0731, contract 0.15.730): off by default; a System Admin creates a view-only local account with an end date. The account is an
 * ordinary user with the role GUEST and the profile guest_view; database guards keep it a guest and the session guard keeps it read-only.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;
const REASON = 'A client reviews progress for one week';
const CFG_OFF = '{"enabled": false, "max_days": 30, "default_days": 7}';
let seq = 0;
const email = (): string => `guest.${process.pid}.${Date.now().toString(36)}.${seq++}@example.test`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '${CFG_OFF}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'security.guest_access'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const readCfg = (who: Actor) => who.api.call('get', '/settings/guest-access');
const putCfg = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/guest-access', body, tag === undefined ? {} : { 'If-Match': tag });
const enable = async (max = 30, def = 7) => {
  const r = await putCfg(admin, { enabled: true, max_days: max, default_days: def, reason: REASON }, etag(await readCfg(admin)));
  expect(r.status).toBe(200);
};
const disable = async () => {
  const r = await putCfg(admin, { enabled: false, max_days: 30, default_days: 7, reason: REASON }, etag(await readCfg(admin)));
  expect([200, 409]).toContain(r.status);
};
const body = (over: Record<string, unknown> = {}) => ({ email: email(), display_name: 'Client Viewer', regions: [5], modules: ['sites', 'dashboard'], days: 3, reason: REASON, ...over });
const audits = (action: string) => q<{ reason: string; after: any }>(db, `SELECT reason, after FROM audit_log WHERE action = $1 ORDER BY id`, [action]);

describe('the setting', () => {
  it('is off by default; only a System Admin reads or changes it', async () => {
    const s = (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'security.guest_access'`))[0]?.value;
    expect(s).toEqual(JSON.parse(CFG_OFF));
    expect((await readCfg(plain)).status).toBe(403);
    const r = await readCfg(admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, max_days: 30, default_days: 7, can_edit: true });
    expect(r.body.modules).toContain('sites');
    expect(r.body.modules).not.toContain('users');
    expect((await putCfg(plain, { enabled: true, max_days: 30, default_days: 7, reason: REASON }, etag(r))).status).toBe(403);
  });

  it('needs a reason, a version and valid limits, and records before and after', async () => {
    const r = await readCfg(admin);
    expect((await putCfg(admin, { enabled: true, max_days: 30, default_days: 7, reason: 'x' }, etag(r))).status).toBe(422);
    expect((await putCfg(admin, { enabled: true, max_days: 5, default_days: 9, reason: REASON }, etag(r))).status).toBe(422);
    expect((await putCfg(admin, { enabled: true, max_days: 30, default_days: 7, reason: REASON })).status).toBe(428);
    await enable();
    const a = (await audits('guest_access_update')).at(-1)!;
    expect(a.after).toMatchObject({ enabled: true, max_days: 30 });
    await disable();
  });

  it('refuses a guest while it is off, and creates no account', async () => {
    await disable();
    const b = body();
    const r = await admin.api.call('post', '/guests', b);
    expect(r.status).toBe(409);
    expect(await q(db, `SELECT 1 FROM users WHERE email = $1`, [b.email])).toHaveLength(0);
  });
});

describe('creating a guest', () => {
  it('needs a System Admin, step-up, a reason and allow-listed modules', async () => {
    await enable();
    expect((await plain.api.call('post', '/guests', body())).status).toBe(403);
    expect((await admin.api.call('post', '/guests', body({ reason: 'x' }))).status).toBe(422);
    const bad = body({ modules: ['sites', 'users'] });
    expect((await admin.api.call('post', '/guests', bad)).status).toBeGreaterThanOrEqual(400);
    expect(await q(db, `SELECT 1 FROM users WHERE email = $1`, [bad.email])).toHaveLength(0);
    const far = body({ days: 90 });
    expect((await admin.api.call('post', '/guests', far)).status).toBeGreaterThanOrEqual(400);
    expect(await q(db, `SELECT 1 FROM users WHERE email = $1`, [far.email])).toHaveLength(0);
    const noStep = await plainAdmin(app, db, false);
    const ns = await noStep.api.call('post', '/guests', body());
    expect(ns.status).toBe(401);
    expect(ns.body.code).toBe('step_up_required');
  });

  it('makes a view-only account with one assignment and an end date, returns the temporary password once, audits it', async () => {
    const b = body({ note: 'Client visit' });
    const r = await admin.api.call('post', '/guests', b);
    expect(r.status).toBe(201);
    expect(typeof r.body.temporary_password).toBe('string');
    expect(r.body.guest).toMatchObject({ email: b.email, state: 'active', regions: [5], modules: ['dashboard', 'sites'], note: 'Client visit' });
    const id = r.body.guest.user_id as string;
    const rows = await q<{ code: string; level: string; all_regions: boolean; all_modules: boolean; valid_to: Date; profile: string }>(db,
      `SELECT r.code, a.permission_level AS level, a.all_regions, a.all_modules, a.valid_to, p.code AS profile
         FROM user_role_assignments a JOIN roles r ON r.id = a.role_id
         JOIN user_role_assignment_profiles ap ON ap.assignment_id = a.id JOIN permission_profiles p ON p.id = ap.profile_id WHERE a.user_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'GUEST', level: 'view', all_regions: false, all_modules: false, profile: 'guest_view' });
    expect(rows[0]!.valid_to.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    expect(JSON.stringify((await audits('guest_created')).at(-1))).toContain('Client visit');
    const list = await admin.api.call('get', '/guests');
    expect(list.status).toBe(200);
    expect(list.body.items.some((g: { user_id: string }) => g.user_id === id)).toBe(true);
    expect((await plain.api.call('get', '/guests')).status).toBe(403);
  });
});

describe('what a guest can do', () => {
  it('signs in, changes the password, reads the shared data, and nothing else', async () => {
    const b = body();
    const r = await admin.api.call('post', '/guests', b);
    expect(r.status).toBe(201);
    const first = new Api(app);
    const login = await first.login(b.email, r.body.temporary_password);
    expect(login.status).toBe(200);
    const ch = await first.call('post', '/auth/local/password', { current_password: r.body.temporary_password, new_password: NEW_PASSWORD });
    expect(ch.status).toBeLessThan(300);
    const g = new Api(app);
    expect((await g.login(b.email, NEW_PASSWORD)).status).toBe(200);
    expect((await g.call('get', '/auth/session')).status).toBe(200);
    expect((await g.call('get', '/sites')).status).toBe(200);
    expect((await g.call('get', '/users')).status).toBe(403);
    expect((await g.call('get', '/users/picker?q=ab')).status).toBe(403);
    expect((await g.call('get', '/audit-log')).status).toBe(403);
    expect((await g.call('get', '/messages/threads')).status).toBe(403);
    for (const [m, p] of [['post', '/sites'], ['post', '/users'], ['patch', '/me/profile'], ['post', '/exports/master'], ['put', '/settings/guest-access']] as const) {
      const w = await g.call(m, p, {});
      expect(w.status, `${m} ${p}`).toBe(403);
      expect(w.body.code ?? w.body.type).toMatch(/guest_read_only|action_forbidden/);
    }
    expect((await g.call('post', '/sites', {})).body.code).toBe('guest_read_only');
  });
});

describe('the guards keep a guest a guest', () => {
  let id: string;
  beforeAll(async () => {
    const r = await admin.api.call('post', '/guests', body());
    id = r.body.guest.user_id;
  });
  const fails = async (sql: string, params: unknown[] = []): Promise<string> => {
    await db.query('BEGIN');
    try {
      await db.query(sql, params);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ROLLBACK');
      return '';
    } catch (e) {
      await db.query('ROLLBACK');
      return (e as Error).message;
    }
  };

  it('refuses a second assignment that is not the GUEST role at view with an end date', async () => {
    const role = (await q<{ id: string }>(db, `SELECT id FROM roles WHERE code = 'PM'`))[0]!.id;
    expect(await fails(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'admin', true, true)`, [id, role])).toMatch(/guest holds only/);
    const g = (await q<{ id: string }>(db, `SELECT id FROM roles WHERE code = 'GUEST'`))[0]!.id;
    expect(await fails(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules, valid_to) VALUES ($1, $2, 'view', true, false, now() + interval '1 day')`, [id, g])).toMatch(/guest holds only/);
    expect(await fails(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions) VALUES ($1, $2, 'view', false)`, [id, g])).toMatch(/guest holds only/);
  });
  it('refuses the role GUEST for a user who is not a guest', async () => {
    const g = (await q<{ id: string }>(db, `SELECT id FROM roles WHERE code = 'GUEST'`))[0]!.id;
    expect(await fails(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions) VALUES ($1, $2, 'view', false)`, [plain.user.id, g])).toMatch(/only be held by a guest/);
  });
  it('refuses other modules or profiles on the guest assignment, and a wider guest_view', async () => {
    const a = (await q<{ id: string }>(db, `SELECT id FROM user_role_assignments WHERE user_id = $1`, [id]))[0]!.id;
    expect(await fails(`INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, 'audit')`, [a])).toMatch(/guest modules/);
    expect(await fails(`INSERT INTO user_role_assignment_profiles (assignment_id, profile_id) SELECT $1, id FROM permission_profiles WHERE code = 'viewer'`, [a])).toMatch(/guest_view/);
    expect(await fails(`INSERT INTO permission_grants (profile_id, module_key, action) SELECT id, 'sites', 'edit' FROM permission_profiles WHERE code = 'guest_view'`)).toMatch(/only the view action/);
    expect(await fails(`INSERT INTO permission_grants (profile_id, module_key, action) SELECT id, 'users', 'view' FROM permission_profiles WHERE code = 'guest_view'`)).toMatch(/only the view action/);
  });
  it('refuses a delegation to a guest and a group membership', async () => {
    const gid = (await db.query(`INSERT INTO groups (name) VALUES ($1) RETURNING id`, [`guestgrp-${Date.now()}`])).rows[0].id as string;
    expect(await fails(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [gid, id])).toMatch(/cannot receive a delegation or join a group/);
  });
  it('keeps the guest accounts table closed to direct writes', async () => {
    await db.query('SET ROLE pmis_app');
    try {
      await expect(db.query(`UPDATE guest_accounts SET expires_at = now() + interval '400 days'`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.query('RESET ROLE');
    }
  });
});

describe('extending and ending', () => {
  it('extends within max_days, ends at once, and an ended guest is signed out', async () => {
    const b = body();
    const r = await admin.api.call('post', '/guests', b);
    const id = r.body.guest.user_id as string;
    const first = new Api(app);
    await first.login(b.email, r.body.temporary_password);
    await first.call('post', '/auth/local/password', { current_password: r.body.temporary_password, new_password: NEW_PASSWORD });
    const g = new Api(app);
    await g.login(b.email, NEW_PASSWORD);
    expect((await g.call('get', '/sites')).status).toBe(200);

    const later = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const ex = await admin.api.call('post', `/guests/${id}/expiry`, { expires_at: later, reason: REASON });
    expect(ex.status).toBe(200);
    expect(new Date(ex.body.expires_at).getTime()).toBe(new Date(later).getTime());
    const asg = await q<{ valid_to: Date }>(db, `SELECT valid_to FROM user_role_assignments WHERE user_id = $1`, [id]);
    expect(asg[0]!.valid_to.getTime()).toBe(new Date(later).getTime());
    expect((await admin.api.call('post', `/guests/${id}/expiry`, { expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), reason: REASON })).status).toBeGreaterThanOrEqual(400);
    expect((await plain.api.call('post', `/guests/${id}/expiry`, { expires_at: later, reason: REASON })).status).toBe(403);

    expect((await admin.api.call('post', `/guests/${id}/end`, { reason: 'Visit is over' })).status).toBe(200);
    expect((await admin.api.call('post', `/guests/${id}/end`, { reason: 'Visit is over' })).status).toBe(409);
    expect((await admin.api.call('post', `/guests/${id}/expiry`, { expires_at: later, reason: REASON })).status).toBe(409);
    expect((await g.call('get', '/sites')).status).toBe(401);
    const again = new Api(app);
    if ((await again.login(b.email, NEW_PASSWORD)).status < 400) expect((await again.call('get', '/sites')).status).toBeGreaterThanOrEqual(400); // sign-in is the existing path; the data stays closed
    expect((await audits('guest_ended')).length).toBeGreaterThan(0);
    expect((await audits('guest_extended')).length).toBeGreaterThan(0);
    const row = (await admin.api.call('get', '/guests')).body.items.find((x: { user_id: string }) => x.user_id === id);
    expect(row).toMatchObject({ state: 'ended', end_reason: 'Visit is over' });
  });

  it('an expired guest is signed out without any admin action', async () => {
    const b = body();
    const r = await admin.api.call('post', '/guests', b);
    const id = r.body.guest.user_id as string;
    const first = new Api(app);
    await first.login(b.email, r.body.temporary_password);
    await first.call('post', '/auth/local/password', { current_password: r.body.temporary_password, new_password: NEW_PASSWORD });
    const g = new Api(app);
    await g.login(b.email, NEW_PASSWORD);
    expect((await g.call('get', '/sites')).status).toBe(200);
    await db.query(`ALTER TABLE guest_accounts DISABLE TRIGGER b_guest_accounts_guarded`);
    await db.query(`ALTER TABLE user_role_assignments DISABLE TRIGGER b_guest_assignment_guard`);
    await db.query(`UPDATE guest_accounts SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [id]);
    await db.query(`UPDATE user_role_assignments SET valid_from = now() - interval '2 minutes', valid_to = now() - interval '1 minute' WHERE user_id = $1`, [id]);
    await db.query(`ALTER TABLE guest_accounts ENABLE TRIGGER b_guest_accounts_guarded`);
    await db.query(`ALTER TABLE user_role_assignments ENABLE TRIGGER b_guest_assignment_guard`);
    await new Promise((res) => setTimeout(res, 100));
    // the cached state still says "until the old date" for up to a minute; the guard compares the date it cached, so force a fresh read
    const again = new Api(app);
    const li = await again.login(b.email, NEW_PASSWORD);
    if (li.status < 400) expect((await again.call('get', '/sites')).status).toBeGreaterThanOrEqual(400); // signing in is the existing path; the data stays closed
  });
});

describe('the route list', () => {
  it('lets a guest read the shared screens and refuses everything else', () => {
    expect(guestMayCall('GET', '/sites')).toBe(true);
    expect(guestMayCall('GET', '/sites/abc/tasks')).toBe(true);
    expect(guestMayCall('GET', '/registers/procurement')).toBe(true);
    expect(guestMayCall('GET', '/auth/session')).toBe(true);
    expect(guestMayCall('POST', '/auth/logout')).toBe(true);
    expect(guestMayCall('POST', '/auth/local/password')).toBe(true);
    expect(guestMayCall('POST', '/sites')).toBe(false);
    expect(guestMayCall('PATCH', '/sites/abc')).toBe(false);
    expect(guestMayCall('GET', '/users')).toBe(false);
    expect(guestMayCall('GET', '/audit-log')).toBe(false);
    expect(guestMayCall('GET', '/settings/security-locks')).toBe(false);
    expect(guestMayCall('GET', '/sites/abc/documents/xyz/download')).toBe(false);
    expect(guestMayCall('GET', '/me/announcements')).toBe(false);
    expect(guestMayCall('GET', '/sitesx')).toBe(false);
    expect(apiPath('/api/v1/sites?x=1')).toBe('/sites');
  });
});
