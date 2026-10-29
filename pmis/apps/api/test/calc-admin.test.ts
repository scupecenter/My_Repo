import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbDate, newSite, q, taskRow, wd } from './calc-helpers';
import { Api, delegate, startApp, superDbCalc } from './helpers';
import { Actor, actor, makeTask, plainAdmin } from './wf-helpers';
import type { Site } from './wf-helpers';

/**
 * Migration 0017, part 7: the audited admin functions behind /settings/holidays, /settings/weekend-days and /settings/sla-rule-sets, and
 * their effect on the SLA of open and closed tasks. These tests change the shared calendar and the SLA versions, so the whole file runs in
 * its own database (TEST_DATABASE_URL_CALC, see global-setup) and in one order: later tests build on the earlier ones.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_CALC as string });
  db = await superDbCalc();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const REASON = 'official announcement of the Ministry';

/** A D1 task that is open since `startOffset` working days ago (MS4 approved on that day). */
async function openD1(startOffset: number, region = 5): Promise<{ site: Site; start: string }> {
  const site = await newSite(db, region);
  const start = await wd(db, startOffset);
  await makeTask(db, site, 'MS4', 'approved', { actualDate: start });
  const d1 = await makeTask(db, site, 'D1', 'locked');
  await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1]);
  return { site, start };
}

describe('GET /settings/calendars and /settings/holidays', () => {
  it('needs a session', async () => {
    const anon = new Api(app);
    expect((await anon.raw('get', '/settings/holidays')).status).toBe(401);
    expect((await anon.raw('get', '/settings/calendars')).status).toBe(401);
  });

  it('lists the default calendar with Friday and Saturday as weekend, and the holidays of a year', async () => {
    const res = await plain.api.call('get', '/settings/calendars?year=2026');
    expect(res.status).toBe(200);
    const std = res.body.items.find((c: { code: string }) => c.code === 'std');
    expect(std).toMatchObject({ weekend_days: [5, 6], is_default: true });
    expect(std.holidays.length).toBeGreaterThan(5);
    expect(std.holidays.every((h: { date: string }) => h.date.startsWith('2026'))).toBe(true);
    expect(typeof std.holiday_table_empty).toBe('boolean');
    const bad = await plain.api.call('get', '/settings/calendars?year=1999');
    expect(bad.status).toBe(422);
  });

  it('lists holidays with the reminder summary and filters on tentative', async () => {
    const res = await plain.api.call('get', '/settings/holidays?year=2026');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ calendar_code: 'std', version: 1 });
    expect(res.body.items[0]).toHaveProperty('name_en');
    expect(res.body.summary).toHaveProperty('next_year_table_empty');
    const tent = await plain.api.call('get', '/settings/holidays?tentative=true');
    expect(tent.body.items.every((h: { tentative: boolean }) => h.tentative)).toBe(true);
    expect(tent.body.summary.tentative_count).toBe(tent.body.items.length);
  });
});

