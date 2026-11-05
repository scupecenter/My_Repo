import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, beginAs, delegate, makeUser, startApp } from './helpers';
import { G, Team, approveFlex, recPath, regCell } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0072 (contract 0.14.2): the settings screens of Q440 (confirm the official calendar) and Q441 (the mail notification kinds), and the notice of Q477 to the
 * Team Leads of the new region. The suite runs in its own database (TEST_DATABASE_URL_SS): it changes two shared settings and counts notifications.
 * Q476 (the RF & Design feed) is in register-feeds.test.ts, where the feed is tested.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;       // a System Admin, signed in, with step-up
let adminNoStep: Actor; // a System Admin without step-up
let plain: Actor;       // a user with the Sites module only
let allDelegate: Actor; // a delegate of calendars (settings) edit for all regions
let regDelegate: Actor; // a delegate of the same right for one region only

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_SS as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_SS });
  await db.connect();
  admin = await plainAdmin(app, db);
  adminNoStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  allDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, allDelegate.user.id, [['calendars', 'edit']]);
  regDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, regDelegate.user.id, [['calendars', 'edit']], [5]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
// audit rows written since the start of the current test (the log is append-only, so each test reads from its own mark)
let mark = 0;
beforeEach(async () => {
  mark = Number((await q<{ m: string }>(db, 'SELECT coalesce(max(id), 0) AS m FROM audit_log'))[0]!.m);
});
const auditRows = (action: string, entityId: string) =>
  q<{ before: any; after: any; reason: string; actor_id: string | null }>(db, 'SELECT before, after, reason, actor_id FROM audit_log WHERE action = $1 AND entity_id = $2 AND id > $3 ORDER BY id', [action, entityId, mark]);
const setting = async (key: string): Promise<any> => (await q<{ value: unknown }>(db, 'SELECT value FROM settings WHERE key = $1', [key]))[0]?.value;

