import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbDate, q } from './calc-helpers';
import { Api, delegate, startApp } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0145 (contract 0.15.61): the settings routes the web called that no controller served: DLP versions, the idle-task alert, the notification
 * policy and its catalogue, and the holidays import (TPL-HOLIDAYS). The suite runs in its own database (TEST_DATABASE_URL_SSA): it publishes DLP versions,
 * changes the policy and the idle limit and adds holidays, which recalculates open tasks.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;        // a System Admin with step-up
let adminNoStep: Actor;  // a System Admin without step-up
let plain: Actor;        // a user with the Sites module only
let delegateAll: Actor;  // a delegate of admin.settings and calendars edit for all regions (with step-up)
let delegateReg: Actor;  // the same rights for one region only

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_SSA as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_SSA });
  await db.connect();
  admin = await plainAdmin(app, db);
  adminNoStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  delegateAll = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, delegateAll.user.id, [['admin.settings', 'edit'], ['calendars', 'edit']]);
  delegateReg = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, delegateReg.user.id, [['admin.settings', 'edit'], ['calendars', 'edit']], [5]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
let mark = 0;
beforeEach(async () => {
  mark = Number((await q<{ m: string }>(db, 'SELECT coalesce(max(id), 0) AS m FROM audit_log'))[0]!.m);
});
const audit = (action: string) =>
  q<{ entity_id: string; before: any; after: any; reason: string; actor_id: string }>(db, 'SELECT entity_id, before, after, reason, actor_id FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id', [action, mark]);
const codes = (res: { body: any }): string[] => (res.body.errors ?? []).map((e: { path: string; code: string }) => `${e.path}:${e.code}`);
const today = (): Promise<string> => dbDate(db, 'cal_today()');

