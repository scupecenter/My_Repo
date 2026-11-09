import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mapDbError } from '../src/common/db-errors';
import { ProblemException } from '../src/common/problem';
import type { MailMessage } from '../src/mail/mail.port';
import { MailPort } from '../src/mail/mail.port';
import { Api, adminApi, delegate, loggedIn, makeProfile, makeRole, makeUser, startApp, superDb, TestUser } from './helpers';

// Follow-up group A of the technical decisions of 2026-11-04 (migration 0066, contract 0.13.0):
// Q300 the database refuses an overlapping assignment, Q303 an approved email change ends the sessions, Q307 the admin-override flag of the audit.
// (Q292 and Q294 are in contracts-parties.test.ts, which holds the register fixtures.)
let app: NestExpressApplication;
let db: Pg;
let sent: MailMessage[] = [];

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  vi.spyOn(app.get(MailPort), 'send').mockImplementation(async (m: MailMessage) => { sent.push(m); });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const mailsTo = (addr: string): MailMessage[] => sent.filter((m) => m.to.includes(addr));
let seq = 0;
const freshPhone = (): string => `+21895${String((Date.now() * 11 + seq++ * 7919) % 10_000_000).padStart(7, '0')}`;
const freshEmail = (): string => `fa.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.test`;
const audits = async (action: string, entity: string) =>
  (await db.query(`SELECT before, after, reason, actor_id, on_behalf_of, is_admin_override FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id`, [action, entity])).rows;