describe('holiday changes (permission, audit, optimistic locking)', () => {
  it('refuses everybody who is not a System Admin or a delegate (403)', async () => {
    const body = { reason: REASON, date: '2031-03-03', name_en: 'Test day', kind: 'national' };
    expect((await plain.api.call('post', '/settings/holidays', body)).status).toBe(403);
    const h = (await admin.api.call('post', '/settings/holidays', { ...body, date: '2031-03-04' })).body.holiday;
    expect((await plain.api.call('patch', `/settings/holidays/${h.id}`, { reason: REASON, name_en: 'Changed' }, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await plain.api.call('post', `/settings/holidays/${h.id}/confirm`, { reason: REASON }, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await plain.api.call('delete', `/settings/holidays/${h.id}?reason=${encodeURIComponent(REASON)}`, undefined, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await plain.api.call('put', '/settings/weekend-days', { reason: REASON, weekend_days: [5, 6] })).status).toBe(403);
    // the database refuses direct writes as well
    const c = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_CALC });
    await c.connect();
    await expect(c.query(`INSERT INTO holidays (calendar_id, date, name) SELECT id, '2031-05-05', 'x' FROM work_calendars WHERE is_default`)).rejects.toMatchObject({ code: '42501' });
    await c.end();
  });

  it('a delegate for settings in some regions only cannot change the calendar, which reaches every region', async () => {
    const e = await actor(app, db, { level: 'entry' });
    await delegate(db, e.user.id, [['calendars', 'edit']], [5]);
    const res = await e.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-03-05', name_en: 'Regional', kind: 'national' });
    expect(res.status).toBe(403);
    const all = await actor(app, db, { level: 'entry' });
    await delegate(db, all.user.id, [['calendars', 'edit']]);
    const ok = await all.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-03-05', name_en: 'All regions', kind: 'national' });
    expect(ok.status).toBe(201);
  });

  it('adds a holiday with a reason, audits it, and refuses a duplicate date and a bad body', async () => {
    const res = await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-04-04', name_en: 'Test day', name_ar: 'يوم اختبار', kind: 'religious', tentative: true });
    expect(res.status).toBe(201);
    expect(res.body.holiday).toMatchObject({ calendar_code: 'std', date: '2031-04-04', name_en: 'Test day', kind: 'religious', tentative: true, version: 1, confirmed_at: null });
    expect(res.body.affected_open_tasks).toBe(0);
    const audit = await q<{ reason: string; after: { date: string }; before: unknown; actor_id: string }>(
      db, `SELECT reason, after, before, actor_id FROM audit_log WHERE action = 'holiday_create' AND entity_id = $1`, [res.body.holiday.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: REASON, before: null, actor_id: admin.user.id });
    expect(audit[0]!.after.date).toBe('2031-04-04');
    const dup = await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-04-04', name_en: 'Again', kind: 'national' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
    expect((await admin.api.call('post', '/settings/holidays', { reason: 'x', date: '2031-04-05', name_en: 'Short reason', kind: 'national' })).status).toBe(422);
    expect((await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2040-01-01', name_en: 'Out of range', kind: 'national' })).status).toBe(422);
    expect((await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-04-06', name_en: 'Unknown field', kind: 'national', colour: 'red' })).status).toBe(422);
    expect((await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-04-06', name_en: 'Bad calendar', kind: 'national', calendar_code: 'nope' })).status).toBe(422);
  });

  it('edits with If-Match: 428 without, 412 when stale, new version and ETag when fresh', async () => {
    const h = (await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-06-06', name_en: 'To edit', kind: 'national' })).body.holiday;
    const body = { reason: REASON, name_en: 'Edited name' };
    expect((await admin.api.call('patch', `/settings/holidays/${h.id}`, body)).status).toBe(428);
    expect((await admin.api.call('patch', `/settings/holidays/${h.id}`, body, { 'If-Match': '"7"' })).status).toBe(412);
    expect((await admin.api.call('patch', `/settings/holidays/${h.id}`, { reason: REASON }, { 'If-Match': '"1"' })).status).toBe(422);   // nothing to change
    const ok = await admin.api.call('patch', `/settings/holidays/${h.id}`, body, { 'If-Match': `"${h.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.body.holiday).toMatchObject({ name_en: 'Edited name', version: 2 });
    const a = await q<{ before: { name: string }; after: { name: string } }>(db, `SELECT before, after FROM audit_log WHERE action = 'holiday_update' AND entity_id = $1`, [h.id]);
    expect(a[0]!.before.name).toBe('To edit');
    expect(a[0]!.after.name).toBe('Edited name');
    expect((await admin.api.call('patch', `/settings/holidays/${h.id}`, { reason: REASON, name_en: 'Again' }, { 'If-Match': `"${h.version}"` })).status).toBe(412);
    const missing = await admin.api.call('patch', '/settings/holidays/00000000-0000-4000-8000-000000000001', body, { 'If-Match': '"1"' });
    expect(missing.status).toBe(404);
  });

  it('confirms a tentative date on the announcement, moving it if the announced day differs', async () => {
    const h = (await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-07-07', name_en: 'Tentative feast', kind: 'religious', tentative: true })).body.holiday;
    const res = await admin.api.call('post', `/settings/holidays/${h.id}/confirm`, { reason: REASON, date: '2031-07-08' }, { 'If-Match': `"${h.version}"` });
    expect(res.status).toBe(200);
    expect(res.body.holiday).toMatchObject({ date: '2031-07-08', tentative: false });
    expect(res.body.holiday.confirmed_at).toBeTruthy();
    expect(res.body.holiday.confirmed_by).toMatchObject({ id: admin.user.id });
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'holiday_confirm' AND entity_id = $1`, [h.id])).toHaveLength(1);
  });

  it('deletes with step-up, a reason and If-Match', async () => {
    const h = (await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-08-08', name_en: 'To delete', kind: 'national' })).body.holiday;
    const reason = encodeURIComponent(REASON);
    // an admin whose session has not passed step-up
    expect((await noStep.api.call('delete', `/settings/holidays/${h.id}?reason=${reason}`, undefined, { 'If-Match': `"${h.version}"` })).status).toBe(401);
    expect((await admin.api.call('delete', `/settings/holidays/${h.id}`, undefined, { 'If-Match': `"${h.version}"` })).status).toBe(422);          // no reason
    expect((await admin.api.call('delete', `/settings/holidays/${h.id}?reason=${reason}`)).status).toBe(428);
    const ok = await admin.api.call('delete', `/settings/holidays/${h.id}?reason=${reason}`, undefined, { 'If-Match': `"${h.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.holiday.id).toBe(h.id);
    expect(await q(db, 'SELECT 1 FROM holidays WHERE id = $1', [h.id])).toHaveLength(0);
    const a = await q<{ before: { date: string }; after: unknown }>(db, `SELECT before, after FROM audit_log WHERE action = 'holiday_delete' AND entity_id = $1`, [h.id]);
    expect(a[0]!.before.date).toBe('2031-08-08');
    expect(a[0]!.after).toBeNull();
  });
});

describe('a holiday change recalculates the due dates of open tasks only', () => {
  it('moves the due date of a running task by one working day and leaves a closed task alone', async () => {
    const running = await openD1(0);                                          // D-1: due 5 working days after the start
    const closed = await openD1(-1);
    const doneOn = await wd(db, 2);                                            // not used for the future; close it today instead
    void doneOn;
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = cal_today(), approved_date = cal_today() WHERE id = (SELECT id FROM task_instances WHERE site_id = $1 AND sla_rule_id IS NOT NULL AND state = 'open')`, [closed.site.id]);
    const before = await taskRow(db, running.site, 'D1');
    const closedBefore = await taskRow(db, closed.site, 'D1');
    const expectedDue = await dbDate(db, `cal_add_workdays(DATE '${running.start}', 6)`);   // one working day later once a day in between is a holiday
    const holiday = await wd(db, 2);                                           // two working days from now: inside the period of both tasks
    const res = await admin.api.call('post', '/settings/holidays', { reason: REASON, date: holiday, name_en: 'Sudden holiday', kind: 'national' });
    expect(res.status).toBe(201);
    expect(res.body.affected_open_tasks).toBeGreaterThanOrEqual(1);
    const after = await taskRow(db, running.site, 'D1');
    expect(after.due_date).toBe(expectedDue);
    expect(after.due_date).not.toBe(before.due_date);
    expect(after.sla_start_date).toBe(before.sla_start_date);                  // the start and the version stay
    expect(after.sla_rule_id).toBe(before.sla_rule_id);
    const closedAfter = await taskRow(db, closed.site, 'D1');
    expect(closedAfter.due_date).toBe(closedBefore.due_date);                  // closed tasks keep their computed values
    expect(closedAfter.sla_elapsed_wd).toBe(closedBefore.sla_elapsed_wd);
    // taking the holiday away again brings the due date back
    const del = await admin.api.call('delete', `/settings/holidays/${res.body.holiday.id}?reason=${encodeURIComponent(REASON)}`, undefined, { 'If-Match': `"${res.body.holiday.version}"` });
    expect(del.status).toBe(200);
    expect(del.body.affected_open_tasks).toBeGreaterThanOrEqual(1);
    expect((await taskRow(db, running.site, 'D1')).due_date).toBe(before.due_date);
  });

  it('does not touch a task whose period the changed day does not reach', async () => {
    const t = await openD1(0);
    const before = await taskRow(db, t.site, 'D1');
    const res = await admin.api.call('post', '/settings/holidays', { reason: REASON, date: '2031-09-09', name_en: 'Far away', kind: 'national' });
    expect(res.status).toBe(201);
    expect((await taskRow(db, t.site, 'D1')).due_date).toBe(before.due_date);
  });

  it('weekend days: step-up, audit, and the due dates of open tasks follow (Friday only as weekend)', async () => {
    const t = await openD1(0);
    const before = await taskRow(db, t.site, 'D1');
    const body = { reason: REASON, weekend_days: [5] };
    expect((await noStep.api.call('put', '/settings/weekend-days', body)).status).toBe(401);
    expect((await admin.api.call('put', '/settings/weekend-days', { reason: REASON, weekend_days: [] })).status).toBe(422);
    expect((await admin.api.call('put', '/settings/weekend-days', { reason: REASON, weekend_days: [5, 5] })).status).toBe(422);
    expect((await admin.api.call('put', '/settings/weekend-days', { reason: REASON, weekend_days: [7] })).status).toBe(422);
    const res = await admin.api.call('put', '/settings/weekend-days', body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ calendar_code: 'std', weekend_days: [5] });
    expect(res.body.affected_open_tasks).toBeGreaterThanOrEqual(1);
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
    const during = await taskRow(db, t.site, 'D1');
    expect(during.due_date).not.toBe(before.due_date);
    const a = await q<{ before: { weekend_days: number[] }; after: { weekend_days: number[] } }>(db, `SELECT before, after FROM audit_log WHERE action = 'weekend_days_update' ORDER BY id DESC LIMIT 1`);
    expect(a[0]!.before.weekend_days).toEqual([5, 6]);
    expect(a[0]!.after.weekend_days).toEqual([5]);
    const back = await admin.api.call('put', '/settings/weekend-days', { reason: REASON, weekend_days: [5, 6] });
    expect(back.status).toBe(200);
    expect((await taskRow(db, t.site, 'D1')).due_date).toBe(before.due_date);
    expect((await admin.api.call('put', '/settings/weekend-days', { reason: REASON, weekend_days: [5, 6], calendar_code: 'nope' })).status).toBe(404);
  });
});

describe('SLA rule sets: versions, publishing and applying to open tasks', () => {
  const rule = (over: Record<string, unknown> = {}) => ({ task_code: 'D1', min_working_days: 4, max_working_days: 6, start_event: 'MS4', calendar_code: 'std', ...over });
  let draftId = '';
  let draftTag = '';
  let openBefore: { site: Site; start: string };
  let closedBefore: { site: Site; start: string };
  let region1: { site: Site; start: string };

  it('keeps the seeded rules as version 1 and shows them to a settings reader only', async () => {
    expect((await plain.api.call('get', '/settings/sla-rule-sets')).status).toBe(403);
    expect((await plain.api.call('post', '/settings/sla-rule-sets', { reason: REASON })).status).toBe(403);
    const res = await admin.api.call('get', '/settings/sla-rule-sets');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ version: 1, status: 'published', is_active: true, effective_from: '2024-01-01', rule_count: 46 });
    const v1 = await admin.api.call('get', `/settings/sla-rule-sets/${res.body.items[0].id}`);
    expect(v1.status).toBe(200);
    expect(v1.body.rules).toHaveLength(46);
    expect(v1.body.rules.find((r: { task_code: string }) => r.task_code === 'D1')).toEqual({
      task_code: 'D1', min_working_days: 3, max_working_days: 5, start_event: 'MS4', calendar_code: 'std', overrides: [],
    });
    expect(v1.body.rules.find((r: { task_code: string }) => r.task_code === 'B10')).toMatchObject({ min_working_days: 14, max_working_days: 21 });   // D5: one rule for B-10a and B-10b
    const list = await admin.api.call('get', '/settings/sla-rules?task_code=D1');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ task_code: 'D1', min_working_days: 3, max_working_days: 5, start_event: 'MS4', calendar_code: 'std', set_version: 1 });
  });

  it('creates one draft (a copy of the version in force), 409 for a second', async () => {
    openBefore = await openD1(0);                                              // opened under version 1
    closedBefore = await openD1(-1);
    region1 = { site: await newSite(db, 1), start: await wd(db, 0) };
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = cal_today(), approved_date = cal_today() WHERE site_id = $1 AND sla_rule_id IS NOT NULL AND state = 'open'`, [closedBefore.site.id]);
    const res = await admin.api.call('post', '/settings/sla-rule-sets', { reason: 'review of D-1 after the pilot' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 2, status: 'draft', base_version: 1, is_active: false, effective_from: null, apply_to_open_tasks: null, rule_count: 46 });
    expect(res.headers.etag).toBe('"1"');
    draftId = res.body.id;
    draftTag = res.headers.etag as string;
    const again = await admin.api.call('post', '/settings/sla-rule-sets', { reason: 'second draft' });
    expect(again.status).toBe(409);
  });

  it('refuses a draft equal to the version in force and a past date', async () => {
    const same = await admin.api.call('post', `/settings/sla-rule-sets/${draftId}/publish`, { effective_date: await dbDate(db, 'cal_today()'), reason: REASON, apply_to_open_tasks: false }, { 'If-Match': draftTag });
    expect(same.status).toBe(422);
    expect(same.body.errors.map((e: { code: string }) => e.code)).toContain('no_changes');
    const past = await admin.api.call('post', `/settings/sla-rule-sets/${draftId}/publish`, { effective_date: '2020-01-01', reason: REASON }, { 'If-Match': draftTag });
    expect(past.status).toBe(422);
    expect(past.body.errors.map((e: { code: string }) => e.code)).toContain('effective_date_in_past');
    expect((await noStep.api.call('post', `/settings/sla-rule-sets/${draftId}/publish`, { effective_date: await dbDate(db, 'cal_today()'), reason: REASON }, { 'If-Match': draftTag })).status).toBe(401);
  });

  it('validates the rules of the draft with a JSON pointer per error', async () => {
    const bad = await admin.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'try', rules: [
      rule({ min_working_days: 7, max_working_days: 6 }),
      rule({ task_code: 'NOPE' }),
      rule({ task_code: 'D2', start_event: 'XYZ' }),
      rule({ task_code: 'D3', calendar_code: 'ghost' }),
      rule({ task_code: 'D2' }),
      rule({ task_code: 'D4', overrides: [{ region_id: 1, min_working_days: 1, max_working_days: 2 }, { region_id: 1, min_working_days: 1, max_working_days: 3 }] }),
      rule({ task_code: 'D5', overrides: [{ scenario: 'hot_swap', min_working_days: 5, max_working_days: 2 }] }),
    ] }, { 'If-Match': draftTag });
    expect(bad.status).toBe(422);
    const codes = bad.body.errors.map((e: { code: string; path: string }) => `${e.code}@${e.path}`);
    expect(codes).toEqual(expect.arrayContaining([
      'min_exceeds_max@/rules/0/max_working_days', 'unknown_task_code@/rules/1/task_code', 'unknown_start_event@/rules/2/start_event',
      'unknown_calendar@/rules/3/calendar_code', 'duplicate_task_code@/rules/4/task_code', 'duplicate_override@/rules/5/overrides/1',
      'min_exceeds_max@/rules/6/overrides/0/max_working_days',
    ]));
    expect((await admin.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'try', rules: [rule()] })).status).toBe(428);
    expect((await admin.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'try', rules: [rule()] }, { 'If-Match': '"9"' })).status).toBe(412);
    expect((await admin.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'try', rules: [rule()], extra: 1 }, { 'If-Match': draftTag })).status).toBe(422);
    expect((await plain.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'try', rules: [rule()] }, { 'If-Match': draftTag })).status).toBe(403);
  });

  it('changes D-1 to 4 to 6 working days (2 to 3 in Tripoli) in the draft and previews the effect on open tasks', async () => {
    const patch = await admin.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'D-1 is tighter in Tripoli, looser elsewhere', rules: [
      rule({ overrides: [{ region_id: 1, min_working_days: 2, max_working_days: 3 }] }),
    ] }, { 'If-Match': draftTag });
    expect(patch.status).toBe(200);
    expect(patch.headers.etag).toBe('"2"');
    draftTag = patch.headers.etag as string;
    expect(patch.body.rules.find((r: { task_code: string }) => r.task_code === 'D1')).toMatchObject({
      min_working_days: 4, max_working_days: 6, overrides: [{ region_id: 1, min_working_days: 2, max_working_days: 3 }],
    });
    const audit = await q<{ before: { rules: unknown[] }; after: { rules: unknown[] } }>(db, `SELECT before, after FROM audit_log WHERE action = 'sla_rule_set_update' AND entity_id = $1`, [draftId]);
    expect(audit[0]!.before.rules).toEqual([{ task_code: 'D1', min: 3, max: 5, start: 'MS4' }]);
    const before = await taskRow(db, openBefore.site, 'D1');
    const pv = await admin.api.call('post', `/settings/sla-rule-sets/${draftId}/preview`, { effective_date: await dbDate(db, 'cal_today()') });
    expect(pv.status).toBe(200);
    expect(pv.body.changed_due_date_count).toBeGreaterThanOrEqual(1);
    expect(pv.body.open_tasks_total).toBeGreaterThanOrEqual(pv.body.changed_due_date_count);
    expect(pv.body.by_task.find((t: { task_code: string }) => t.task_code === 'D1')).toMatchObject({ changed: expect.any(Number) });
    expect(pv.body.samples.find((s: { task_id: string; due_date_before: string }) => s.due_date_before === before.due_date)).toBeTruthy();
    expect((await taskRow(db, openBefore.site, 'D1')).due_date).toBe(before.due_date);       // a preview changes nothing
    expect((await plain.api.call('post', `/settings/sla-rule-sets/${draftId}/preview`, { effective_date: '2031-01-01' })).status).toBe(403);
  });

  it('a regional delegate cannot apply a version to open tasks outside their regions', async () => {
    const d = await actor(app, db, { level: 'entry' });
    await delegate(db, d.user.id, [['sla_rules', 'edit']], [1]);
    await d.api.stepUp(d.user.password);
    const res = await d.api.call('post', `/settings/sla-rule-sets/${draftId}/publish`, { effective_date: await dbDate(db, 'cal_today()'), reason: REASON, apply_to_open_tasks: true }, { 'If-Match': draftTag });
    expect(res.status).toBe(403);
    expect((await admin.api.call('get', `/settings/sla-rule-sets/${draftId}`)).body.status).toBe('draft');
  });

  it('publishes from today: tasks opened later use it, open tasks keep their version unless it is applied', async () => {
    const today = await dbDate(db, 'cal_today()');
    const res = await admin.api.call('post', `/settings/sla-rule-sets/${draftId}/publish`, { effective_date: today, reason: 'approved by the Project Manager', apply_to_open_tasks: false },
      { 'If-Match': draftTag, 'Idempotency-Key': 'sla-publish-key-0001' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ affected_open_tasks: 0, recalculation_job_id: null });
    expect(res.body.rule_set).toMatchObject({ version: 2, status: 'published', is_active: true, effective_from: today, apply_to_open_tasks: false, affected_open_tasks: 0 });
    const replay = await admin.api.call('post', `/settings/sla-rule-sets/${draftId}/publish`, { effective_date: today, reason: 'approved by the Project Manager', apply_to_open_tasks: false },
      { 'If-Match': draftTag, 'Idempotency-Key': 'sla-publish-key-0001' });
    expect(replay.status).toBe(200);
    expect((await admin.api.call('get', '/settings/sla-rule-sets')).body.items.map((s: { version: number }) => s.version)).toEqual([2, 1]);
    // history: the old row is closed at the effective date, the new one starts on it
    const hist = await admin.api.call('get', `/settings/sla-rules?task_code=D1&include_history=true&active_on=${today}`);
    expect(hist.body.items).toHaveLength(2);                                   // the base rule and the Tripoli override
    expect(hist.body.items.find((r: { region_id: number | null }) => r.region_id === null)).toMatchObject({ min_working_days: 4, max_working_days: 6, effective_from: today, set_version: 2 });
    expect(hist.body.items.find((r: { region_id: number | null }) => r.region_id === 1)).toMatchObject({ min_working_days: 2, max_working_days: 3 });
    const old = await q<{ effective_to: string }>(db, `SELECT r.effective_to::text FROM sla_rules r JOIN task_definitions td ON td.id = r.task_def_id WHERE td.code = 'D1' AND r.min_working_days = 3`);
    expect(old[0]!.effective_to).toBe(today);
    // the task opened before keeps version 1
    const grid = async (site: Site) => (await admin.api.call('get', `/sites/${site.id}/tasks`)).body.stages.flatMap((s: { tasks: unknown[] }) => s.tasks).find((t: { task_code: string }) => t.task_code === 'D1');
    expect((await grid(openBefore.site)).sla).toMatchObject({ min_wd: 3, max_wd: 5, rule_set_version: 1 });
    // a task that opens now uses version 2, and the Tripoli override (2 to 3)
    const fresh = await openD1(0);
    expect((await grid(fresh.site)).sla).toMatchObject({ min_wd: 4, max_wd: 6, rule_set_version: 2 });
    const tripoli = await openD1(0, 1);
    expect((await grid(tripoli.site)).sla).toMatchObject({ min_wd: 2, max_wd: 3, rule_set_version: 2 });
    expect((await grid(tripoli.site)).sla.due_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${tripoli.start}', 3)`));
    // a published set can no longer be changed
    expect((await admin.api.call('patch', `/settings/sla-rule-sets/${draftId}`, { reason: 'late', rules: [rule()] }, { 'If-Match': '"3"' })).status).toBe(409);
  });

  it('applies a new version to the open tasks only when asked: due dates change, closed tasks keep their values', async () => {
    const closedBeforeRow = await taskRow(db, closedBefore.site, 'D1');
    const openBeforeRow = await taskRow(db, openBefore.site, 'D1');
    const tomorrow = await dbDate(db, 'cal_today() + 1');
    const d = await admin.api.call('post', '/settings/sla-rule-sets', { reason: 'D-1 once more' });
    expect(d.status).toBe(201);
    const p = await admin.api.call('patch', `/settings/sla-rule-sets/${d.body.id}`, { reason: 'D-1 once more', rules: [rule({ min_working_days: 6, max_working_days: 8 })] }, { 'If-Match': '"1"' });
    expect(p.status).toBe(200);
    // a date that is not after the version in force
    const clash = await admin.api.call('post', `/settings/sla-rule-sets/${d.body.id}/publish`, { effective_date: await dbDate(db, 'cal_today()'), reason: REASON }, { 'If-Match': '"2"' });
    expect(clash.status).toBe(422);
    expect(clash.body.errors.map((e: { code: string }) => e.code)).toContain('effective_date_not_after_current');
    // future date with apply: scheduled, nothing changes today
    const res = await admin.api.call('post', `/settings/sla-rule-sets/${d.body.id}/publish`, { effective_date: tomorrow, reason: REASON, apply_to_open_tasks: true }, { 'If-Match': '"2"' });
    expect(res.status).toBe(200);
    expect(res.body.affected_open_tasks).toBe(0);
    expect(res.body.rule_set).toMatchObject({ version: 3, is_active: false, effective_from: tomorrow, apply_to_open_tasks: true });
    expect((await taskRow(db, openBefore.site, 'D1')).sla_rule_id).toBe(openBeforeRow.sla_rule_id);
    // the day arrives: the scheduler applies it. Time is simulated by moving the whole chain one day back (version 1 ends yesterday, 2 runs
    // yesterday to today, 3 starts today); the freeze trigger of used rules is switched off for this fixture only.
    await db.query('ALTER TABLE sla_rules DISABLE TRIGGER sla_rules_frozen');
    await db.query(`UPDATE sla_rules SET effective_to = cal_today() - 1 WHERE rule_set_id = (SELECT id FROM sla_rule_sets WHERE version = 1)`);
    await db.query(`UPDATE sla_rules SET effective_from = cal_today() - 1, effective_to = cal_today() WHERE rule_set_id = (SELECT id FROM sla_rule_sets WHERE version = 2)`);
    await db.query(`UPDATE sla_rules SET effective_from = cal_today() WHERE rule_set_id = $1`, [d.body.id]);
    await db.query('ALTER TABLE sla_rules ENABLE TRIGGER sla_rules_frozen');
    await db.query(`UPDATE sla_rule_sets SET effective_from = cal_today() WHERE id = $1`, [d.body.id]);
    const applied = await q<{ n: number }>(db, 'SELECT sla_apply_due_sets() AS n');
    expect(applied[0]!.n).toBeGreaterThanOrEqual(1);
    const o = await taskRow(db, openBefore.site, 'D1');
    expect(o.sla_rule_id).not.toBe(openBeforeRow.sla_rule_id);
    expect(o.sla_start_date).toBe(openBeforeRow.sla_start_date);               // the start of each task is not changed
    expect(o.due_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${openBefore.start}', 8)`));
    expect(o.sla_target_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${openBefore.start}', 6)`));
    const c = await taskRow(db, closedBefore.site, 'D1');
    expect(c.sla_rule_id).toBe(closedBeforeRow.sla_rule_id);                   // approved tasks keep their version, dates and elapsed days
    expect(c.due_date).toBe(closedBeforeRow.due_date);
    expect(c.sla_elapsed_wd).toBe(closedBeforeRow.sla_elapsed_wd);
    const set3 = (await admin.api.call('get', `/settings/sla-rule-sets/${d.body.id}`)).body;
    expect(set3.affected_open_tasks).toBeGreaterThanOrEqual(1);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'sla_rule_set_publish' AND entity_id = $1`, [d.body.id])).toHaveLength(1);
    void region1;
  });
});