// =====================================================================================================================
// Q440: the official calendar is confirmed in Settings
// =====================================================================================================================
describe('Q440: confirm and unconfirm the official calendar', () => {
  const KEY = 'calendar.official_confirmed';
  let year = 2026;

  beforeEach(async () => {
    year = Number((await q<{ y: number }>(db, 'SELECT extract(year FROM cal_today())::int AS y'))[0]!.y);
    // a calendar that can be confirmed: a holiday in the current and the next year, none tentative, the setting off
    await db.query('UPDATE holidays SET tentative = false');
    for (const y of [year, year + 1]) {
      await db.query(
        `INSERT INTO holidays (calendar_id, date, name, kind, tentative) SELECT cal_default(), make_date($1, 12, 30), 'Test holiday ' || $1, 'national', false
         WHERE NOT EXISTS (SELECT 1 FROM holidays h WHERE h.calendar_id = cal_default() AND extract(year FROM h.date) = $1)`, [y]);
    }
    await db.query(`UPDATE settings SET value = 'false'::jsonb, updated_at = now(), updated_by = NULL WHERE key = $1`, [KEY]);
  });

  const get = (who: Actor) => who.api.call('get', '/settings/calendar-confirmation');
  const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/calendar-confirmation', body, tag === undefined ? {} : { 'If-Match': tag });
  const banner = async (who: Actor = plain): Promise<any> => (await who.api.call('get', '/settings/holidays')).body.summary;

  it('every signed-in user reads the state; only an admin or an all-regions delegate has can_edit', async () => {
    for (const [who, can] of [[plain, false], [regDelegate, false], [allDelegate, true], [admin, true]] as [Actor, boolean][]) {
      const res = await get(who);
      expect(res.status).toBe(200);
      expect(etag(res)).toMatch(/^"\d{1,9}"$/);
      expect(res.body).toMatchObject({ confirmed: false, confirmed_at: null, confirmed_by: null, can_edit: can, blockers: [] });
      expect(res.body.version).toBe(Number(etag(res).replace(/"/g, '')));
    }
    expect((await new Api(app).raw('get', '/settings/calendar-confirmation')).status).toBe(401);
  });

  it('a System Admin confirms with a reason and If-Match: the banner goes, who and when are shown, the audit row has before and after', async () => {
    expect((await banner()).official_calendar_pending).toBe(true);
    const cur = await get(admin);
    const res = await put(admin, { confirmed: true, reason: 'Official announcement of the ministry' }, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmed: true, can_edit: true, blockers: [], confirmed_by: { id: admin.user.id } });
    expect(res.body.confirmed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(etag(res)).not.toBe(etag(cur));                                          // the ETag moves with the change
    expect(await setting(KEY)).toBe(true);
    const s = await banner();
    expect(s).toMatchObject({ official_calendar_pending: false, official_confirmed_by: { id: admin.user.id, display_name: admin.user.name } });
    expect(Date.parse(s.official_confirmed_at)).toBeGreaterThan(Date.now() - 60_000);
    // anybody sees the banner gone and who confirmed it
    expect((await get(plain)).body).toMatchObject({ confirmed: true, confirmed_by: { id: admin.user.id } });
    const rows = await auditRows('calendar_official_confirmed', KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: admin.user.id, reason: 'Official announcement of the ministry', before: { confirmed: false, confirmed_at: null, confirmed_by: null } });
    expect(rows[0]!.after).toMatchObject({ confirmed: true, confirmed_by: admin.user.id });
    expect(rows[0]!.after.confirmed_at).toBeTruthy();
  });

  it('unconfirms with a reason: the banner returns, the audit row records the state before and after', async () => {
    await put(admin, { confirmed: true, reason: 'confirm first' }, etag(await get(admin)));
    const cur = await get(admin);
    const res = await put(admin, { confirmed: false, reason: 'A date was announced again' }, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmed: false, confirmed_at: null, confirmed_by: null });
    expect(await setting(KEY)).toBe(false);
    expect((await banner()).official_calendar_pending).toBe(true);
    expect((await banner()).official_confirmed_by).toBeNull();
    const rows = await auditRows('calendar_official_unconfirmed', KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: admin.user.id, reason: 'A date was announced again', before: { confirmed: true, confirmed_by: admin.user.id }, after: { confirmed: false } });
  });

  it('requires If-Match (428), refuses a stale one (412), a missing reason and unknown keys (422), and repeating the state (409)', async () => {
    const cur = await get(admin);
    expect((await put(admin, { confirmed: true, reason: 'no tag' })).status).toBe(428);
    const stale = await put(admin, { confirmed: true, reason: 'stale tag' }, '"1"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    expect((await put(admin, { confirmed: true }, etag(cur))).status).toBe(422);
    expect((await put(admin, { confirmed: true, reason: 'ab' }, etag(cur))).status).toBe(422);
    const extra = await put(admin, { confirmed: true, reason: 'extra key', year: 2027 }, etag(cur));
    expect(extra.status).toBe(422);
    expect(extra.body.errors[0]).toMatchObject({ code: 'unknown_field' });
    expect((await put(admin, { reason: 'no flag' }, etag(cur))).status).toBe(422);
    expect((await put(admin, { confirmed: 'yes', reason: 'wrong type' }, etag(cur))).status).toBe(422);
    expect((await put(admin, { confirmed: false, reason: 'already not confirmed' }, etag(cur))).status).toBe(409);
    expect(await setting(KEY)).toBe(false);
    const ok = await put(admin, { confirmed: true, reason: 'now for real' }, '*');       // * matches any version
    expect(ok.status).toBe(200);
    const again = await put(admin, { confirmed: true, reason: 'twice' }, etag(ok));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
    expect(await auditRows('calendar_official_confirmed', KEY)).toHaveLength(1);
  });

  it('is refused (403) for a user without the right and for a delegate limited to some regions; nothing changes and nothing is audited', async () => {
    const before = (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [KEY]))[0]!.n;
    const tag = etag(await get(admin));
    for (const who of [plain, regDelegate]) {
      const res = await put(who, { confirmed: true, reason: 'I am sure' }, tag);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('action_forbidden');
    }
    expect(await setting(KEY)).toBe(false);
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [KEY]))[0]!.n).toBe(before);
  });

  it('a delegate of settings edit for all regions may confirm; the audit row names the delegate', async () => {
    const res = await put(allDelegate, { confirmed: true, reason: 'On behalf of the administrator' }, etag(await get(allDelegate)));
    expect(res.status).toBe(200);
    expect(res.body.confirmed_by).toMatchObject({ id: allDelegate.user.id });
    const rows = await auditRows('calendar_official_confirmed', KEY);
    expect(rows.at(-1)).toMatchObject({ actor_id: allDelegate.user.id });
    expect((await put(allDelegate, { confirmed: false, reason: 'and back again' }, etag(res))).status).toBe(200);
  });

  it('is refused while the current or the next year has no holiday, or a holiday of those years is still tentative; unconfirming is always allowed', async () => {
    // a tentative holiday of the current year
    await db.query(`UPDATE holidays SET tentative = true WHERE id = (SELECT id FROM holidays WHERE calendar_id = cal_default() AND extract(year FROM date) = $1 LIMIT 1)`, [year]);
    const g = await get(admin);
    expect(g.body.blockers).toEqual([{ code: 'tentative_remaining', year, count: 1 }]);
    const t = await put(admin, { confirmed: true, reason: 'too early' }, etag(g));
    expect(t.status).toBe(422);
    expect(t.body.errors[0]).toMatchObject({ path: '/confirmed', code: 'tentative_remaining' });
    expect(await setting(KEY)).toBe(false);
    // a tentative date of another year does not block
    await db.query('UPDATE holidays SET tentative = false');
    await db.query(`INSERT INTO holidays (calendar_id, date, name, kind, tentative) VALUES (cal_default(), make_date($1, 3, 3), 'Far away', 'religious', true)
                    ON CONFLICT DO NOTHING`, [year + 3]);
    expect((await get(admin)).body.blockers).toEqual([]);
    await db.query(`DELETE FROM holidays WHERE date = make_date($1, 3, 3)`, [year + 3]);
    // no holiday at all in the next year
    await db.query(`UPDATE holidays SET date = date - interval '2 years' WHERE extract(year FROM date) = $1`, [year + 1]);
    const n = await get(admin);
    expect(n.body.blockers).toEqual([{ code: 'no_holidays', year: year + 1, count: 0 }]);
    const e = await put(admin, { confirmed: true, reason: 'no next year' }, etag(n));
    expect(e.status).toBe(422);
    expect(e.body.errors[0]).toMatchObject({ path: '/confirmed', code: 'no_holidays' });
    // an unconfirm is allowed while blockers stand
    await db.query(`UPDATE settings SET value = 'true'::jsonb, updated_at = now() WHERE key = $1`, [KEY]);
    const off = await put(admin, { confirmed: false, reason: 'withdraw it' }, etag(await get(admin)));
    expect(off.status).toBe(200);
    expect(off.body.confirmed).toBe(false);
  });

  it('the ETag also moves with the yearly reset and with a change made in the database', async () => {
    const a = etag(await get(admin));
    await db.query(`UPDATE settings SET value = 'true'::jsonb, updated_at = now() + interval '1 second', updated_by = NULL WHERE key = $1`, [KEY]);
    const res = await get(admin);
    expect(etag(res)).not.toBe(a);
    expect(res.body).toMatchObject({ confirmed: true, confirmed_by: null });          // set in the database: no person
    expect((await banner()).official_calendar_pending).toBe(false);
    expect((await put(admin, { confirmed: false, reason: 'stale view' }, a)).status).toBe(412);
  });
});