const liveSessions = async (userId: string): Promise<number> =>
  (await db.query('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0].n as number;

// ------------------------------------------------------------------------------------------------------------------------------ Q300
describe('Q300: the database refuses an overlapping assignment', () => {
  interface Fix { user: TestUser; role: string }
  async function fix(): Promise<Fix> {
    const user = await makeUser(db, { assigned: false });
    const role = await makeRole(db, { profile: await makeProfile(db, [['sites', 'view']]) });
    return { user, role };
  }
  // A distinct default valid_from per row: two rows in the same millisecond would hit the unique (user, role, valid_from)
  // index instead of the overlap check under test.
  let seq = 0;
  /** One assignment with its region and module rows, in one transaction (the deferred check runs at COMMIT). */
  async function insert(c: Pg, f: Fix, o: { regions?: number[]; modules?: string[]; allRegions?: boolean; allModules?: boolean; from?: string; to?: string | null }): Promise<string> {
    const a = await c.query(
      `INSERT INTO user_role_assignments (user_id, role_id, permission_level, valid_from, valid_to, all_regions, all_modules)
       VALUES ($1, $2, 'view', $3::timestamptz, $4::timestamptz, $5, $6) RETURNING id`,
      [f.user.id, f.role, o.from ?? new Date(Date.now() - 3_600_000 + seq++).toISOString(), o.to ?? null, o.allRegions ?? false, o.allModules ?? false]);
    const id = a.rows[0].id as string;
    for (const r of o.regions ?? []) await c.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, $2)', [id, r]);
    for (const m of o.modules ?? []) await c.query('INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, $2)', [id, m]);
    return id;
  }
  const commit = async (f: Fix, o: Parameters<typeof insert>[2]): Promise<string> => {
    await db.query('BEGIN');
    try {
      const id = await insert(db, f, o);
      await db.query('COMMIT');
      return id;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  };
  const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '23P01', message: expect.stringMatching(/overlaps assignment/) });

  it('refuses the same person and role with a shared region and a shared top-level module (sub-modules and all share it), and allows the independent ones', async () => {
    const f = await fix();
    const first = await commit(f, { regions: [1, 2], modules: ['sites'] });
    await refused(commit(f, { regions: [2, 3], modules: ['sites'] }));              // region 2 and module sites are shared
    await refused(commit(f, { regions: [2], modules: ['sites.tasks'] }));           // a sub-module is its top-level module
    await refused(commit(f, { allRegions: true, modules: ['sites'] }));
    await refused(commit(f, { regions: [3], allModules: true, allRegions: true }));
    await commit(f, { regions: [3], modules: ['sites'] });                          // another region
    await commit(f, { regions: [1], modules: ['warehouse'] });                      // another module
    const other = await makeRole(db, { profile: await makeProfile(db, [['sites', 'view']]) });
    await commit({ ...f, role: other }, { regions: [1, 2], modules: ['sites'] });   // another role of the same person
    await commit({ ...f, user: await makeUser(db, { assigned: false }) }, { regions: [1, 2], modules: ['sites'] });   // another person
    expect((await db.query('SELECT count(*)::int AS n FROM user_role_assignments WHERE id = $1', [first])).rows[0].n).toBe(1);
  });

  it('dates: periods [from, to) that touch do not overlap, overlapping ones do, an open end overlaps every later start', async () => {
    const f = await fix();
    const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();
    await commit(f, { regions: [1], modules: ['sites'], from: day(1), to: day(10) });
    await commit(f, { regions: [1], modules: ['sites'], from: day(10), to: day(20) });          // starts when the first ends
    await refused(commit(f, { regions: [1], modules: ['sites'], from: day(19), to: day(30) }));
    await commit(f, { regions: [1], modules: ['sites'], from: day(25), to: null });             // after the last period, open end
    await refused(commit(f, { regions: [1], modules: ['sites'], from: day(40), to: null }));
  });

  it('a row that has ended neither blocks nor is checked; ending the open row frees its scope', async () => {
    const f = await fix();
    const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();
    await commit(f, { regions: [1], modules: ['sites'], from: day(-30), to: day(-20) });         // ended in the past
    await commit(f, { regions: [1], modules: ['sites'], from: day(-25), to: day(-5) });          // overlaps the ended one in dates, also ended: not checked
    const open = await commit(f, { regions: [1], modules: ['sites'], from: day(-1), to: null });
    await refused(commit(f, { regions: [1], modules: ['sites'], from: day(40), to: null }));
    await db.query('UPDATE user_role_assignments SET valid_to = now() WHERE id = $1', [open]);   // ending it frees the scope
    await commit(f, { regions: [1], modules: ['sites'], from: day(40), to: null });
  });

  it('adding a region or a module to an existing row is checked too; so is moving its dates', async () => {
    const f = await fix();
    await commit(f, { regions: [1], modules: ['sites'] });
    const b = await commit(f, { regions: [2], modules: ['sites'] });
    await db.query('BEGIN');
    await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1)', [b]);
    await refused(db.query('COMMIT'));
    await db.query('ROLLBACK').catch(() => undefined);
    const c = await commit(f, { regions: [1], modules: ['warehouse'], from: new Date(Date.now() + 5 * 86_400_000).toISOString(), to: new Date(Date.now() + 9 * 86_400_000).toISOString() });
    await db.query('BEGIN');
    await db.query('INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, $2)', [c, 'sites']);
    await refused(db.query('COMMIT'));
    await db.query('ROLLBACK').catch(() => undefined);
    // the dates: a later period of the same scope is separate until its dates are moved into the earlier one
    const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();
    const g = await fix();
    const x = await commit(g, { regions: [7], modules: ['sites'], from: day(-1), to: day(5) });
    await commit(g, { regions: [7], modules: ['sites'], from: day(10), to: day(20) });
    await refused(db.query('UPDATE user_role_assignments SET valid_to = $2::timestamptz WHERE id = $1', [x, day(12)]));
    await db.query('UPDATE user_role_assignments SET valid_to = $2::timestamptz WHERE id = $1', [x, day(8)]);   // still apart: allowed
  });

  it('two transactions that each add an overlapping row cannot both commit: the second waits for the first and is refused', async () => {
    const f = await fix();
    const other = await superDb();
    try {
      await db.query('BEGIN');
      await insert(db, f, { regions: [1], modules: ['sites'] });
      await other.query('BEGIN');
      await insert(other, f, { regions: [1], modules: ['sites'] });
      await db.query('COMMIT');
      await refused(other.query('COMMIT'));
      await other.query('ROLLBACK').catch(() => undefined);
    } finally {
      await other.end();
    }
    expect((await db.query('SELECT count(*)::int AS n FROM user_role_assignments WHERE user_id = $1', [f.user.id])).rows[0].n).toBe(1);
  });

  it('rows that overlapped before are reported to the System Log, not refused; ending one or changing its level still works, changing its scope does not', async () => {
    const f = await fix();
    await db.query('BEGIN');
    await db.query("SET LOCAL session_replication_role = 'replica'");   // the deferred check does not fire in this transaction only: the way the old data got in
    const a = await insert(db, f, { regions: [1], modules: ['sites'] });
    const b = await insert(db, f, { regions: [1], modules: ['sites'] });
    await db.query('COMMIT');
    const n = await db.query('SELECT assignment_overlaps_log() AS n');
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
    const log = await db.query(
      `SELECT level::text AS level, source, message, context FROM system_log WHERE source = 'assignments' AND context -> 'assignment_ids' @> to_jsonb($1::text) AND context -> 'assignment_ids' @> to_jsonb($2::text)`, [a, b]);
    expect(log.rows.length).toBe(1);
    expect(log.rows[0]).toMatchObject({ level: 'warn', source: 'assignments', context: { user_id: f.user.id, role_id: f.role } });
    expect(log.rows[0].message).toMatch(/Q300/);
    // a level change (no date or scope column) does not fire the check
    await db.query("UPDATE user_role_assignments SET permission_level = 'entry' WHERE id = $1", [a]);
    // a change of scope does
    await db.query('BEGIN');
    await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 2)', [a]);
    await refused(db.query('COMMIT'));
    await db.query('ROLLBACK').catch(() => undefined);
    // ending one of the two always works, and resolves the overlap
    await db.query('UPDATE user_role_assignments SET valid_to = now() WHERE id = $1', [b]);
    await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 2)', [a]);
  });

  it('the API: bulk-assign still reports the overlap per item; the database error maps to 409 already_assigned', async () => {
    const { api } = await adminApi(app, db);
    const profile = await makeProfile(db, [['sites', 'view']]);
    const role = await makeRole(db, { profile });
    const u = await makeUser(db, { assigned: false });
    const body = (regions: number[]) => ({ user_ids: [u.id], role_ids: [role], defaults: { permission_level: 'entry', region_ids: regions, module_keys: ['sites'], profile_ids: [profile] }, reason: 'Q300 test' });
    expect((await api.call('post', '/assignments/bulk-assign', body([1]))).body.done).toHaveLength(1);
    const again = await api.call('post', '/assignments/bulk-assign', body([1, 2]));
    expect(again.body.done).toHaveLength(0);
    expect(again.body.skipped[0]).toMatchObject({ code: 'already_assigned' });
    expect((await api.call('post', '/assignments/bulk-assign', body([3]))).body.done).toHaveLength(1);
    const err = new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '23P01', message: 'assignment a overlaps assignment b: the person already holds this role for an overlapping region and module in that period' } });
    const p = mapDbError(err);
    expect(p).toBeInstanceOf(ProblemException);
    expect(p).toMatchObject({ status: 409, code: 'already_assigned' });
    const other = mapDbError(new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '23P01', message: 'some other exclusion' } }));
    expect(other).toBeNull();
  });

  it('permission denied: a plain user cannot bulk-assign', async () => {
    const plain = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    await api.stepUp(plain.password);
    const res = await api.call('post', '/assignments/bulk-assign', { user_ids: [plain.id], role_ids: [await makeRole(db)], defaults: { permission_level: 'view', region_ids: [1], module_keys: ['sites'] }, reason: 'no right' });
    expect(res.status).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ Q303 + Q307
describe('Q303: an approved email change ends the sessions; a phone change keeps them', () => {
  it('approve: every session of the user ends (revoke_reason email_changed), a security notice and the mail follow, the audit row counts the sessions and is an admin override', async () => {
    const { admin, api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const a1 = await loggedIn(app, u);
    const a2 = new Api(app);
    expect((await a2.login(u.email, u.password)).status).toBe(200);
    expect(await liveSessions(u.id)).toBe(2);
    const target = freshEmail();
    const r = await a1.call('post', '/me/email-change', { new_email: target, password: u.password });
    expect(r.status).toBe(201);
    sent = [];
    const ok = await adminCall.call('post', `/email-change-requests/${r.body.id}/decide`,
      { decision: 'approve', reason: 'Address confirmed', identity_check: 'Called the user on the registered phone and read back the address' });
    expect(ok.status).toBe(200);
    expect(await liveSessions(u.id)).toBe(0);
    expect((await a1.call('get', '/me/profile')).status).toBe(401);
    expect((await a2.call('get', '/me/profile')).status).toBe(401);
    const rev = await db.query(`SELECT revoke_reason, revoked_by FROM user_sessions WHERE user_id = $1`, [u.id]);
    expect(rev.rows).toEqual([{ revoke_reason: 'email_changed', revoked_by: admin.id }, { revoke_reason: 'email_changed', revoked_by: admin.id }]);
    const note = await db.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'security_notice'`, [u.id]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].body).toMatch(/2 session\(s\) were signed out/);
    const row = (await audits('email_changed', u.id))[0];
    expect(row.after).toMatchObject({ email: target, sessions_ended: 2 });
    expect(row.is_admin_override).toBe(true);
    // both addresses are told that the sessions ended
    expect(mailsTo(u.email).find((m) => m.category === 'email_change_decided')?.text).toMatch(/sessions were signed out/);
    // the user signs in again with the new address
    const again = new Api(app);
    expect((await again.login(target, u.password)).status).toBe(200);
    expect((await again.call('get', '/me/profile')).status).toBe(200);
  });

  it('reject keeps the sessions (and writes no security notice); the audit row is still an admin override', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const r = await api.call('post', '/me/email-change', { new_email: freshEmail(), password: u.password });
    expect((await adminCall.call('post', `/email-change-requests/${r.body.id}/decide`, { decision: 'reject', reason: 'Not this address' })).status).toBe(200);
    expect(await liveSessions(u.id)).toBe(1);
    expect((await api.call('get', '/me/profile')).status).toBe(200);
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'security_notice'`, [u.id])).rowCount).toBe(0);
    expect((await audits('email_change_rejected', u.id))[0].is_admin_override).toBe(true);
  });

  it('a phone change keeps the sessions; its audit rows are admin overrides', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const second = new Api(app);
    await second.login(u.email, u.password);
    const phone = freshPhone();
    const r = await api.call('post', '/me/phone-change', { new_phone: phone, password: u.password });
    expect(r.status).toBe(201);
    expect((await adminCall.call('post', `/phone-change-requests/${r.body.id}/decide`, { decision: 'approve', reason: 'Confirmed in person' })).status).toBe(200);
    expect((await db.query('SELECT phone FROM users WHERE id = $1', [u.id])).rows[0].phone).toBe(phone);
    expect(await liveSessions(u.id)).toBe(2);
    expect((await second.call('get', '/me/profile')).status).toBe(200);
    expect((await audits('phone_changed', u.id))[0].is_admin_override).toBe(true);
    const r2 = await api.call('post', '/me/phone-change', { new_phone: freshPhone(), password: u.password });
    expect((await adminCall.call('post', `/phone-change-requests/${r2.body.id}/decide`, { decision: 'reject', reason: 'Not now' })).status).toBe(200);
    expect((await audits('phone_change_rejected', u.id))[0].is_admin_override).toBe(true);
    // the user's own request is not an override
    expect((await audits('phone_change_requested', u.id))[0].is_admin_override).toBe(false);
  });

  it('a delegate holding users.edit decides the same way: the sessions end and the row is an admin override on behalf of the admin; a plain user cannot decide', async () => {
    await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const uApi = await loggedIn(app, u);
    const r = await uApi.call('post', '/me/email-change', { new_email: freshEmail(), password: u.password });
    const plain = await makeUser(db, { assigned: true });
    const pApi = await loggedIn(app, plain);
    await pApi.stepUp(plain.password);
    expect((await pApi.call('post', `/email-change-requests/${r.body.id}/decide`, { decision: 'approve', reason: 'No right', identity_check: 'I know them' })).status).toBe(403);
    expect(await liveSessions(u.id)).toBe(1);
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'edit']]);
    const dApi = await loggedIn(app, del);
    await dApi.stepUp(del.password);
    const ok = await dApi.call('post', `/email-change-requests/${r.body.id}/decide`, { decision: 'approve', reason: 'Delegate decides', identity_check: 'Called the user on the registered phone' });
    expect(ok.status).toBe(200);
    expect(await liveSessions(u.id)).toBe(0);
    const row = (await audits('email_changed', u.id))[0];
    expect(row.is_admin_override).toBe(true);
    expect(row.on_behalf_of).not.toBeNull();
  });
});

