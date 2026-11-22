import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slaOverrun } from '../src/workflow/task-view.service';
import { startApp, superDb } from './helpers';
import { Actor, actor, makeSite, plainAdmin, setCell, taskDef, type Site } from './wf-helpers';

/**
 * F2 (contract 0.15.30, migration 0116): who holds the ball and since when, in working days; the SLA overrun with its traffic colour; the stale flag;
 * the list filters (Approvals, My Work) and the B3 scope. Region 7 (Sebha), synthetic sites. Each test uses its own work calendar (never the default
 * one, so the suites that run beside it keep their holidays):
 *   - WK: weekend Friday and Saturday plus one holiday inside the window (the durations across a weekend and a holiday);
 *   - FLAT: no weekend and no holiday (every day is a working day), so a boundary is a plain day count.
 */
const REGION = 7;
const PREFIX = `F2B${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let today: string;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  today = (await db.query('SELECT cal_today()::text AS d')).rows[0].d as string;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const site = (): Promise<Site> => makeSite(db, REGION, { prefix: PREFIX });
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();

async function calendar(weekend: number[], holidays: string[] = []): Promise<string> {
  const c = await db.query('INSERT INTO work_calendars (code, name, weekend_days) VALUES ($1, $1, $2::int[]) RETURNING id', [`F2${randomBytes(4).toString('hex')}`, weekend]);
  const id = c.rows[0].id as string;
  for (const h of holidays) await db.query(`INSERT INTO holidays (calendar_id, date, name) VALUES ($1, $2::date, 'F2 test holiday')`, [id, h]);
  return id;
}

/** A rule the test points its tasks at (sla_rule_id); its own one-day range of long ago, so it never overlaps a real rule or another test's. */
let ruleDay = Math.floor(Math.random() * 20000);
async function rule(taskCode: string, cal: string, min: number, max: number): Promise<string> {
  const td = await taskDef(db, taskCode);
  ruleDay += 1;
  const r = await db.query(
    `INSERT INTO sla_rules (task_def_id, min_working_days, max_working_days, start_event, calendar_id, effective_from, effective_to, reason, changed_by)
     VALUES ($1, $2, $3, 'OPEN', $4, DATE '1900-01-01' + $6::int, DATE '1900-01-01' + $6::int + 1, 'F2 test rule', $5) RETURNING id`,
    [td.id, min, max, cal, admin.user.id, ruleDay],
  );
  return r.rows[0].id as string;
}

/** A noon in Tripoli `ago` calendar days before today. */
const noonAgo = (ago: number) => `((cal_today() - ${ago})::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Tripoli'`;

async function task(s: Site, code: string, state: string, o: { rule?: string | null; startAgo?: number; openedAgo?: number | null; elapsed?: number; level?: number } = {}): Promise<string> {
  const td = await taskDef(db, code);
  const level = o.level ?? (state === 'open' || state === 'entry' ? 1 : state === 'in_review' ? 2 : state === 'in_approval' ? 3 : 0);
  const opened = o.openedAgo === null ? 'NULL' : noonAgo(o.openedAgo ?? 0);
  const r = await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, sla_rule_id, sla_start_date, sla_elapsed_wd,
       level_opened_at, level_round, updated_at)
     VALUES ($1, $2, $3, $4::"TaskState", $5, 3, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE cal_today() - $7::int END, $8, ${opened}, 1, now()) RETURNING id`,
    [s.id, s.region, td.id, state, level, o.rule ?? null, o.startAgo ?? null, o.elapsed ?? null],
  );
  return r.rows[0].id as string;
}

type J = Record<string, any>;
const siteTasks = async (a: Actor, s: Site): Promise<J[]> => {
  const res = await a.api.call('get', `/sites/${s.id}/tasks`);
  expect(res.status).toBe(200);
  return (res.body.stages as J[]).flatMap((st) => st.tasks as J[]);
};

describe('the overrun rule (unit)', () => {
  it('counts the working days past the maximum and left to it; nothing without a measured clock', () => {
    expect(slaOverrun('entry', 3, 5, true)).toEqual({ late_wd: 0, left_wd: 2 });
    expect(slaOverrun('entry', 5, 5, true)).toEqual({ late_wd: 0, left_wd: 0 });
    expect(slaOverrun('in_review', 8, 5, true)).toEqual({ late_wd: 3, left_wd: 0 });
    expect(slaOverrun('approved', 8, 5, true)).toEqual({ late_wd: 3, left_wd: null });
    expect(slaOverrun('entry', 8, 5, false)).toEqual({ late_wd: null, left_wd: null });
    expect(slaOverrun('entry', null, 5, true)).toEqual({ late_wd: null, left_wd: null });
  });
});

describe('ball in court and its duration', () => {
  it('counts working days across a weekend and a holiday (never calendar days), for the ball, the idle time and the SLA', async () => {
    const opened = addDays(today, -10);
    // the holiday: the first working day after the opening day (the window of 10 days always holds one Friday and one Saturday)
    let holiday = addDays(opened, 1);
    while ([5, 6].includes(dow(holiday))) holiday = addDays(holiday, 1);
    const cal = await calendar([5, 6], [holiday]);
    let expected = 0;
    for (let d = addDays(opened, 1); d <= today; d = addDays(d, 1)) if (![5, 6].includes(dow(d)) && d !== holiday) expected += 1;
    expect(expected).toBeLessThanOrEqual(10 - 2 - 1);

    const e = await actor(app, db, { level: 'entry' });
    const s = await site();
    const r = await rule('A1', cal, 3, 20);
    const id = await task(s, 'A1', 'entry', { rule: r, startAgo: 10, openedAgo: 10 });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });

    const res = await e.api.call('get', `/tasks/${id}`);
    expect(res.status).toBe(200);
    const b = res.body.ball_in_court;
    expect(b.level_code).toBe('L1');
    expect(b.holders.map((h: J) => h.ref_id)).toEqual([e.user.id]);
    expect(new Date(b.since).toISOString()).toBe(b.since);
    expect(b.held_wd).toBe(expected);
    // no person acted since the level opened: idle as long as the ball is held, and stale with the default limit
    expect(res.body.idle_working_days).toBe(expected);
    expect(res.body.stale_after_wd).toBeGreaterThanOrEqual(1);
    expect(res.body.stale).toBe(expected >= res.body.stale_after_wd);
    expect(res.body.sla.elapsed_wd).toBe(expected);
    expect(res.body.sla).toMatchObject({ colour: expected <= 3 ? 'green' : 'amber', late_wd: 0, left_wd: 20 - expected });

    // the same values in the task grid of the site
    const row = (await siteTasks(e, s)).find((x) => x.id === id)!;
    expect(row.ball_in_court.held_wd).toBe(expected);
    expect(row.sla.left_wd).toBe(20 - expected);

    // without the holiday the same window has one working day more
    await db.query('DELETE FROM holidays WHERE calendar_id = $1', [cal]);
    expect((await e.api.call('get', `/tasks/${id}`)).body.ball_in_court.held_wd).toBe(expected + 1);
  });

  it('shows no ball and no idle time on a locked or approved task, and the external party where the task has one', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const s = await site();
    const locked = await task(s, 'A1', 'locked', { openedAgo: null });
    const done = await task(s, 'A2', 'approved', { openedAgo: null });
    const party = await db.query(`INSERT INTO external_parties (name, type) VALUES ('F2 Vendor (synthetic)', 'te_vendor') RETURNING id`);
    const open = await task(s, 'A4', 'entry', { openedAgo: 0 });
    await db.query('UPDATE task_instances SET external_party_id = $1 WHERE id = $2', [party.rows[0].id, open]);
    const rows = await siteTasks(e, s);
    for (const id of [locked, done]) {
      const x = rows.find((r) => r.id === id)!;
      expect(x.ball_in_court).toBeUndefined();
      expect(x).toMatchObject({ idle_working_days: null, stale: false, last_activity_at: null });
    }
    const o = rows.find((r) => r.id === open)!;
    expect(o.ball_in_court.external_party).toMatchObject({ name: 'F2 Vendor (synthetic)', type: 'te_vendor' });
    expect(o.ball_in_court.held_wd).toBe(0);
    expect(o.stale).toBe(false);
  });
});

describe('SLA overrun colours at the boundaries', () => {
  it('is green up to the minimum, amber up to the maximum and red above it, with "N wd left" and "+N wd late"', async () => {
    const cal = await calendar([]);
    const r = await rule('A1', cal, 3, 5);
    const s = await site();
    const ids: Record<string, string> = {};
    const codes = ['A1', 'A2', 'A3', 'A4', 'B1'];
    for (const [i, n] of [3, 4, 5, 6, 0].entries()) ids[n] = await task(s, codes[i]!, 'entry', { rule: r, startAgo: n, openedAgo: n });
    const done = await task(s, 'B2', 'approved', { rule: r, startAgo: 30, openedAgo: null, elapsed: 8 });
    const rows = await siteTasks(admin, s);
    const sla = (id: string) => rows.find((x) => x.id === id)!.sla;
    expect(sla(ids[0]!)).toMatchObject({ elapsed_wd: 0, colour: 'green', late_wd: 0, left_wd: 5 });
    expect(sla(ids[3]!)).toMatchObject({ elapsed_wd: 3, colour: 'green', late_wd: 0, left_wd: 2 });
    expect(sla(ids[4]!)).toMatchObject({ elapsed_wd: 4, colour: 'amber', late_wd: 0, left_wd: 1 });
    expect(sla(ids[5]!)).toMatchObject({ elapsed_wd: 5, colour: 'amber', late_wd: 0, left_wd: 0 });
    expect(sla(ids[6]!)).toMatchObject({ elapsed_wd: 6, colour: 'red', late_wd: 1, left_wd: 0 });
    // an approved task keeps the value computed at approval: late by 3, nothing left
    expect(sla(done)).toMatchObject({ elapsed_wd: 8, colour: 'red', late_wd: 3, left_wd: null });
    // no SLA rule: no overrun
    const none = await task(await site(), 'A1', 'entry', { openedAgo: 0 });
    await db.query('UPDATE task_instances SET sla_rule_id = NULL, sla_start_date = NULL WHERE id = $1', [none]); // the opening trigger gave it the seed rule
    expect((await admin.api.call('get', `/tasks/${none}`)).body.sla).toMatchObject({ colour: 'none', late_wd: null, left_wd: null });
  });
});

describe('the stale flag', () => {
  it('uses the idle limit setting, counts the last activity of a person (not the task updated_at), and clears on a comment', async () => {
    const cal = await calendar([]);
    const r = await rule('A1', cal, 1, 30);
    const limit = (await db.query('SELECT task_stale_idle_days() AS n')).rows[0].n as number;
    expect(limit).toBeGreaterThanOrEqual(1);
    const s = await site();
    // the idle count is in working days of the calendar of the task's SLA rule (the opening trigger may give it the seed rule): on a weekend day
    // "N calendar days ago" is not N working days, so set each task's opening to the nearest date exactly N working days back in that calendar
    const openWdAgo = async (id: string, wd: number): Promise<void> => {
      await db.query(
        `UPDATE task_instances t SET level_opened_at = ((cal_today() - (SELECT min(d)::int FROM generate_series(0, 60) d
            WHERE cal_workdays_between(cal_today() - d, cal_today(), (SELECT r.calendar_id FROM sla_rules r WHERE r.id = t.sla_rule_id)) = $2::int))::timestamp
            + interval '12 hours') AT TIME ZONE 'Africa/Tripoli'
         WHERE t.id = $1::uuid`, [id, wd]);
    };
    const below = await task(s, 'A1', 'entry', { rule: r });
    const at = await task(s, 'A2', 'entry', { rule: r });
    await openWdAgo(below, limit - 1);
    await openWdAgo(at, limit);
    // updated_at is now on both (a system recalculation moves it too); it is not an activity
    const rows = await siteTasks(admin, s);
    const get = (id: string) => rows.find((x) => x.id === id)!;
    expect(get(below)).toMatchObject({ idle_working_days: limit - 1, stale: false, stale_after_wd: limit });
    expect(get(at)).toMatchObject({ idle_working_days: limit, stale: true, stale_after_wd: limit });

    // a comment by a person is an activity
    const c = await admin.api.call('post', `/tasks/${at}/comments`, { body: 'F2: still on it (synthetic note)' });
    expect(c.status).toBe(201);
    const after = (await admin.api.call('get', `/tasks/${at}`)).body;
    expect(after).toMatchObject({ idle_working_days: 0, stale: false });
    expect(Date.parse(after.last_activity_at)).toBeGreaterThan(Date.now() - 600_000);
  });
});

describe('filters and scope', () => {
  it('filters the Approvals inbox by SLA colour and stale, and refuses an unknown colour', async () => {
    const a = await actor(app, db, { level: 'approve' });
    const cal = await calendar([]);
    const r = await rule('A1', cal, 1, 2);
    const s = await site();
    const red = await task(s, 'A1', 'in_approval', { rule: r, startAgo: 9, openedAgo: 9 });
    const green = await task(s, 'A2', 'in_approval', { rule: r, startAgo: 0, openedAgo: 0 });
    for (const code of ['A1', 'A2']) await setCell(db, code, REGION, 'approve', { user: [a.user.id] });
    const ids = async (qs: string): Promise<string[]> => {
      const res = await a.api.call('get', `/approvals?q=${s.code}${qs}`);
      expect(res.status, qs).toBe(200);
      return (res.body.items as J[]).map((i) => i.task.id).sort();
    };
    expect(await ids('')).toEqual([red, green].sort());
    expect(await ids('&sla_colour=red')).toEqual([red]);
    expect(await ids('&sla_colour=green,amber')).toEqual([green]);
    expect(await ids('&sla_colour=green&sla_colour=red')).toEqual([red, green].sort());
    expect(await ids('&stale=true')).toEqual([red]);
    expect(await ids('&stale=false')).toEqual([green]);
    const item = (await a.api.call('get', `/approvals?q=${s.code}&sla_colour=red`)).body.items[0];
    expect(item.task.ball_in_court).toMatchObject({ level_code: 'L2', held_wd: 9 });
    expect(item.task.sla).toMatchObject({ colour: 'red', late_wd: 7 });
    for (const bad of ['sla_colour=pink', 'sla_colour=', 'stale=maybe']) expect((await a.api.call('get', `/approvals?${bad}`)).status, bad).toBe(422);
  });

  it('My Work: late, do now and waiting buckets, with the F2 fields, limited to the regions of the caller', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const ap = await actor(app, db, { level: 'approve' });
    const elsewhere = await actor(app, db, { level: 'entry', regions: [1] });
    const cal = await calendar([]);
    const r = await rule('A1', cal, 1, 2);
    const s = await site();
    const late = await task(s, 'A1', 'entry', { rule: r, startAgo: 6, openedAgo: 6 });
    const now = await task(s, 'A2', 'entry', { rule: r, startAgo: 0, openedAgo: 0 });
    const waiting = await task(s, 'A3', 'in_approval', { rule: r, startAgo: 1, openedAgo: 1 });
    for (const code of ['A1', 'A2', 'A3']) {
      await setCell(db, code, REGION, 'entry', { user: [e.user.id, elsewhere.user.id] });
      await setCell(db, code, REGION, 'approve', { user: [ap.user.id] });
    }
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by) VALUES ($1, 1, 'submit', $2)`, [waiting, e.user.id]);
    // every page: the cells are region-wide, so the caller also holds the tasks other tests created in the region, and one page of 50 may not reach this site's
    const mine = async (who: Actor, qs: string): Promise<J[]> => {
      const out: J[] = [];
      let cursor: string | null = null;
      do {
        const sep = qs ? '&' : '?';
        const res = await who.api.call('get', `/me/tasks${qs}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(res.status, qs).toBe(200);
        out.push(...(res.body.items as J[]));
        cursor = res.body.page.next_cursor as string | null;
      } while (cursor);
      return out.filter((t) => t.site_code === s.code);
    };
    const lateItems = await mine(e, '?bucket=late');
    expect(lateItems.map((t) => t.id)).toEqual([late]);
    expect(lateItems[0]).toMatchObject({ sla: { colour: 'red', late_wd: 4 }, ball_in_court: { held_wd: 6, level_code: 'L1' }, stale: true });
    expect((await mine(e, '?bucket=do_now')).map((t) => t.id)).toEqual([now]);
    expect((await mine(e, '?bucket=waiting')).map((t) => t.id)).toEqual([waiting]);
    expect((await mine(e, '')).map((t) => t.id).sort()).toEqual([late, now].sort());
    expect((await mine(e, '?stale=false')).map((t) => t.id)).toEqual([now]);
    expect((await mine(e, '?sla_colour=red')).map((t) => t.id)).toEqual([late]);
    // the approver: the task at L2 is to do now; the region-1 holder sees nothing of Sebha (B3)
    expect((await mine(ap, '?bucket=do_now')).map((t) => t.id)).toEqual([waiting]);
    for (const b of ['', '?bucket=late', '?bucket=do_now', '?bucket=waiting']) expect(await mine(elsewhere, b), b).toEqual([]);
    expect((await e.api.call('get', '/me/tasks?bucket=soon')).status).toBe(422);
    expect((await elsewhere.api.call('get', `/tasks/${late}`)).status).toBe(404);
  });

  it('the activity door answers nothing for a task outside the caller\'s regions (row security)', async () => {
    const s = await site();
    const id = await task(s, 'A1', 'entry', { openedAgo: 3 });
    const elsewhere = await actor(app, db, { level: 'entry', regions: [1] });
    expect((await elsewhere.api.call('get', `/tasks/${id}`)).status).toBe(404);
    const own = await actor(app, db, { level: 'entry', regions: [REGION] });
    const res = await own.api.call('get', `/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.last_activity_at).not.toBeNull();
  });
});

describe('register records in approval', () => {
  it('carry the ball since and its working days', async () => {
    const s = await site();
    const rec = await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, current_level, data, level_opened_at)
       VALUES (gen_random_uuid(), 1, 'issues', $1, $2, 'in_approval', true, 3, '{}'::jsonb, ${noonAgo(10)}) RETURNING id`,
      [s.id, REGION],
    );
    const expected = (await db.query('SELECT cal_workdays_between(cal_today() - 10, cal_today()) AS n')).rows[0].n as number;
    const res = await admin.api.call('get', `/registers/issues/records?site_id=${s.id}`);
    expect(res.status).toBe(200);
    const r = (res.body.items as J[]).find((x) => x.id === rec.rows[0].id)!;
    expect(r.ball_in_court).toMatchObject({ held_wd: expected });
    expect(typeof r.ball_in_court.since).toBe('string');
  });
});