// =====================================================================================================================
// Q441: the mail notification kinds
// =====================================================================================================================
describe('Q441: the mail notification kinds', () => {
  const KEY = 'mail.notification_kinds';
  const SIX = ['register_assigned', 'register_rejected', 'snag_rejected', 'snag_review', 'task_assigned', 'task_rejected'];
  const get = (who: Actor) => who.api.call('get', '/settings/mail-notification-kinds');
  const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/mail-notification-kinds', body, tag === undefined ? {} : { 'If-Match': tag });
  beforeEach(async () => {
    await db.query(`UPDATE settings SET value = '[]'::jsonb, updated_at = now(), updated_by = NULL WHERE key = $1`, [KEY]);
  });

  it('lists the kinds of the code with the six go-live kinds recommended, for a System Admin only', async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    expect(etag(res)).toMatch(/^"\d{1,9}"$/);
    expect(res.body).toMatchObject({ kinds: [], unknown_kinds: [], updated_by: null });
    const cat = res.body.catalogue as { kind: string; recommended: boolean }[];
    expect(cat.filter((c) => c.recommended).map((c) => c.kind).sort()).toEqual(SIX);
    expect(cat.map((c) => c.kind)).toEqual(expect.arrayContaining(['mention', 'site_region_moved', 'snag_closed', 'no_eligible_holder']));
    expect(new Set(cat.map((c) => c.kind)).size).toBe(cat.length);
    // nothing reserved is offered
    expect(cat.filter((c) => /^(security_|integrity_|audit_integrity|break_glass|retention_)/.test(c.kind))).toEqual([]);
    for (const who of [plain, allDelegate, regDelegate]) {
      const denied = await get(who);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('action_forbidden');
    }
  });

  it('a System Admin saves the six go-live kinds with a reason, step-up and If-Match: sorted, audited with before and after', async () => {
    const cur = await get(admin);
    const res = await put(admin, { kinds: ['task_assigned', 'snag_review', 'register_assigned', 'task_rejected', 'register_rejected', 'snag_rejected'], reason: 'Go-live list (Q250)' }, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body.kinds).toEqual(SIX);
    expect(res.body.updated_by).toMatchObject({ id: admin.user.id });
    expect(etag(res)).not.toBe(etag(cur));
    expect(await setting(KEY)).toEqual(SIX);
    const rows = await auditRows('mail_notification_kinds_update', KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: admin.user.id, reason: 'Go-live list (Q250)', before: { kinds: [] }, after: { kinds: SIX } });
    // the list now decides: a notification of a listed kind is mailed, one of another kind is not
    const u = await makeUser(db, { assigned: true });
    await db.query(`INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'task_assigned', 'Task B5 is yours', 'b', '/tasks/2'), ($1, 'mention', 'Mentioned', 'b', '/tasks/2')`, [u.id]);
    expect((await q<{ kind: string }>(db, 'SELECT kind FROM mail_outbox WHERE to_user_id = $1', [u.id])).map((r) => r.kind)).toEqual(['notification.task_assigned']);
    // an empty list is allowed and keeps everything in-app
    const none = await put(admin, { kinds: [], reason: 'back to in-app only' }, etag(res));
    expect(none.status).toBe(200);
    expect(none.body.kinds).toEqual([]);
    expect((await auditRows('mail_notification_kinds_update', KEY)).at(-1)).toMatchObject({ before: { kinds: SIX }, after: { kinds: [] } });
  });

  it('refuses unknown kinds, reserved kinds, duplicates and malformed values with field errors; nothing is saved', async () => {
    const tag = etag(await get(admin));
    const bad = await put(admin, {
      kinds: ['task_assigned', 'made_up_kind', 'security_alert', 'integrity_head', 'security_notice', 'audit_integrity_failure', 'break_glass_used', 'retention_reduced', 'task_assigned', 'Bad Kind'],
      reason: 'mixed list',
    }, tag);
    expect(bad.status).toBe(422);
    const errs = bad.body.errors as { path: string; code: string }[];
    expect(errs).toEqual(expect.arrayContaining([
      { path: '/kinds/1', code: 'unknown_kind', message: expect.any(String) },
      { path: '/kinds/2', code: 'reserved_kind', message: expect.any(String) },
      { path: '/kinds/3', code: 'reserved_kind', message: expect.any(String) },
      { path: '/kinds/4', code: 'reserved_kind', message: expect.any(String) },
      { path: '/kinds/5', code: 'reserved_kind', message: expect.any(String) },
      { path: '/kinds/6', code: 'reserved_kind', message: expect.any(String) },
      { path: '/kinds/7', code: 'reserved_kind', message: expect.any(String) },
      { path: '/kinds/8', code: 'duplicate', message: expect.any(String) },
      { path: '/kinds/9', code: 'invalid', message: expect.any(String) },
    ].map((e) => expect.objectContaining(e))));
    expect(errs.some((e) => e.path === '/kinds/0')).toBe(false);                    // the valid kind has no error
    expect(await setting(KEY)).toEqual([]);
    expect(await auditRows('mail_notification_kinds_update', KEY)).toHaveLength(0);
    // the shape errors the API itself catches
    expect((await put(admin, { kinds: 'task_assigned', reason: 'not a list' }, tag)).status).toBe(422);
    expect((await put(admin, { kinds: [], reason: 'extra', other: 1 }, tag)).status).toBe(422);
    expect((await put(admin, { kinds: Array.from({ length: 101 }, (_, i) => `k${i}`), reason: 'too many' }, tag)).status).toBe(422);
    expect((await put(admin, { kinds: ['task_assigned'] }, tag)).status).toBe(422);
    const num = await put(admin, { kinds: ['task_assigned', 7], reason: 'a number' }, tag);
    expect(num.status).toBe(422);
    expect(num.body.errors[0]).toMatchObject({ path: '/kinds/1' });
  });

  it('needs step-up (401), If-Match (428) and a current version (412)', async () => {
    const tag = etag(await get(adminNoStep));
    const noStep = await put(adminNoStep, { kinds: ['task_assigned'], reason: 'no step-up' }, tag);
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await put(admin, { kinds: ['task_assigned'], reason: 'no tag' })).status).toBe(428);
    const stale = await put(admin, { kinds: ['task_assigned'], reason: 'stale tag' }, '"3"');
    expect(stale.status).toBe(412);
    expect(await setting(KEY)).toEqual([]);
    // the database refuses a write without the verified step-up too, whatever the API checked (the context carries no step-up)
    const app2 = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_SS });
    await app2.connect();
    try {
      await app2.query('BEGIN');
      await beginAs(app2, adminNoStep.user.id);
      await expect(app2.query(`SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'no step-up', NULL)`)).rejects.toThrow(/step_up_required/);
      await app2.query('ROLLBACK');
      await app2.query('BEGIN');
      await beginAs(app2, adminNoStep.user.id, { stepupUntil: new Date(Date.now() + 60_000) });
      await app2.query(`SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'with step-up', NULL)`);
      await app2.query('ROLLBACK');
      // a delegate or any other user is refused by the database as well, with a valid step-up
      await app2.query('BEGIN');
      await beginAs(app2, allDelegate.user.id, { stepupUntil: new Date(Date.now() + 60_000) });
      await expect(app2.query(`SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'delegate', NULL)`)).rejects.toThrow(/System Admin only/);
      await app2.query('ROLLBACK');
      await app2.query('BEGIN');
      await beginAs(app2, allDelegate.user.id);
      await expect(app2.query(`SELECT mail_kinds_json()`)).rejects.toThrow(/System Admin only/);
      await app2.query('ROLLBACK');
    } finally {
      await app2.end();
    }
    expect(await setting(KEY)).toEqual([]);
  });

  it('is refused (403) for everybody but a System Admin, a delegate of settings edit included', async () => {
    const tag = etag(await get(admin));
    for (const who of [plain, allDelegate, regDelegate]) {
      await who.api.stepUp(who.user.password);
      const res = await put(who, { kinds: ['task_assigned'], reason: 'I would like this' }, tag);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('action_forbidden');
    }
    expect(await setting(KEY)).toEqual([]);
    expect(await auditRows('mail_notification_kinds_update', KEY)).toHaveLength(0);
  });

  it('shows kinds set in the database that the code does not write as unknown_kinds; the next save drops them', async () => {
    await db.query(`UPDATE settings SET value = '["task_assigned", "task_returned", "legacy_kind"]'::jsonb, updated_at = now() + interval '1 second' WHERE key = $1`, [KEY]);
    const res = await get(admin);
    expect(res.body.kinds).toEqual(['task_assigned', 'task_returned', 'legacy_kind']);
    expect(res.body.unknown_kinds).toEqual(['task_returned', 'legacy_kind']);
    const saved = await put(admin, { kinds: ['task_assigned'], reason: 'drop the unknown ones' }, etag(res));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ kinds: ['task_assigned'], unknown_kinds: [] });
    expect((await auditRows('mail_notification_kinds_update', KEY)).at(-1)).toMatchObject({ before: { kinds: ['task_assigned', 'task_returned', 'legacy_kind'] } });
  });

  it('the catalogue holds every kind the migrations write (a new kind must be added to mail_kind_catalogue)', async () => {
    const dir = resolve(__dirname, '..', 'prisma', 'migrations');
    const found = new Set<string>();
    for (const d of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const sql = readFileSync(join(dir, d.name, 'migration.sql'), 'utf8');
      for (const m of sql.matchAll(/\(\s*[A-Za-z_.0-9]+\s*,\s*'in_app'(?:::"NotifyChannel")?\s*,\s*'([a-z][a-z_]+)'/g)) found.add(m[1]!);
      for (const m of sql.matchAll(/\b(wf_notify_admins|reg_notify_admins|wf_notify|reg_notify|qc_notify_level|qc_notify|calc_alert)\s*\(([^;]*?)\)\s*(?:;|INTO|FROM|,|\n)/gs)) {
        // qc_notify_level(snag, level, except, kind, title): the kind is the second word-literal (the first is the level)
        const lits = [...m[2]!.matchAll(/'([a-z][a-z_]+)'/g)].map((x) => x[1]!);
        const lit = m[1] === 'qc_notify_level' ? lits[1] : lits[0];
        if (lit) found.add(lit);
      }
    }
    // not kinds: the level words of qc_notify_level, and values the SQL passes through the same helpers' arguments
    for (const x of ['entry', 'approve', 'task', 'register_record', 'in_app', 'company_type', 'contractor_name']) found.delete(x);
    const cat = (await get(admin)).body.catalogue.map((c: { kind: string }) => c.kind) as string[];
    const reserved = (k: string): boolean => /^(security_|integrity_|audit_integrity|break_glass|retention_)/.test(k);
    const missing = [...found].filter((k) => !cat.includes(k) && !reserved(k) && k !== 'system');
    expect(missing).toEqual([]);
    // and everything offered is written by something (a kind nobody writes would be a dead checkbox)
    const offeredButNotFound = cat.filter((k) => !found.has(k) && k !== 'site_region_moved');
    expect(offeredButNotFound).toEqual([]);
  });
});