describe('Q307: log_audit_write takes the admin-override flag', () => {
  it('an admin turning two-factor on, enforcing and off for another person writes admin-override rows; the person\'s own profile change does not', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const on = await adminCall.call('put', `/users/${u.id}/two-factor`, { enabled: true, reason: 'Policy' });
    expect(on.status).toBe(200);
    expect((await audits('two_factor_enabled', u.id))[0].is_admin_override).toBe(true);
    const off = await adminCall.call('put', `/users/${u.id}/two-factor`, { enabled: false, reason: 'Phone replaced' });
    expect(off.status).toBe(200);
    expect((await audits('two_factor_disabled', u.id))[0].is_admin_override).toBe(true);
    const me = await loggedIn(app, u);
    const etag = (await me.call('get', '/me/profile')).headers.etag as string;
    expect((await me.call('patch', '/me/profile', { display_name: 'Renamed Person' }, { 'If-Match': etag })).status).toBe(200);
    expect((await audits('profile_updated', u.id))[0].is_admin_override).toBe(false);
  });

  it('the audit log lists them as privileged again: filter admin_override', async () => {
    const { api: adminCall } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const r = await (await loggedIn(app, u)).call('post', '/me/email-change', { new_email: freshEmail(), password: u.password });
    await adminCall.call('post', `/email-change-requests/${r.body.id}/decide`, { decision: 'reject', reason: 'Not this address' });
    const res = await adminCall.call('get', `/audit-log?admin_override=true&action=email_change_rejected&limit=200`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((x: { entity_id: string; is_admin_override: boolean }) => x.entity_id === u.id && x.is_admin_override)).toBe(true);
  });

  it('the old call forms keep working and leave the flag off; only a System Admin or a delegate can set it', async () => {
    const plain = await makeUser(db, { assigned: true });
    const set = async (actorId: string, args: string): Promise<number> => {
      const c = await superDb();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE pmis_app');
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);
        const r = await c.query(`SELECT log_audit_write(${args}) AS id`);
        await c.query('COMMIT');
        return Number(r.rows[0].id);
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await c.end();
      }
    };
    const six = await set(plain.id, `'fa_probe', 'setting', 'x', NULL, NULL, 'probe'`);
    const nine = await set(plain.id, `'fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL`);
    for (const id of [six, nine]) expect((await db.query('SELECT is_admin_override FROM audit_log WHERE id = $1', [id])).rows[0].is_admin_override).toBe(false);
    await expect(set(plain.id, `'fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL, true`)).rejects.toMatchObject({ code: '42501' });
    const admin = await adminApi(app, db);
    const withFlag = await set(admin.admin.id, `'fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL, true`);
    expect((await db.query('SELECT is_admin_override FROM audit_log WHERE id = $1', [withFlag])).rows[0].is_admin_override).toBe(true);
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'edit']]);
    const byDelegate = await set(del.id, `'fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL, true`);
    expect((await db.query('SELECT is_admin_override FROM audit_log WHERE id = $1', [byDelegate])).rows[0].is_admin_override).toBe(true);
  });
});