// =====================================================================================================================
// DLP versions
// =====================================================================================================================
describe('DLP versions (dlp.months.cw / dlp.months.te)', () => {
  const post = (who: Actor, body: unknown) => who.api.call('post', '/settings/dlp/versions', body);

  it('every signed-in user reads the seed: CW 3, TE 12, version 1 in force; nobody signed in gets 401', async () => {
    const res = await plain.api.call('get', '/settings/dlp');
    expect(res.status).toBe(200);
    expect(res.body.current).toMatchObject({ version: 1, cw_months: 3, te_months: 12 });
    expect(res.body.history.map((h: { version: number }) => h.version)).toEqual([1]);
    expect((await new Api(app).raw('get', '/settings/dlp')).status).toBe(401);
  });

  it('refuses a plain user, a region-limited delegate and an admin without step-up', async () => {
    const body = { cw_months: 4, te_months: 12, effective_from: await today(), reason: 'Owner decision' };
    expect((await post(plain, body)).status).toBe(403);
    expect((await post(delegateReg, body)).status).toBe(403);
    const ns = await post(adminNoStep, body);
    expect(ns.status).toBe(401);
    expect(ns.body.code).toBe('step_up_required');
    expect((await q(db, 'SELECT 1 FROM dlp_versions WHERE version > 1'))).toHaveLength(0);
  });

  it('validates: unknown keys, ranges, the reason, a date in the past or before the latest version', async () => {
    const t = await today();
    const bad = await post(admin, { cw_months: 121, te_months: -1, effective_from: t, reason: 'x', months: 5 });
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/reason:required']);                                             // the reason is checked first
    const bad2 = await post(admin, { cw_months: 121, te_months: 1.5, effective_from: '2026-02-30', reason: 'Owner decision', months: 5 });
    expect(bad2.status).toBe(422);
    expect(codes(bad2).sort()).toEqual(['/cw_months:out_of_range', '/effective_from:invalid', '/months:unknown_key', '/te_months:invalid']);
    const past = await post(admin, { cw_months: 3, te_months: 12, effective_from: await dbDate(db, 'cal_today() - 1'), reason: 'Back-dated' });
    expect(past.status).toBe(422);
    expect(codes(past)).toEqual(['/effective_from:in_the_past']);
  });

  it('publishes a version in force today: audited with before and after, the setting rows and calc_setting follow, a PAC keeps the value of its date', async () => {
    const t = await today();
    // a TE PAC approved last year, and its TE FAC (D18) whose SLA starts at the PAC date + the TE DLP months
    const site = await makeSite(db, 5, { prefix: 'DLP' });
    const pacDate = await dbDate(db, `cal_today() - 400`);
    const pac = await makeTask(db, site, 'D16', 'approved', { actualDate: pacDate });
    const fac = await makeTask(db, site, 'D18', 'locked');
    const before = await dbDate(db, `sla_resolve_start('${fac}'::uuid, 'DLP:D16:dlp.months.te')`);
    expect(before).toBe(await dbDate(db, `(DATE '${pacDate}' + interval '12 months')::date`));

    const res = await post(delegateAll, { cw_months: 4, te_months: 6, effective_from: t, reason: 'Owner decision on the DLP' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 2, cw_months: 4, te_months: 6, effective_from: t, reason: 'Owner decision on the DLP', changed_by: { id: delegateAll.user.id } });
    const rows = await audit('dlp_version_publish');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: 'dlp', actor_id: delegateAll.user.id, before: { version: 1, cw_months: 3, te_months: 12 }, after: { version: 2, cw_months: 4, te_months: 6 } });
    expect((await q<{ v: unknown }>(db, `SELECT calc_setting('dlp.months.te', 'null') AS v`))[0]!.v).toBe(6);
    expect((await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'dlp.months.cw'`))[0]!.value).toBe(4);
    // the PAC of last year keeps 12 months; a PAC of today gets the new 6
    expect(await dbDate(db, `sla_resolve_start('${fac}'::uuid, 'DLP:D16:dlp.months.te')`)).toBe(before);
    await db.query('UPDATE task_instances SET actual_date = cal_today() WHERE id = $1', [pac]);
    expect(await dbDate(db, `sla_resolve_start('${fac}'::uuid, 'DLP:D16:dlp.months.te')`)).toBe(await dbDate(db, `(cal_today() + interval '6 months')::date`));

    const got = await plain.api.call('get', '/settings/dlp');
    expect(got.body.current).toMatchObject({ version: 2, te_months: 6 });
    expect(got.body.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
  });

  it('a future version is listed but not in force until its date; a version cannot go before the latest one', async () => {
    const future = await dbDate(db, 'cal_today() + 30');
    const res = await post(admin, { cw_months: 5, te_months: 9, effective_from: future, reason: 'Next quarter' });
    expect(res.status).toBe(201);
    const got = await plain.api.call('get', '/settings/dlp');
    expect(got.body.current.version).toBe(2);
    expect(got.body.history[0]).toMatchObject({ version: 3, effective_from: future });
    expect((await q<{ v: unknown }>(db, `SELECT calc_setting('dlp.months.te', 'null') AS v`))[0]!.v).toBe(6);
    expect((await q<{ m: number }>(db, `SELECT dlp_months_at('dlp.months.te', cal_today() + 31) AS m`))[0]!.m).toBe(9);
    const early = await post(admin, { cw_months: 5, te_months: 9, effective_from: await dbDate(db, 'cal_today() + 10'), reason: 'Earlier than the latest' });
    expect(early.status).toBe(422);
    expect(codes(early)).toEqual(['/effective_from:before_latest_version']);
  });
});

// =====================================================================================================================
// Idle-task alert (shares dashboard.settings.stale_idle_days)
// =====================================================================================================================
describe('idle-task alert', () => {
  const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/idle-task-alert', body, tag === undefined ? {} : { 'If-Match': tag });

  it('every signed-in user reads it: on, 2 working days by default, with an ETag', async () => {
    const res = await plain.api.call('get', '/settings/idle-task-alert');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, working_days: 2 });
    expect(etag(res)).toBe(`"${res.body.version}"`);
  });

  it('refuses a plain user and a region delegate; needs If-Match; refuses unknown keys and out-of-range days', async () => {
    const cur = await admin.api.call('get', '/settings/idle-task-alert');
    expect((await put(plain, { enabled: true, working_days: 3, reason: 'Try it' }, etag(cur))).status).toBe(403);
    expect((await put(delegateReg, { enabled: true, working_days: 3, reason: 'Try it' }, etag(cur))).status).toBe(403);
    expect((await put(admin, { enabled: true, working_days: 3, reason: 'No ETag' })).status).toBe(428);
    const bad = await put(admin, { enabled: 'yes', working_days: 31, reason: 'Bad values', days: 3 }, etag(cur));
    expect(bad.status).toBe(422);
    expect(codes(bad).sort()).toEqual(['/days:unknown_key', '/enabled:required', '/working_days:out_of_range']);
    expect((await put(admin, { enabled: true, working_days: 3 }, etag(cur))).status).toBe(422);  // no reason
  });

  it('saves the days into the dashboard idle limit (one setting), audited; a dashboard save moves the ETag too', async () => {
    const cur = await admin.api.call('get', '/settings/idle-task-alert');
    const res = await put(delegateAll, { enabled: false, working_days: 4, reason: 'Leads asked for four days' }, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, working_days: 4, updated_by: { id: delegateAll.user.id } });
    expect(etag(res)).not.toBe(etag(cur));
    expect((await q<{ n: number }>(db, 'SELECT task_stale_idle_days() AS n'))[0]!.n).toBe(4);
    const dash = await admin.api.call('get', '/settings/dashboard');
    expect(dash.body.stale_idle_days).toBe(4);
    const rows = await audit('idle_task_alert_update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: 'tasks.idle_alert', reason: 'Leads asked for four days', before: { enabled: true, working_days: 2 }, after: { enabled: false, working_days: 4 } });
    // the dashboard screen changes the same limit: the idle-alert ETag moves, so a stale save is refused
    const dashPut = await admin.api.call('put', '/settings/dashboard', {
      reason: 'Dashboard limit', targets: dash.body.targets, thresholds: dash.body.thresholds, tabs: dash.body.tabs, stale_idle_days: 5,
    }, { 'If-Match': etag(dash) });
    expect(dashPut.status).toBe(200);
    const again = await admin.api.call('get', '/settings/idle-task-alert');
    expect(again.body.working_days).toBe(5);
    const stale = await put(admin, { enabled: true, working_days: 2, reason: 'Stale' }, etag(res));
    expect(stale.status).toBe(412);
    expect((await put(admin, { enabled: true, working_days: 2, reason: 'Back to the default' }, etag(again))).status).toBe(200);
  });
});

// =====================================================================================================================
// Notification policy
// =====================================================================================================================
describe('notification policy', () => {
  const get = (who: Actor) => who.api.call('get', '/settings/notification-policy');
  const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/notification-policy', body, tag === undefined ? {} : { 'If-Match': tag });
  const sa = async (): Promise<string> => (await q<{ id: string }>(db, 'SELECT notif_admins_group()::text AS id'))[0]!.id;
  // the body the screen sends back: the policy as read, the read-only fields dropped
  const bodyOf = (p: any, reason: string, over: Record<string, unknown> = {}) => ({
    reason, enabled: p.enabled, timezone: p.timezone, digest_hour: p.digest_hour, work_days_follow_calendar: p.work_days_follow_calendar,
    thresholds: { ...p.thresholds }, columns: p.columns.map((c: any) => ({ kind: c.kind, id: c.id })),
    matrix: p.matrix.map((r: any) => ({ type_code: r.type_code, channels: { ...r.channels }, cells: r.cells.map((c: any) => ({ ...c })) })), ...over,
  });
  const row = (b: any, code: string) => b.matrix.find((r: any) => r.type_code === code);

  it('the catalogue and the policy need admin.settings: a plain user and an anonymous caller are refused', async () => {
    expect((await plain.api.call('get', '/settings/notification-policy/catalogue')).status).toBe(403);
    expect((await get(plain)).status).toBe(403);
    expect((await new Api(app).raw('get', '/settings/notification-policy')).status).toBe(401);
    const cat = await delegateReg.api.call('get', '/settings/notification-policy/catalogue');
    expect(cat.status).toBe(200);                                                               // reading: a delegate of any region
    expect(cat.body.items).toHaveLength(25);
    const sec = cat.body.items.filter((t: any) => t.category === 'security');
    expect(sec.every((t: any) => t.mandatory && t.system_admins_only && t.default_channels.email && t.immediate)).toBe(true);
    expect(cat.body.items.find((t: any) => t.code === 'no_holder')).toMatchObject({ mandatory: true, immediate: true, default_recipients: ['system_admins'] });
  });

  it('reads the defaults: on, Africa/Tripoli, digest at 8, Sunday to Thursday from the calendar, one row per type', async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, timezone: 'Africa/Tripoli', digest_hour: 8, work_days_follow_calendar: true, work_days: [0, 1, 2, 3, 4],
      thresholds: { approval_remind_hours: 48, approval_escalate_days: 5, sla_warning_days_before_max: 2, rate_cap_per_hour: 50, retention_days: 180 } });
    expect(res.body.matrix).toHaveLength(25);
    expect(res.body.columns.map((c: any) => c.id)).toContain(await sa());
    expect(row(res.body, 'audit_integrity_failure').cells).toEqual([{ kind: 'group', id: await sa(), on: true }]);   // System Admins only
    expect(etag(res)).toBe(`"${res.body.version}"`);
  });

  it('rejects unknown keys at every level, with field errors', async () => {
    const p = (await get(admin)).body;
    const b: any = bodyOf(p, 'Unknown keys', { colour: 'red' });
    b.thresholds.reminder_minutes = 5;
    b.matrix[0].priority = 'high';
    b.matrix[0].channels.sms = true;
    b.matrix[0].cells[0].weight = 1;
    const res = await put(admin, b, etag(await get(admin)));
    expect(res.status).toBe(422);
    expect(codes(res).sort()).toEqual(['/colour:unknown_key', '/matrix/0/cells/0/weight:unknown_key', '/matrix/0/channels/sms:unknown_key', '/matrix/0/priority:unknown_key',
      '/thresholds/reminder_minutes:unknown_key']);
  });

  it('checks the ranges, the timezone, the escalation after the reminder (both paths), the work days', async () => {
    const p = (await get(admin)).body;
    const res = await put(admin, bodyOf(p, 'Bad values', { timezone: 'Mars/Olympus', digest_hour: 24, work_days_follow_calendar: false,
      thresholds: { ...p.thresholds, approval_remind_hours: 120, approval_escalate_days: 5, retention_days: 10 } }), etag(await get(admin)));
    expect(res.status).toBe(422);
    expect(codes(res).sort()).toEqual(['/digest_hour:out_of_range', '/thresholds/approval_escalate_days:must_exceed_remind_hours',
      '/thresholds/approval_remind_hours:must_exceed_remind_hours', '/thresholds/retention_days:out_of_range', '/timezone:invalid_timezone', '/work_days:required']);
  });

  it('locks mandatory types and keeps System-Admin-only types to the System Admins', async () => {
    const p = (await get(admin)).body;
    const b: any = bodyOf(p, 'Try to switch off');
    const i = b.matrix.findIndex((r: any) => r.type_code === 'audit_integrity_failure');
    b.matrix[i].channels.email = false;
    const nh = b.matrix.findIndex((r: any) => r.type_code === 'no_holder');
    const sacell = b.matrix[nh].cells.findIndex((c: any) => c.id === p.columns.find((c2: any) => c2.kind === 'group').id);
    b.matrix[nh].cells[sacell].on = false;
    const pm = p.columns.find((c: any) => c.kind === 'role');
    const rr = b.matrix.findIndex((r: any) => r.type_code === 'retention_reduced');
    b.matrix[rr].cells.push({ kind: 'role', id: pm.id, on: true });
    b.matrix.push({ type_code: 'not_a_type', channels: { in_app: true, email: false }, cells: [] });
    const res = await put(admin, b, etag(await get(admin)));
    expect(res.status).toBe(422);
    expect(codes(res).sort()).toEqual([`/matrix/${i}/channels/email:mandatory_locked`, `/matrix/${nh}/cells/${sacell}:mandatory_locked`,
      `/matrix/${rr}/cells/1:not_eligible_recipient`, `/matrix/${b.matrix.length - 1}/type_code:unknown_type`].sort());
  });

  it('a delegate saves ordinary changes; rows left out return to the defaults; versioned and audited', async () => {
    const cur = await get(admin);
    const b: any = bodyOf(cur.body, 'Mail the returns');
    const tr = row(b, 'task_rejected');
    tr.channels.email = true;
    b.matrix = b.matrix.filter((r: any) => r.type_code !== 'sla_near_max');
    const res = await put(delegateAll, b, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ digest_hour: 8, version: cur.body.version + 1, updated_by: { id: delegateAll.user.id } });
    expect(row(res.body, 'task_rejected').channels).toEqual({ in_app: true, email: true });
    expect(row(res.body, 'sla_near_max').channels).toEqual({ in_app: true, email: false });   // catalogue default
    const rows = await audit('notification_policy_update');
    expect(rows).toHaveLength(1);
    expect(row(rows[0]!.before, 'task_rejected').channels.email).toBe(false);
    expect(row(rows[0]!.after, 'task_rejected').channels.email).toBe(true);
    expect(rows[0]!.after).toMatchObject({ protected_change: false });
    expect(rows[0]!.reason).toBe('Mail the returns');
    expect((await put(admin, b, etag(cur))).status).toBe(412);                                       // the old ETag
    expect((await put(admin, b)).status).toBe(428);
  });

  it('a security or system row, or the rate cap: a delegate is refused, an admin needs a step-up, the System Admins are told', async () => {
    const cur = await get(admin);
    const b: any = bodyOf(cur.body, 'Raise the rate cap', { thresholds: { ...cur.body.thresholds, rate_cap_per_hour: 80 } });
    const del = await put(delegateAll, b, etag(cur));
    expect(del.status).toBe(403);
    expect(del.body.code).toBe('delegate_forbidden');
    const ns = await put(adminNoStep, b, etag(cur));
    expect(ns.status).toBe(401);
    expect(ns.body.code).toBe('step_up_required');
    const before = Number((await q<{ n: string }>(db, `SELECT count(*) AS n FROM notifications WHERE kind = 'security_alert' AND title LIKE 'Notification policy%'`))[0]!.n);
    const ok = await put(admin, b, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body.thresholds.rate_cap_per_hour).toBe(80);
    const after = await q<{ user_id: string; body: string }>(db, `SELECT user_id::text, body FROM notifications WHERE kind = 'security_alert' AND title LIKE 'Notification policy%' ORDER BY created_at`);
    expect(after.length).toBeGreaterThan(before);
    expect(after.map((n) => n.user_id)).toContain(admin.user.id);
    expect(after.at(-1)!.body).toContain(admin.user.name);
    // a system row (switch off the e-mail of the holiday reminder): also sensitive
    const cur2 = await get(admin);
    const b2: any = bodyOf(cur2.body, 'No reminder mail');
    row(b2, 'holiday_tentative_reminder').channels.in_app = false;
    expect((await put(delegateAll, b2, etag(cur2))).status).toBe(403);
    const ok2 = await put(admin, b2, etag(cur2));
    expect(ok2.status).toBe(200);
    expect((await audit('notification_policy_update')).at(-1)!.after.protected_change).toBe(true);
  });

  // security review 2026-11-23: a delegate must not silence or reshape the policy
  for (const [what, over] of [
    ['the switch off', (p: any) => ({ enabled: !p.enabled })],
    ['the timezone', () => ({ timezone: 'Africa/Cairo' })],
    ['the digest hour', (p: any) => ({ digest_hour: (p.digest_hour + 1) % 24 })],
    ['the working days', () => ({ work_days_follow_calendar: false, work_days: [0, 1, 2, 3] })],
  ] as [string, (p: any) => Record<string, unknown>][]) {
    it(`${what}: a delegate is refused, an admin without step-up is asked for one, an admin with step-up saves it`, async () => {
      const cur = await get(admin);
      const b = bodyOf(cur.body, `Change ${what}`, over(cur.body));
      const del = await put(delegateAll, b, etag(cur));
      expect(del.status).toBe(403);
      expect(del.body.code).toBe('delegate_forbidden');
      expect((await put(adminNoStep, b, etag(cur))).body.code).toBe('step_up_required');
      const ok = await put(admin, b, etag(cur));
      expect(ok.status).toBe(200);
      expect((await audit('notification_policy_update')).at(-1)!.after.protected_change).toBe(true);
      // back to the defaults for the next case
      const back = await put(admin, bodyOf(ok.body, 'Back', { enabled: true, timezone: 'Africa/Tripoli', digest_hour: 8, work_days_follow_calendar: true }), etag(ok));
      expect(back.status).toBe(200);
    });
  }

  it('the System Admins column cannot be removed, and a mandatory type cannot be left without it (even when the body omits the cell)', async () => {
    const cur = await get(admin);
    const saId = await sa();
    const noSa = bodyOf(cur.body, 'Drop the System Admins', {
      columns: cur.body.columns.filter((c: any) => c.id !== saId).map((c: any) => ({ kind: c.kind, id: c.id })),
      matrix: cur.body.matrix.map((r: any) => ({ type_code: r.type_code, channels: { ...r.channels }, cells: r.cells.filter((c: any) => c.id !== saId) })),
    });
    for (const who of [delegateAll, admin]) {
      const res = await put(who, noSa, etag(cur));
      expect(res.status).toBe(422);
      expect(codes(res)).toContain('/columns:mandatory_locked');
    }
    // the cell named off for a mandatory type: refused for the System Admin with a step-up as well
    const off: any = bodyOf(cur.body, 'No holder silenced');
    const nh = off.matrix.findIndex((r: any) => r.type_code === 'no_holder');
    const j = off.matrix[nh].cells.findIndex((c: any) => c.id === saId);
    off.matrix[nh].cells[j].on = false;
    const r2 = await put(admin, off, etag(cur));
    expect(r2.status).toBe(422);
    expect(codes(r2)).toEqual([`/matrix/${nh}/cells/${j}:mandatory_locked`]);
    // leaving the cell out keeps it on (the default)
    const omit: any = bodyOf(cur.body, 'Cell left out');
    omit.matrix[nh].cells = omit.matrix[nh].cells.filter((c: any) => c.id !== saId);
    const r3 = await put(delegateAll, omit, etag(cur));
    expect(r3.status).toBe(200);
    expect(row(r3.body, 'no_holder').cells).toContainEqual({ kind: 'group', id: saId, on: true });
  });
});

// =====================================================================================================================
// Holidays import (TPL-HOLIDAYS)
// =====================================================================================================================
describe('holidays import from the approved template', () => {
  const download = async (who: Actor): Promise<Buffer> => {
    const res = await who.api.call('get', '/templates/TPL-HOLIDAYS/download').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    return res.body as Buffer;
  };
  const fill = async (tpl: Buffer, rows: string[][], tamper?: (wb: ExcelJS.Workbook) => void): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl as unknown as ExcelJS.Buffer);
    const data = wb.getWorksheet('Data')!;
    rows.forEach((r, i) => r.forEach((v, j) => { data.getRow(i + 2).getCell(j + 1).value = v; }));
    tamper?.(wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const upload = (who: Actor, file: Buffer, reason: string | null = 'Official calendar for the coming year', name = 'holidays.xlsx') => {
    const t = who.api.call('post', '/settings/holidays/import').attach('file', file, name);
    return reason === null ? t : t.field('reason', reason);
  };
  const holidays = (dates: string[]) => q<{ date: string; name: string; kind: string; tentative: boolean; note: string | null }>(db,
    'SELECT date::text, name, kind, tentative, note FROM holidays WHERE date = ANY($1::date[]) ORDER BY date', [dates]);
  let tpl: Buffer;
  // dates far ahead that the seed does not hold
  const D1 = '2033-02-17', D2 = '2033-03-20', D3 = '2033-12-24';

  beforeAll(async () => {
    tpl = await download(admin);
  });

  it('the template is listed and downloadable only for those who may change the calendar', async () => {
    const list = await admin.api.call('get', '/templates');
    expect(list.body.items.find((t: any) => t.template_id === 'TPL-HOLIDAYS')).toMatchObject({ template_kind: 'holidays', current_version: 1 });
    const pl = await plain.api.call('get', '/templates');
    expect(pl.body.items.find((t: any) => t.template_id === 'TPL-HOLIDAYS')).toBeUndefined();
    expect((await plain.api.call('get', '/templates/TPL-HOLIDAYS/download')).status).toBe(403);
  });

  it('refuses a plain user, a region delegate, a missing reason and a missing file', async () => {
    const f = await fill(tpl, [[D1, 'Revolution Day', 'ذكرى الثورة', 'national', 'no', '']]);
    expect((await upload(plain, f)).status).toBe(403);
    expect((await upload(delegateReg, f)).status).toBe(403);
    const nr = await upload(admin, f, null);
    expect(nr.status).toBe(422);
    expect(codes(nr)[0]).toMatch(/^\/:|reason/);
    const nf = await admin.api.call('post', '/settings/holidays/import').field('reason', 'No file at all');
    expect(nf.status).toBe(422);
    expect(await holidays([D1])).toHaveLength(0);
  });

  it('refuses a file that is not the approved template (a CSV, another template, an older version, a changed header) and logs it', async () => {
    const csv = Buffer.from('date,name_en,name_ar,kind,tentative,note\n2033-02-17,Revolution Day,,national,no,\n');
    const c = await upload(admin, csv, 'A CSV file', 'holidays.csv');
    expect(c.status).toBe(422);
    expect(c.body).toMatchObject({ code: 'template_rejected', reason: 'not_xlsx' });
    const other = await fill(tpl, [[D1, 'Revolution Day', '', 'national', 'no', '']], (wb) => { wb.getWorksheet('_tpl')!.eachRow((r) => { if (r.getCell(1).text === 'template_id') r.getCell(2).value = 'TPL-LISTVALUES'; }); });
    expect((await upload(admin, other)).body).toMatchObject({ code: 'template_rejected', reason: 'wrong_template' });
    const old = await fill(tpl, [[D1, 'Revolution Day', '', 'national', 'no', '']], (wb) => { wb.getWorksheet('_tpl')!.eachRow((r) => { if (r.getCell(1).text === 'version') r.getCell(2).value = '99'; }); });
    expect((await upload(admin, old)).body).toMatchObject({ code: 'template_rejected', reason: 'outdated_version' });
    const head = await fill(tpl, [[D1, 'Revolution Day', '', 'national', 'no', '']], (wb) => { wb.getWorksheet('Data')!.getRow(1).getCell(2).value = 'Holiday'; });
    expect((await upload(admin, head)).body).toMatchObject({ code: 'template_rejected', reason: 'checksum_mismatch' });
    const logged = await q<{ message: string }>(db, `SELECT message FROM system_log WHERE source = 'holidays-import' AND message LIKE 'holidays import rejected:%'`);
    expect(logged.map((l) => l.message)).toEqual(expect.arrayContaining(['holidays import rejected: not_xlsx', 'holidays import rejected: wrong_template',
      'holidays import rejected: outdated_version', 'holidays import rejected: checksum_mismatch']));
    expect(await holidays([D1])).toHaveLength(0);
  });

  it('one bad row refuses the whole file, with field errors per line', async () => {
    const f = await fill(tpl, [
      [D1, 'Revolution Day', '', 'national', 'no', ''],
      ['2033-02-30', 'Bad date', '', 'national', 'no', ''],
      [D2, 'X', '', 'festival', 'maybe', ''],
      [D1, 'Twice', '', 'national', 'no', ''],
    ]);
    const res = await upload(admin, f);
    expect(res.status).toBe(422);
    expect(codes(res).sort()).toEqual(['/rows/3/date:invalid', '/rows/4/kind:invalid', '/rows/4/name_en:required', '/rows/4/tentative:invalid', '/rows/5/date:duplicate_in_file']);
    expect(await holidays([D1, D2])).toHaveLength(0);
  });

  it('imports the rows at once: audited per holiday and for the file, the open tasks are recalculated, closed tasks keep their values', async () => {
    // an open task whose SLA period covers the next working day, and an approved task with a due date there
    const site = await makeSite(db, 5, { prefix: 'HOL' });
    const openId = await makeTask(db, site, 'A2', 'open');
    const o0 = (await q<{ start: string; due: string; max: number }>(db, `SELECT ti.sla_start_date::text AS start, ti.due_date::text AS due, r.max_working_days AS max
      FROM task_instances ti JOIN sla_rules r ON r.id = ti.sla_rule_id WHERE ti.id = $1`, [openId]))[0]!;
    expect(o0.due).toBeTruthy();
    const day = await dbDate(db, `cal_add_workdays(DATE '${o0.start}', 1)`);
    expect(day <= o0.due).toBe(true);
    const closedId = await makeTask(db, site, 'A4', 'approved', { actualDate: o0.start, dueDate: o0.due });
    const closedDue = (await q<{ d: string }>(db, 'SELECT due_date::text AS d FROM task_instances WHERE id = $1', [closedId]))[0]!.d;

    const f = await fill(tpl, [
      [day, 'Synthetic holiday', 'عطلة تجريبية', 'national', 'no', 'test row'],
      [D2, 'Eid al-Fitr (day 1)', 'عيد الفطر', 'Religious', 'yes', 'confirm on the announcement'],
    ]);
    const res = await upload(admin, f, 'Official calendar 2033');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ template_id: 'TPL-HOLIDAYS', template_version: 1, status: 'applied', counts: { create: 2, update: 0, unchanged: 0, error: 0 } });
    expect(res.body.affected_open_tasks).toBeGreaterThanOrEqual(1);
    expect(await holidays([day, D2])).toEqual([
      { date: day, name: 'Synthetic holiday', kind: 'national', tentative: false, note: 'test row' },
      { date: D2, name: 'Eid al-Fitr (day 1)', kind: 'religious', tentative: true, note: 'confirm on the announcement' },
    ]);
    const o1 = (await q<{ due: string }>(db, 'SELECT due_date::text AS due FROM task_instances WHERE id = $1', [openId]))[0]!;
    expect(o1.due).toBe(await dbDate(db, `cal_add_workdays(DATE '${o0.start}', ${o0.max})`));
    expect(o1.due > o0.due).toBe(true);                                                              // one working day later
    expect((await q<{ d: string }>(db, 'SELECT due_date::text AS d FROM task_instances WHERE id = $1', [closedId]))[0]!.d).toBe(closedDue);
    const per = await audit('holiday_create');
    expect(per).toHaveLength(2);
    expect(per[0]).toMatchObject({ reason: 'Official calendar 2033', actor_id: admin.user.id, before: null, after: { import_id: res.body.id, template_id: 'TPL-HOLIDAYS' } });
    const sum = await audit('holidays_import');
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ entity_id: res.body.id, after: { created: 2, unchanged: 0, template_version: 1, file_name: 'holidays.xlsx' } });
  });

  it('the same file again changes nothing; another holiday on a date already held is refused', async () => {
    const same = await fill(tpl, [[D2, 'Eid al-Fitr (day 1)', 'عيد الفطر', 'religious', 'yes', '']]);
    const res = await upload(delegateAll, same, 'Again');
    expect(res.status).toBe(202);
    expect(res.body.counts).toMatchObject({ create: 0, unchanged: 1 });
    const other = await fill(tpl, [[D2, 'Another name', '', 'national', 'no', ''], [D3, 'Christmas', '', 'national', 'no', '']]);
    const bad = await upload(admin, other);
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/rows/2/date:duplicate']);
    expect(await holidays([D3])).toHaveLength(0);
  });

  it('an idempotency key replays the first answer', async () => {
    const f = await fill(tpl, [[D3, 'Christmas', '', 'national', 'no', '']]);
    const a = await upload(admin, f, 'Once').set('Idempotency-Key', 'holiday-import-key-1');
    const b = await upload(admin, f, 'Once').set('Idempotency-Key', 'holiday-import-key-1');
    expect(a.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
    expect(await holidays([D3])).toHaveLength(1);
  });
});