// =====================================================================================================================
// Q477: the Team Leads of the new region are told when a site moves there
// =====================================================================================================================
describe('Q477: an approved region move tells the Team Leads of the new region', () => {
  const R = 6;       // the site's region
  const TO = 5;      // the new region: it has leads
  const NOBODY = 7;  // a region where nobody holds the reassign grant
  const TAG = randomBytes(2).toString('hex').toUpperCase();
  let n = 0;
  let adminA: Actor; let adminB: Actor;
  let leadTo: Actor; let delegTo: Actor; let leadFrom: Actor; let plainTo: Actor; let blindLead: Actor; let endedLead: Actor;
  const REASSIGN: [string, string] = ['overrides.reassign', 'administer'];

  beforeAll(async () => {
    adminA = await plainAdmin(app, db);
    adminB = await plainAdmin(app, db);
    leadTo = await actor(app, db, { level: 'approve', grants: [...G('sites', 'view'), REASSIGN], regions: [TO], modules: null });
    delegTo = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [TO], modules: null });
    await delegate(db, delegTo.user.id, [REASSIGN]);
    leadFrom = await actor(app, db, { level: 'approve', grants: [...G('sites', 'view'), REASSIGN], regions: [R], modules: null });
    plainTo = await actor(app, db, { level: 'approve', grants: G('sites', 'view'), regions: [TO], modules: null });
    // holds the grant for the region but cannot see the Sites module there: not told
    blindLead = await actor(app, db, { level: 'approve', grants: [REASSIGN], regions: [TO], modules: ['approvals'] });
    // an assignment that has ended: not told
    endedLead = await actor(app, db, { level: 'approve', grants: [...G('sites', 'view'), REASSIGN], regions: [TO], modules: null });
    await db.query(`UPDATE user_role_assignments SET valid_to = now() - interval '1 day', valid_from = now() - interval '2 days' WHERE user_id = $1`, [endedLead.user.id]);
  });
  beforeEach(async () => {
    await db.query('SELECT pg_advisory_lock(770102)');
    await regCell(db, 'change_control', R, 'entry', { user: [adminA.user.id] });
    await regCell(db, 'change_control', R, 'approve', { user: [adminB.user.id] });
    await db.query('SELECT pg_advisory_unlock(770102)');
  });

  const teamOf = (site: { id: string; code: string; region: number }): Team => ({ entry: adminA, review: adminA, approve: adminB, site, region: R, key: 'change_control' });
  const noticesOf = (siteId: string) => q<{ user_id: string; kind: string; title: string; body: string; link: string; region_id: number; module_key: string; read_at: string | null }>(
    db, `SELECT user_id, kind, title, body, link, region_id, module_key, read_at FROM notifications WHERE kind = 'site_region_moved' AND link = $1 ORDER BY created_at, id`, ['/sites/' + siteId]);
  const taskState = (siteId: string) => q<Record<string, unknown>>(db,
    `SELECT td.code, t.state::text AS state, t.ball_in_court_user_id, t.ball_in_court_group_id, t.sla_rule_id, t.sla_start_date::text AS sla_start, t.due_date::text AS due, t.version
     FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1 ORDER BY td.code`, [siteId]);

  async function moveSite(siteId: string, site: { id: string; code: string; region: number }, to: number): Promise<void> {
    const prop = await adminA.api.call('post', `/sites/${siteId}/change-proposals`, { identity: { region_id: to }, reason: `move to region ${to} ${TAG}${++n}` });
    expect(prop.status).toBe(201);
    const rec = (await adminA.api.call('get', recPath('change_control', prop.body.items[0].record_id))).body as { id: string; version: number };
    await approveFlex(teamOf(site), rec.id, rec.version);
    expect((await q<{ region_id: number }>(db, 'SELECT region_id FROM sites WHERE id = $1', [siteId]))[0]!.region_id).toBe(to);
  }

  it('lists the site and its open tasks for the holders of the reassign grant of the new region; the tasks keep their holders and SLA', async () => {
    const site = await makeSite(db, R, { prefix: 'MV' });
    const a1 = await makeTask(db, site, 'A1', 'open');
    const a2 = await makeTask(db, site, 'A2', 'in_review');
    await makeTask(db, site, 'A3', 'approved');
    await makeTask(db, site, 'A4', 'locked');
    await db.query('UPDATE task_instances SET ball_in_court_user_id = $2, due_date = current_date + 5, sla_start_date = current_date - 2 WHERE id = $1', [a1, leadFrom.user.id]);
    const grp = (await q<{ id: string }>(db, `INSERT INTO groups (name) VALUES ($1) RETURNING id`, [`Old region reviewers ${TAG}${++n}`]))[0]!.id;
    await db.query('UPDATE task_instances SET ball_in_court_group_id = $2 WHERE id = $1', [a2, grp]);
    const before = await taskState(site.id);

    await moveSite(site.id, site, TO);

    // B12b: nothing was reassigned and nothing reset
    const after = await taskState(site.id);
    expect(after).toEqual(before);
    expect(after.find((t) => t.code === 'A1')).toMatchObject({ ball_in_court_user_id: leadFrom.user.id, state: 'open' });

    // the notice: to the two holders of the grant who see the site in the new region, and to nobody else
    const notes = await noticesOf(site.id);
    expect(notes.map((x) => x.user_id).sort()).toEqual([leadTo.user.id, delegTo.user.id].sort());
    for (const nt of notes) {
      expect(nt).toMatchObject({ kind: 'site_region_moved', link: `/sites/${site.id}`, region_id: TO, module_key: 'sites', read_at: null });
      expect(nt.title).toContain(site.code);
      expect(nt.body).toContain(`${site.code} moved from GM to Benghazi`);
      expect(nt.body).toMatch(/2 open task\(s\) keep their holders and their SLA; nothing was reassigned/);
      expect(nt.body).toMatch(/- A1 .*\[open\], with .*\(/);                             // the holder is named with the employee ID
      expect(nt.body).toContain(leadFrom.user.name);
      expect(nt.body).toMatch(/- A2 .*\[in_review\], with group Old region reviewers/);
      expect(nt.body).not.toMatch(/A3 /);                                                // approved: not open
      expect(nt.body).not.toMatch(/A4 /);                                                // locked: not open
    }
    for (const nobody of [leadFrom, plainTo, blindLead, endedLead]) {
      expect((await q(db, `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'site_region_moved'`, [nobody.user.id])).length).toBe(0);
    }
    // it is audited, in the new region
    const a = await q<{ after: any; region_id: number; reason: string }>(db, `SELECT after, region_id, reason FROM audit_log WHERE action = 'site_region_move_notified' AND entity_id = $1`, [site.id]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ region_id: TO, after: { from_region_id: R, to_region_id: TO, recipients: 2, open_tasks: 2, fallback_to_system_admins: false } });

    // the lead reads it in the inbox
    const inbox = await leadTo.api.call('get', '/notifications');
    expect(inbox.status).toBe(200);
    const item = (inbox.body.items as { kind: string; link: string }[]).find((x) => x.link === `/sites/${site.id}`);
    expect(item).toMatchObject({ kind: 'site_region_moved' });
    // the lead of the old region sees the audit of the move out, not a notice
    expect((await leadFrom.api.call('get', '/notifications')).body.items.some((x: { kind: string }) => x.kind === 'site_region_moved')).toBe(false);
  });

  it('a site with no open task is still announced, and a long list is cut at 25 tasks with a count', async () => {
    const empty = await makeSite(db, R, { prefix: 'MV' });
    await moveSite(empty.id, empty, TO);
    const e = await noticesOf(empty.id);
    expect(e).toHaveLength(2);
    expect(e[0]!.body).toContain('It has no open task.');

    const busy = await makeSite(db, R, { prefix: 'MV' });
    await db.query(
      `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, updated_at)
       SELECT $1, $2, td.id, 'open', 1, 3, now() FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1`, [busy.id, R]);
    const open = (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_instances WHERE site_id = $1`, [busy.id]))[0]!.n;
    expect(open).toBeGreaterThan(25);
    await moveSite(busy.id, busy, TO);
    const b = (await noticesOf(busy.id))[0]!;
    expect(b.body).toContain(`${open} open task(s)`);
    expect(b.body.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(25);
    expect(b.body).toContain(`... and ${open - 25} more.`);
  });

  it('goes to the System Admins when nobody holds the grant in the new region', async () => {
    const site = await makeSite(db, R, { prefix: 'MV' });
    await makeTask(db, site, 'A1', 'open');
    await moveSite(site.id, site, NOBODY);
    const notes = await noticesOf(site.id);
    const ids = notes.map((x) => x.user_id);
    expect(ids).toEqual(expect.arrayContaining([adminA.user.id, adminB.user.id]));
    for (const lead of [leadTo, delegTo, leadFrom, plainTo]) expect(ids).not.toContain(lead.user.id);
    expect(notes.every((x) => x.region_id === NOBODY)).toBe(true);
    const a = await q<{ after: any }>(db, `SELECT after FROM audit_log WHERE action = 'site_region_move_notified' AND entity_id = $1`, [site.id]);
    expect(a[0]!.after).toMatchObject({ fallback_to_system_admins: true, open_tasks: 1 });
  });

  it('other identity changes send no notice, and a proposal that is not approved moves nothing and tells nobody', async () => {
    const site = await makeSite(db, R, { prefix: 'MV' });
    await makeTask(db, site, 'A1', 'open');
    const prop = await adminA.api.call('post', `/sites/${site.id}/change-proposals`, { identity: { name: `Renamed ${TAG}${++n}` }, reason: 'a name is not a move' });
    expect(prop.status).toBe(201);
    const rec = (await adminA.api.call('get', recPath('change_control', prop.body.items[0].record_id))).body as { id: string; version: number };
    await approveFlex(teamOf(site), rec.id, rec.version);
    expect(await noticesOf(site.id)).toHaveLength(0);
    const draft = await adminA.api.call('post', `/sites/${site.id}/change-proposals`, { identity: { region_id: TO }, reason: 'proposed, not decided' });
    expect(draft.status).toBe(201);
    expect(await noticesOf(site.id)).toHaveLength(0);
    expect((await q<{ region_id: number }>(db, 'SELECT region_id FROM sites WHERE id = $1', [site.id]))[0]!.region_id).toBe(R);
  });

  it('the application role cannot call the helpers that send the notice', async () => {
    const app2 = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_SS });
    await app2.connect();
    try {
      await expect(app2.query(`SELECT ss_notify_region_move(gen_random_uuid(), 5, 6, gen_random_uuid())`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`SELECT ss_holds_reassign(gen_random_uuid(), 5)`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
  });
});
