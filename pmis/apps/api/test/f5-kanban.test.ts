import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin, type Site } from './wf-helpers';

/**
 * F5 (contract 0.15.32, migration 0118): the sites board by milestone (read only: columns, swimlanes, ageing in working days, WIP warnings,
 * region scope, the F3 filter) and the tasks board by approval state (columns; a drop only opens an existing action, so the board has no
 * write endpoint and reading it changes nothing). Synthetic sites in regions 6 (GM) and 7 (Sebha), each with this run's tag in its code, and
 * every board call filters on the tag (q), so the suites that run beside it never change the counts.
 */
const TAG = `F5${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let today: string;

type J = Record<string, any>;
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

const site = (region: number, over: { status?: string } = {}): Promise<Site> => makeSite(db, region, { prefix: TAG, ...over });
/** An approved milestone task (MS1, MS2 ...) with its milestone date. */
const approvedMs = (s: Site, code: string, actual: string) => makeTask(db, s, code, 'approved', { actualDate: actual });
const board = async (a: Actor, extra = ''): Promise<J> => {
  const r = await a.api.call('get', `/boards/sites?q=${TAG}${extra}`);
  expect(r.status).toBe(200);
  return r.body as J;
};
const cardsIn = (b: J, column: string): J[] => (b.cells as J[]).filter((c) => c.column === column).flatMap((c) => c.cards as J[]);
const colOf = (b: J, code: string): string | undefined => (b.cells as J[]).find((c) => (c.cards as J[]).some((x) => x.site_code === code))?.column;

describe('sites board', () => {
  it('places each site in the first milestone not yet done (a site without tasks in the first one), completed sites in Closed', async () => {
    const fresh = await site(7);
    const inMs2 = await site(7);
    await approvedMs(inMs2, 'MS1', addDays(today, -5));
    await makeTask(db, inMs2, 'B1', 'entry');
    await makeTask(db, inMs2, 'MS2', 'locked');
    const done = await site(7, { status: 'completed' });
    const allDone = await site(7);
    await approvedMs(allDone, 'MS1', addDays(today, -9)); // the only stage with work is done: closed
    const cancelled = await site(7, { status: 'cancelled' });

    const b = await board(admin);
    expect((b.columns as J[]).map((c) => c.key).slice(0, 3)).toEqual(['MS1', 'MS2', 'MS3']);
    expect((b.columns as J[]).at(-1)).toMatchObject({ key: 'closed', kind: 'closed' });
    expect(colOf(b, fresh.code)).toBe('MS1');
    expect(colOf(b, inMs2.code)).toBe('MS2');
    expect(colOf(b, done.code)).toBe('closed');
    expect(colOf(b, allDone.code)).toBe('closed');
    expect(colOf(b, cancelled.code)).toBeUndefined(); // cancelled sites stay off the board unless asked for
    expect(colOf(await board(admin, '&include_cancelled=true'), cancelled.code)).toBe('MS1');
    // a card carries what the board shows; the open entry task of MS2 is at L1
    const card = cardsIn(b, 'MS2').find((c) => c.site_code === inMs2.code)!;
    expect(card).toMatchObject({ region_id: 7, overall_status: 'in_progress', entered_on: addDays(today, -5), at_l1: 1, at_l2: 0 });
    // read only: the board offers no write
    for (const m of ['post', 'put', 'patch', 'delete'] as const) expect((await admin.api.call(m, '/boards/sites', {})).status).toBe(404);
  });

  it('ageing counts working days since the previous milestone date, without the weekend and the holidays of the calendar', async () => {
    const cal = (await db.query('SELECT cal_default() AS id, cal_weekend() AS we')).rows[0] as { id: string; we: number[] };
    // the latest working-day holiday of the default calendar before today; the site entered its column three days before it
    const h = await db.query(`SELECT date::text AS d FROM holidays WHERE calendar_id = $1 AND date < cal_today() AND date > cal_today() - 400
      AND NOT (extract(dow FROM date)::int = ANY($2::int[])) ORDER BY date DESC LIMIT 1`, [cal.id, cal.we]);
    const holiday = h.rows[0]?.d as string | undefined;
    const entered = holiday ? addDays(holiday, -3) : addDays(today, -15);
    const hols = new Set((await db.query('SELECT date::text AS d FROM holidays WHERE calendar_id = $1', [cal.id])).rows.map((r) => r.d as string));
    let expected = 0, weekdaysOnly = 0;
    for (let d = addDays(entered, 1); d <= today; d = addDays(d, 1)) {
      const wd = !cal.we.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
      if (wd) weekdaysOnly += 1;
      if (wd && !hols.has(d)) expected += 1;
    }
    const s = await site(7);
    await approvedMs(s, 'MS1', entered);
    await makeTask(db, s, 'B1', 'entry');
    const card = cardsIn(await board(admin), 'MS2').find((c) => c.site_code === s.code)!;
    expect(card.entered_on).toBe(entered);
    expect(card.ageing_wd).toBe(expected);
    // the window holds at least one weekend, and the holiday when the calendar has one
    expect(expected).toBeLessThan(Math.round((Date.parse(today) - Date.parse(entered)) / 86400000));
    if (holiday) expect(weekdaysOnly - expected).toBeGreaterThanOrEqual(1);
    // a site with no milestone yet ages from the day it was created
    const s2 = await site(7);
    await db.query(`UPDATE sites SET created_at = ((cal_today() - 1)::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Tripoli' WHERE id = $1`, [s2.id]);
    const c2 = cardsIn(await board(admin), 'MS1').find((c) => c.site_code === s2.code)!;
    expect(c2.entered_on).toBe(addDays(today, -1));
    expect(c2.ageing_wd).toBe((await db.query('SELECT cal_workdays_between(cal_today() - 1, cal_today()) AS n')).rows[0].n);
  });

  it('swimlanes by region and by contractor, with counts per lane and cell', async () => {
    const tag = `${TAG}SW`;
    const a6 = await makeSite(db, 6, { prefix: tag });
    const a7 = await makeSite(db, 7, { prefix: tag });
    const b7 = await makeSite(db, 7, { prefix: tag });
    const party = (await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'cw_contractor') RETURNING id`, [`F5 Contractor ${tag}`])).rows[0].id as string;
    const t = await makeTask(db, a7, 'A1', 'entry');
    await db.query('UPDATE task_instances SET external_party_id = $2 WHERE id = $1', [t, party]);

    const byRegion = (await admin.api.call('get', `/boards/sites?q=${tag}&swimlane=region`)).body as J;
    expect(byRegion.swimlane).toBe('region');
    expect((byRegion.lanes as J[]).map((l) => [l.key, l.count])).toEqual([['6', 1], ['7', 2]]);
    expect((byRegion.cells as J[]).find((c) => c.column === 'MS1' && c.lane === '7')).toMatchObject({ count: 2, more: false });

    const byParty = (await admin.api.call('get', `/boards/sites?q=${tag}&swimlane=contractor`)).body as J;
    expect((byParty.lanes as J[]).map((l) => [l.key, l.label_en, l.count])).toEqual([[party, `F5 Contractor ${tag}`, 1], ['none', 'No contractor', 2]]);
    const card = (byParty.cells as J[]).flatMap((c) => c.cards as J[]).find((c) => c.site_code === a7.code)!;
    expect(card.contractor).toEqual({ id: party, name: `F5 Contractor ${tag}` });
    expect([a6.code, b7.code].every((c) => (byParty.cells as J[]).find((x) => x.lane === 'none')!.cards.some((k: J) => k.site_code === c))).toBe(true);

    // a card limit per cell: the count stays, "more" says some are not shown
    const few = (await admin.api.call('get', `/boards/sites?q=${tag}&swimlane=region&card_limit=1`)).body as J;
    expect((few.cells as J[]).find((c) => c.lane === '7')).toMatchObject({ count: 2, more: true });
    expect((few.cells as J[]).find((c) => c.lane === '7')!.cards).toHaveLength(1);
    expect((await admin.api.call('get', `/boards/sites?swimlane=owner`)).status).toBe(422);
    expect((await admin.api.call('get', `/boards/sites?card_limit=0`)).status).toBe(422);
  });

  it('a WIP limit only marks the column (a warning): the cards stay, nothing is refused; the setting needs a reason and If-Match', async () => {
    const tag = `${TAG}WIP`;
    for (let i = 0; i < 2; i++) {
      const s = await makeSite(db, 7, { prefix: tag });
      await approvedMs(s, 'MS1', addDays(today, -2));
      await makeTask(db, s, 'B1', 'entry');
    }
    const cur = await admin.api.call('get', '/settings/kanban-wip');
    expect(cur.status).toBe(200);
    expect(cur.body.limits).toEqual({});
    expect((cur.body.columns as J[]).map((c) => c.code)).toContain('MS2');
    const before = (await admin.api.call('get', `/boards/sites?q=${tag}`)).body as J;
    expect((before.columns as J[]).find((c) => c.key === 'MS2')).toMatchObject({ count: 2, wip_limit: null, over_wip: false });

    // no reason, no If-Match, an unknown column, a bad value: refused
    expect((await admin.api.call('put', '/settings/kanban-wip', { limits: { MS2: 1 } }, { 'If-Match': cur.headers.etag as string })).status).toBe(422);
    expect((await admin.api.call('put', '/settings/kanban-wip', { limits: { MS2: 1 }, reason: 'F5 test' })).status).toBe(428);
    expect((await admin.api.call('put', '/settings/kanban-wip', { limits: { ZZ9: 1 }, reason: 'F5 test' }, { 'If-Match': cur.headers.etag as string })).status).toBe(422);
    expect((await admin.api.call('put', '/settings/kanban-wip', { limits: { MS2: 0 }, reason: 'F5 test' }, { 'If-Match': cur.headers.etag as string })).status).toBe(422);
    // a user without the settings right cannot change it
    const lead = await actor(app, db, { grants: [['sites', 'view'], ['settings', 'view']] });
    expect((await lead.api.call('get', '/settings/kanban-wip')).body.can_edit).toBe(false);
    expect((await lead.api.call('put', '/settings/kanban-wip', { limits: { MS2: 1 }, reason: 'F5 test' }, { 'If-Match': cur.headers.etag as string })).status).toBe(403);

    const put = await admin.api.call('put', '/settings/kanban-wip', { limits: { MS2: 1 }, reason: 'F5 test: warn above one' }, { 'If-Match': cur.headers.etag as string });
    expect(put.status).toBe(200);
    expect(put.body.limits).toEqual({ MS2: 1 });
    try {
      const after = (await admin.api.call('get', `/boards/sites?q=${tag}`)).body as J;
      expect((after.columns as J[]).find((c) => c.key === 'MS2')).toMatchObject({ count: 2, wip_limit: 1, over_wip: true });
      expect(cardsIn(after, 'MS2')).toHaveLength(2);
      const audit = await db.query(`SELECT before, after, reason FROM audit_log WHERE action = 'kanban_wip_limits_update' ORDER BY at DESC LIMIT 1`);
      expect(audit.rows[0].after.limits).toEqual({ MS2: 1 });
      expect(audit.rows[0].reason).toBe('F5 test: warn above one');
      // (a direct write of the key by the application role is refused: tests/db-security/cases/D1_f5_kanban.sql)
    } finally {
      const now = await admin.api.call('get', '/settings/kanban-wip');
      await admin.api.call('put', '/settings/kanban-wip', { limits: {}, reason: 'F5 test: back to no limit' }, { 'If-Match': now.headers.etag as string });
    }
  });

  it('keeps to the caller\'s regions (B3) and applies the F3 filter tree and the simple filters', async () => {
    const tag = `${TAG}RG`;
    const s6 = await makeSite(db, 6, { prefix: tag });
    const s7 = await makeSite(db, 7, { prefix: tag });
    const gm = await actor(app, db, { grants: [['sites', 'view']], regions: [6] });
    const seen = (b: J) => (b.cells as J[]).flatMap((c) => c.cards as J[]).map((c) => c.site_code).sort();
    expect(seen((await gm.api.call('get', `/boards/sites?q=${tag}&swimlane=region`)).body)).toEqual([s6.code]);
    expect(seen((await admin.api.call('get', `/boards/sites?q=${tag}`)).body)).toEqual([s6.code, s7.code].sort());
    const noSites = await actor(app, db, { grants: [['issues', 'view']] });
    expect((await noSites.api.call('get', '/boards/sites')).status).toBe(403);

    const tree = { op: 'and', items: [{ field: 'site_code', operator: 'contains', value: tag }, { op: 'or', items: [{ field: 'region_id', operator: 'is', value: '7' }] }] };
    const f = (await admin.api.call('get', `/boards/sites?filter=${encodeURIComponent(JSON.stringify(tree))}`)).body as J;
    expect(seen(f)).toEqual([s7.code]);
    expect(f.total).toBe(1);
    expect(seen((await admin.api.call('get', `/boards/sites?q=${tag}&region_id=6`)).body)).toEqual([s6.code]);
    const bad = await admin.api.call('get', `/boards/sites?filter=${encodeURIComponent(JSON.stringify({ op: 'and', items: [{ field: 'secret', operator: 'is', value: 'x' }] }))}`);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ code: 'unknown_field' });
  });
});

describe('tasks board', () => {
  it('four columns by approval state; a rejection back to L1 is its own column; F3 filter and regions apply', async () => {
    const s = await site(7);
    const entry = await makeTask(db, s, 'A1', 'entry');
    const open = await makeTask(db, s, 'A2', 'open');
    const review = await makeTask(db, s, 'A3', 'in_review');
    const approval = await makeTask(db, s, 'A4', 'in_approval');
    const approved = await makeTask(db, s, 'A5', 'approved', { actualDate: addDays(today, -1) });
    const returned = await makeTask(db, s, 'MS1', 'entry');
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
      VALUES ($1, 1, 'submit', $2, NULL, 'entry', 'in_approval', now() - interval '2 hours'), ($1, 3, 'reject', $2, 'F5 note', 'in_approval', 'entry', now() - interval '1 hour')`, [returned, admin.user.id]);

    const r = await admin.api.call('get', `/boards/tasks?q=${s.code}`);
    expect(r.status).toBe(200);
    const col = (k: string): string[] => ((r.body.columns as J[]).find((c) => c.key === k)!.items as J[]).map((t) => t.id).sort();
    expect((r.body.columns as J[]).map((c) => c.key)).toEqual(['entry', 'review', 'rejected', 'approved']);
    expect(col('entry')).toEqual([entry, open].sort());
    expect(col('review')).toEqual([review, approval].sort());
    expect(col('rejected')).toEqual([returned]);
    expect(col('approved')).toEqual([approved]);
    expect(r.body.total).toBe(6);
    // the cards are task summaries with the F2 timing
    const card = ((r.body.columns as J[]).find((c) => c.key === 'rejected')!.items as J[])[0]!;
    expect(card).toHaveProperty('ball_in_court');
    expect(card).toHaveProperty('stale');
    expect(card.sla).toHaveProperty('late_wd');

    // F3 tree of the board (screen tasks-board, the site-tasks whitelist)
    const tree = { op: 'and', items: [{ field: 'site_code', operator: 'is', value: s.code }, { field: 'state', operator: 'in', value: ['in_review', 'approved'] }] };
    const f = await admin.api.call('get', `/boards/tasks?filter=${encodeURIComponent(JSON.stringify(tree))}`);
    expect(f.status).toBe(200);
    expect(f.body.total).toBe(2);
    const ff = await admin.api.call('get', `/saved-views/filter-fields?screen_key=tasks-board`);
    expect(ff.status).toBe(200);
    expect((ff.body.items as J[]).map((x) => x.key)).toContain('state');
    // a saved view of the board can be kept (screen tasks-board, module sites)
    const sv = await admin.api.call('post', '/saved-views', { screen_key: 'tasks-board', name: `F5 ${TAG}`, filters: { advanced: tree } });
    expect(sv.status).toBe(201);

    // regions: a GM-only user sees none of these Sebha tasks; site_id narrows; card_limit keeps the count
    const gm = await actor(app, db, { grants: [['sites', 'view']], regions: [6] });
    expect((await gm.api.call('get', `/boards/tasks?q=${s.code}`)).body.total).toBe(0);
    expect((await admin.api.call('get', `/boards/tasks?site_id=${s.id}`)).body.total).toBe(6);
    const one = await admin.api.call('get', `/boards/tasks?site_id=${s.id}&card_limit=1`);
    expect((one.body.columns as J[]).find((c) => c.key === 'entry')).toMatchObject({ count: 2, more: true });
    expect((await admin.api.call('get', '/boards/tasks?site_id=nope')).status).toBe(422);
  });

  it('a drop only opens the existing action: the board has no write endpoint, and reading it changes no task', async () => {
    const s = await site(7);
    const t = await makeTask(db, s, 'A1', 'in_approval');
    const before = (await db.query('SELECT state::text, version, updated_at FROM task_instances WHERE id = $1', [t])).rows[0];
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await admin.api.call(m, '/boards/tasks', { task_id: t, column: 'approved' })).status).toBe(404);
      expect((await admin.api.call(m, `/boards/tasks/${t}`, { column: 'approved' })).status).toBe(404);
    }
    await admin.api.call('get', `/boards/tasks?site_id=${s.id}`);
    expect((await db.query('SELECT state::text, version, updated_at FROM task_instances WHERE id = $1', [t])).rows[0]).toEqual(before);
    // what the client opens on a drop comes from the existing task detail: an approver sees approve and reject, a viewer none
    const viewer = await actor(app, db, { grants: [['sites', 'view']], regions: [7], level: 'view' });
    const d = await viewer.api.call('get', `/tasks/${t}`);
    expect(d.status).toBe(200);
    expect((d.body.allowed_actions as J[]).map((a) => a.action)).not.toContain('approve');
  });
});
