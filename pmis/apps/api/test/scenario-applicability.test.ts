import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allLocked, approve, dbDate, q, taskId, taskRow, wd } from './calc-helpers';
import { makeUser, startApp } from './helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';
import type { Site } from './wf-helpers';

/**
 * Work package P1, migration 0052 (owner answers of 2026-11-04, binding): scenario applicability (Q15, Q3), the D-1 start and the Swap
 * exclusion (Q2), the gate history (Q9), suspension windows on effective dates (Q180), the Layout Submitted Date (Q13), the SLA sheet column
 * map (Q14), the C-4 in-service end event (Q136), the pending flag (Q135) and the tentative-date badge (D4b).
 * The suite changes scenario rules, publishes an SLA rule set and adds a tentative holiday, so it runs in its own database (TEST_DATABASE_URL_P1).
 * Dates are counted in working days from today by the database itself, so nothing depends on the weekday the suite runs.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_P1 as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_P1 });
  await db.connect();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const REASON = 'scope reviewed with the PM';
const site = (scenario: string, region = 5): Promise<Site> => makeSite(db, region, { prefix: 'P1', scenario });
const flags = (s: Site, set: string): Promise<unknown> => db.query(`UPDATE sites SET ${set} WHERE id = $1`, [s.id]);
type AppTask = { task_code: string; applies: boolean | null; sla_measured: boolean; source: string; state: string };
const appTask = (body: { tasks: AppTask[] }, code: string): AppTask => body.tasks.find((t) => t.task_code === code)!;
const gridTask = async (s: Site, code: string): Promise<{ sla: Record<string, unknown> }> => {
  const grid = await admin.api.call('get', `/sites/${s.id}/tasks`);
  expect(grid.status).toBe(200);
  return grid.body.stages.flatMap((x: { tasks: unknown[] }) => x.tasks).find((x: { task_code: string }) => x.task_code === code);
};

describe('Q15 and Q3: scenario applicability of a site', () => {
  it('makes A1, A3 and the Site RFI N/A for a Hot Swap, never touches an approved task or one in review, and audits each change', async () => {
    const s = await site('hot_swap');
    await allLocked(db, s);
    await approve(db, s, 'A2', await wd(db, -5));
    await db.query(`UPDATE task_instances SET state = 'in_review', current_level = 2 WHERE id = $1`, [await taskId(db, s, 'C1')]);
    const before = await admin.api.call('get', `/sites/${s.id}/applicability`);
    expect(before.status).toBe(200);
    expect(appTask(before.body, 'A1')).toMatchObject({ applies: false, source: 'scenario', state: 'locked' });
    expect(appTask(before.body, 'A3')).toMatchObject({ applies: false, source: 'scenario' });
    expect(appTask(before.body, 'A2')).toMatchObject({ applies: null, source: 'none' });
    expect(before.body.rfi).toEqual({ applies: false, master_rfi: false, differs: false });
    expect(before.body.conflicts).toEqual([]);

    expect((await noStep.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON })).status).toBe(401);
    expect((await plain.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON })).status).toBe(403);
    const res = await admin.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON });
    expect(res.status).toBe(200);
    const changed = res.body.result.changed.map((c: { task_code: string }) => c.task_code);
    expect(changed).toEqual(expect.arrayContaining(['A1', 'A3', 'MS4']));
    expect(res.body.result.kept).toEqual([expect.objectContaining({ task_code: 'C1', state: 'in_review' })]);
    expect((await taskRow(db, s, 'A1')).state).toBe('na');
    expect((await taskRow(db, s, 'MS4')).state).toBe('na');
    expect((await taskRow(db, s, 'A2')).state).toBe('approved');                 // approved: never changed
    expect((await taskRow(db, s, 'C1')).state).toBe('in_review');                // in review: reported, not changed
    const audit = await q(db, `SELECT 1 FROM audit_log WHERE action = 'task_applicability_na' AND site_id = $1 AND reason = $2`, [s.id, REASON]);
    expect(audit.length).toBe(changed.length);
    const na = await q<{ na_reason: string }>(db, `SELECT na_reason FROM task_instances WHERE id = $1`, [await taskId(db, s, 'A1')]);
    expect(na[0]!.na_reason).toMatch(/^applicability: Q15/);
  });

  it('refuses to apply the scope of a Cold Swap with GECOL = Yes until the conflict is reviewed, and a scope exception resolves it', async () => {
    const s = await site('cold_swap');
    await flags(s, `scope_gecol_power = 'yes'`);
    await allLocked(db, s);
    const a = await admin.api.call('get', `/sites/${s.id}/applicability`);
    expect(a.body.rfi).toEqual({ applies: false, master_rfi: true, differs: true });     // the Master formula only in the comparison
    expect(a.body.conflicts).toEqual([expect.objectContaining({ task_code: 'MS4', scenario: 'cold_swap', flag_expr: 'rfi' })]);
    const refused = await admin.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('scope_scenario_conflict');
    expect(refused.body.conflicts[0]).toMatchObject({ task_code: 'MS4' });
    expect((await taskRow(db, s, 'MS4')).state).toBe('locked');

    // an exception only for a task that the scenario makes N/A, and only an approved Change Control record of the same site
    const wrong = await admin.api.call('post', `/sites/${s.id}/scope-exceptions`, { task_code: 'B1', reason: REASON });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors[0]).toMatchObject({ path: '/task_code', code: 'not_na_by_scenario' });
    const u = await makeUser(db);
    const cc = await q<{ id: string }>(db, `INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, requested_by)
      VALUES ($1, $2, $3, 'scope_change', 'requested', NULL, $4) RETURNING id`, [`CC-${s.code}-scope`, s.id, s.region, u.id]);
    const notApproved = await admin.api.call('post', `/sites/${s.id}/scope-exceptions`, { task_code: 'MS4', reason: REASON, change_request_id: cc[0]!.id });
    expect(notApproved.status).toBe(422);
    expect(notApproved.body.errors[0]).toMatchObject({ path: '/change_request_id', code: 'change_not_approved' });
    await db.query(`UPDATE change_requests SET status = 'approved', approval_date = cal_today() WHERE id = $1`, [cc[0]!.id]);
    expect((await noStep.api.call('post', `/sites/${s.id}/scope-exceptions`, { task_code: 'MS4', reason: REASON })).status).toBe(401);
    const ok = await admin.api.call('post', `/sites/${s.id}/scope-exceptions`, { task_code: 'MS4', reason: REASON, change_request_id: cc[0]!.id });
    expect(ok.status).toBe(201);
    expect(ok.body.conflicts).toEqual([]);
    expect(ok.body.rfi).toMatchObject({ applies: true, master_rfi: true, differs: false });
    expect(appTask(ok.body, 'MS4')).toMatchObject({ applies: true, source: 'exception' });
    expect(ok.body.exceptions[0]).toMatchObject({ task_code: 'MS4', change_request_id: cc[0]!.id, revoked_at: null, approved_by: { id: admin.user.id } });
    const twice = await admin.api.call('post', `/sites/${s.id}/scope-exceptions`, { task_code: 'MS4', reason: REASON });
    expect(twice.status).toBe(422);
    expect((await admin.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON })).status).toBe(200);
    expect((await taskRow(db, s, 'MS4')).state).toBe('locked');                  // applies: the RFI stays in the flow
    expect((await taskRow(db, s, 'A1')).state).toBe('na');

    // revoking the exception brings the conflict back
    const rv = await admin.api.call('post', `/sites/${s.id}/scope-exceptions/${ok.body.exceptions[0].id}/revoke`, { reason: REASON });
    expect(rv.status).toBe(200);
    expect(rv.body.conflicts).toHaveLength(1);
    expect(rv.body.exceptions[0]).toMatchObject({ revoke_reason: REASON, revoked_by: { id: admin.user.id } });
    expect((await admin.api.call('post', `/sites/${s.id}/scope-exceptions/${ok.body.exceptions[0].id}/revoke`, { reason: REASON })).status).toBe(409);
    expect(await q(db, `SELECT action FROM audit_log WHERE site_id = $1 AND action LIKE 'scope_exception_%' ORDER BY id`, [s.id])).toEqual([
      { action: 'scope_exception_approve' }, { action: 'scope_exception_revoke' },
    ]);
  });

  it('enables a task again through a scope exception, never by marking it done', async () => {
    const s = await site('hot_swap');
    await allLocked(db, s);
    expect((await admin.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON })).status).toBe(200);
    expect((await taskRow(db, s, 'A1')).state).toBe('na');
    expect((await admin.api.call('post', `/sites/${s.id}/scope-exceptions`, { task_code: 'A1', reason: 'a new candidate is needed' })).status).toBe(201);
    const res = await admin.api.call('post', `/sites/${s.id}/applicability/apply`, { reason: REASON });
    expect(res.body.result.changed).toEqual([expect.objectContaining({ task_code: 'A1', from: 'na', to: 'open', source: 'exception' })]);
    const a1 = await taskRow(db, s, 'A1');
    expect(a1.state).toBe('open');                                               // A1 has no predecessor: it opens, it is not approved
    expect(a1.actual_date).toBeNull();
  });

  it('a site of another region is not found, and the baseline proposal follows the scenario for the Site RFI', async () => {
    const tri = await actor(app, db, { level: 'entry', regions: [1] });
    const s = await site('hot_swap', 5);
    expect((await tri.api.call('get', `/sites/${s.id}/applicability`)).status).toBe(404);
    await flags(s, `scope_gecol_power = 'yes'`);
    const nb = await site('new_build', 5);
    await flags(nb, `scope_gecol_power = 'yes'`);
    for (const x of [s, nb]) await makeTask(db, x, 'MS1', 'approved', { actualDate: await wd(db, -3) });
    const ms4 = async (x: Site) => (await q<{ d: string | null }>(db, `SELECT proposed_date::text AS d FROM baseline_proposal($1) WHERE milestone_code = 'MS4'`, [x.id]))[0]!.d;
    expect(await ms4(s)).toBeNull();
    expect(await ms4(nb)).not.toBeNull();
  });
});

describe('Q2: the D-1 start and the Swap exclusion', () => {
  it('does not measure D-1 for a Cold Swap: no clock, the task still applies', async () => {
    const s = await site('cold_swap');
    await makeTask(db, s, 'MS4', 'approved', { actualDate: await wd(db, -2) });
    const d1 = await makeTask(db, s, 'D1', 'locked');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [d1]);
    const t = await taskRow(db, s, 'D1');
    expect(t).toMatchObject({ state: 'open', sla_start_date: null, due_date: null, sla_rule_id: null });
    const g = await gridTask(s, 'D1');
    expect(g.sla).toMatchObject({ measured: false, colour: 'none', due_date: null });
  });

  it('starts from Site Release when the Site RFI is N/A, and waits (never today) while the applicable Site RFI has no date', async () => {
    const na = await site('new_build');
    const ms1 = await wd(db, -4);
    await makeTask(db, na, 'MS1', 'approved', { actualDate: ms1 });
    await makeTask(db, na, 'MS4', 'na');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [await makeTask(db, na, 'D1', 'locked')]);
    expect((await taskRow(db, na, 'D1')).sla_start_date).toBe(ms1);
    expect((await gridTask(na, 'D1')).sla).toMatchObject({ measured: true, start_event: 'MS4|MS1', start_date: ms1 });

    const waiting = await site('new_build');
    await makeTask(db, waiting, 'MS1', 'approved', { actualDate: ms1 });
    await makeTask(db, waiting, 'MS4', 'open');
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [await makeTask(db, waiting, 'D1', 'locked')]);
    expect((await taskRow(db, waiting, 'D1')).sla_start_date).toBeNull();      // a data gap, never MS1 and never today
  });
});

describe('Q135, Q14: the pending flag and the SLA sheet column map', () => {
  it('marks C-3 Pending SLA Confirmation in the rules and on its tasks', async () => {
    const rules = await admin.api.call('get', '/settings/sla-rules?task_code=C3');
    expect(rules.status).toBe(200);
    expect(rules.body.items[0]).toMatchObject({ task_code: 'C3', min_working_days: 0, max_working_days: 1, pending_confirmation: true, end_event: null });
    const d1 = await admin.api.call('get', '/settings/sla-rules?task_code=D1');
    expect(d1.body.items[0]).toMatchObject({ pending_confirmation: false });
    const s = await site('new_build');
    await makeTask(db, s, 'C3', 'open');
    expect((await gridTask(s, 'C3')).sla).toMatchObject({ pending_confirmation: true });
  });

  it('lists the 45 SLA columns D:AV, with B-10a and B-10b both on B10 and B-6 tagged inherited', async () => {
    expect((await plain.api.call('get', '/settings/sla-master-columns')).status).toBe(403);
    const res = await admin.api.call('get', '/settings/sla-master-columns');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(45);
    expect(res.body.items[0]).toMatchObject({ seq: 1, master_column: 'D', sla_code: 'A-1', task_code: 'A1' });
    expect(res.body.items[44]).toMatchObject({ seq: 45, master_column: 'AV', sla_code: 'S-5', task_code: 'E2' });
    const b10 = res.body.items.filter((c: { task_code: string }) => c.task_code === 'B10');
    expect(b10.map((c: { sla_code: string; flag_condition: string }) => [c.sla_code, c.flag_condition])).toEqual([['B-10a', 'rt_or_gf=RT'], ['B-10b', 'rt_or_gf=GF']]);
    expect(res.body.items.filter((c: { inherited: boolean }) => c.inherited).map((c: { sla_code: string }) => c.sla_code)).toEqual(['B-6']);
  });
});

describe('Q180 and Q9: suspension windows on effective dates, and the gate history', () => {
  const change = async (s: Site, kind: 'suspension' | 'resumption', approved: string, effective: string | null) => {
    const u = await makeUser(db);
    const col = kind === 'suspension' ? 'suspension_start' : 'resumption_date';
    await db.query(
      `INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, ${col}, requested_by) VALUES ($1, $2, $3, $4::"ChangeKind", 'approved', $5, $6, $7)`,
      [`CC-${s.code}-${kind}-${approved}`, s.id, s.region, kind, approved, effective, u.id],
    );
  };
  const gate = async (s: Site, code: string) =>
    (await q<{ status: string; gate_date: string | null; shifted: boolean }>(db, 'SELECT status, gate_date::text AS gate_date, shifted FROM gate_eval($1, $2)', [s.id, code]))[0]!;

  it('uses the effective dates (a retroactive suspension), keeps the earlier opening in the history and lists it newest first', async () => {
    const s = await site('new_build');
    const ms1 = await wd(db, -10);
    await makeTask(db, s, 'MS1', 'approved', { actualDate: ms1 });
    await db.query('SELECT calc_refresh_site($1)', [s.id]);
    expect(await gate(s, 'G2')).toMatchObject({ status: 'open', gate_date: ms1, shifted: false });
    // approved two days ago, effective twelve working days ago: the gate date lies inside the window
    await change(s, 'suspension', await wd(db, -2), await wd(db, -12));
    expect((await gate(s, 'G2')).status).toBe('blocked');
    const resume = await wd(db, -5);
    await change(s, 'resumption', await wd(db, -1), resume);
    expect(await gate(s, 'G2')).toMatchObject({ status: 'open', gate_date: resume, shifted: true });
    const w = await q<{ suspended_from: string; resumed_on: string; retroactive: boolean }>(db,
      `SELECT suspended_from::text AS suspended_from, resumed_on::text AS resumed_on, retroactive FROM cc_suspension_windows($1)`, [s.id]);
    expect(w).toEqual([{ suspended_from: await wd(db, -12), resumed_on: resume, retroactive: true }]);

    const ev = await admin.api.call('get', `/sites/${s.id}/gate-events?gate_code=G2`);
    expect(ev.status).toBe(200);
    expect(ev.body.items.map((e: { event: string }) => e.event)).toEqual(['opened', 'closed', 'opened']);
    expect(ev.body.items[2]).toMatchObject({ gate_code: 'G2', status: 'open', gate_date: ms1, shifted: false });
    expect(ev.body.items[1]).toMatchObject({ status: 'blocked', previous_date: ms1, gate_date: null });
    expect(ev.body.items[1].cause[0]).toMatchObject({ kind: 'suspension' });
    expect(ev.body.items[0]).toMatchObject({ gate_date: resume, shifted: true });
    expect((await admin.api.call('get', `/sites/${s.id}/gate-events?gate_code=X1`)).status).toBe(422);
  });

  it('treats the window as [start, resume): a resumption effective on the gate date leaves the gate unshifted', async () => {
    const s = await site('new_build');
    const ms1 = await wd(db, -10);
    await makeTask(db, s, 'MS1', 'approved', { actualDate: ms1 });
    await change(s, 'suspension', await wd(db, -14), null);                     // no effective date: the approval date
    await change(s, 'resumption', await wd(db, -8), ms1);                       // effective on the gate date itself
    expect(await gate(s, 'G2')).toMatchObject({ status: 'open', gate_date: ms1, shifted: false });
    const s2 = await site('new_build');
    await makeTask(db, s2, 'MS1', 'approved', { actualDate: ms1 });
    await change(s2, 'suspension', ms1, null);                                  // starts on the gate date: inside the window
    expect((await gate(s2, 'G2')).status).toBe('blocked');
  });
});

describe('D4b: tentative holidays count, and the due date shows a "tentative date" badge until it is confirmed', () => {
  it('marks the due date, says the official calendar is pending, and drops the badge on confirmation', async () => {
    const s = await site('new_build');
    await makeTask(db, s, 'MS4', 'approved', { actualDate: await wd(db, 0, 'cal_add_workdays(cal_add_workdays(cal_today(), 1), -1)') });
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [await makeTask(db, s, 'D1', 'locked')]);
    const before = (await taskRow(db, s, 'D1')).due_date as string;
    const day = await dbDate(db, `cal_add_workdays(DATE '${before}', -2)`);      // a working day inside the period, not yet a holiday
    const created = await admin.api.call('post', '/settings/holidays', { reason: 'expected date of the religious holiday', date: day, name_en: 'Synthetic Eid', kind: 'religious', tentative: true });
    expect(created.status).toBe(201);
    const after = (await taskRow(db, s, 'D1')).due_date as string;
    expect(after).toBe(await dbDate(db, `cal_add_workdays(DATE '${before}', 1)`));   // it counts as a holiday now
    const g = await gridTask(s, 'D1');
    expect(g.sla.due_date_tentative).toBe(true);
    expect(g.sla.tentative_holidays).toContain(day);
    const list = await admin.api.call('get', '/settings/holidays');
    expect(list.body.summary).toMatchObject({ official_calendar_pending: true, tentative_counted: true });

    const conf = await admin.api.call('post', `/settings/holidays/${created.body.holiday.id}/confirm`, { reason: 'official announcement' }, { 'If-Match': `"${created.body.holiday.version}"` });
    expect(conf.status).toBe(200);
    expect((await gridTask(s, 'D1')).sla.tentative_holidays).not.toContain(day);
    expect((await taskRow(db, s, 'D1')).due_date).toBe(after);                   // confirmed on the same date: nothing moves
  });
});

describe('Q13 and Q136: end events in a new rule-set version', () => {
  let oldC4: Site;

  it('refuses an unknown end event, then publishes C-4 ending at the in-service date and B-6 ending at the Layout Submitted Date', async () => {
    oldC4 = await site('new_build');
    await makeTask(db, oldC4, 'C3', 'approved', { actualDate: await wd(db, -9) });
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [await makeTask(db, oldC4, 'C4', 'locked')]);  // opened under version 1

    const draft = await admin.api.call('post', '/settings/sla-rule-sets', { reason: 'parallel run ended (synthetic)' });
    expect(draft.status).toBe(201);
    const pick = (code: string) => draft.body.rules.find((r: { task_code: string }) => r.task_code === code);
    expect(pick('C4')).toMatchObject({ end_event: 'hlc.installation_date' });
    const bad = await admin.api.call('patch', `/settings/sla-rule-sets/${draft.body.id}`,
      { reason: 'switch C-4', rules: [{ ...pick('C4'), end_event: 'hlc.nothing' }] }, { 'If-Match': String(draft.headers.etag) });
    expect(bad.status).toBe(422);
    const ok = await admin.api.call('patch', `/settings/sla-rule-sets/${draft.body.id}`, {
      reason: 'switch C-4 to the in-service date; measure the Layout Submitted Date',
      rules: [{ ...pick('C4'), end_event: 'hlc.in_service_date' }, { ...pick('B6'), end_event: 'task.layout_submitted_date' }],
    }, { 'If-Match': String(draft.headers.etag) });
    expect(ok.status).toBe(200);
    expect(ok.body.rules.find((r: { task_code: string }) => r.task_code === 'C4')).toMatchObject({ end_event: 'hlc.in_service_date' });
    expect(ok.body.rules.find((r: { task_code: string }) => r.task_code === 'C3')).toMatchObject({ pending_confirmation: true });   // kept from the version in force
    const pub = await admin.api.call('post', `/settings/sla-rule-sets/${draft.body.id}/publish`,
      { effective_date: await dbDate(db, 'cal_today()'), reason: 'parallel run ended (synthetic)' }, { 'If-Match': String(ok.headers.etag) });
    expect(pub.status).toBe(200);
    const rules = await admin.api.call('get', '/settings/sla-rules?task_code=C3');
    expect(rules.body.items[0]).toMatchObject({ pending_confirmation: true, set_version: 2 });
  });

  it('closes C-4 at the in-service date under the new version, and at the installation date under version 1', async () => {
    const fresh = await site('new_build');
    await makeTask(db, fresh, 'C3', 'approved', { actualDate: await wd(db, -9) });
    await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [await makeTask(db, fresh, 'C4', 'locked')]);
    const inst = await wd(db, -6);
    const svc = await wd(db, -3);
    for (const s of [fresh, oldC4]) {
      await db.query(`INSERT INTO hlc_records (site_id, region_id, installation_date, tx_link_tested_date, in_service_date) VALUES ($1, $2, $3, $3, $4)`, [s.id, s.region, inst, svc]);
      await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [await taskId(db, s, 'C4'), svc]);
    }
    expect((await taskRow(db, fresh, 'C4')).sla_end_date).toBe(svc);
    expect((await taskRow(db, oldC4, 'C4')).sla_end_date).toBe(inst);
  });

  it('ends B-6 at the Layout Submitted Date, never guessed from another date, and refuses a future one', async () => {
    const mk = async () => {
      const s = await site('new_build');
      await makeTask(db, s, 'B4', 'approved', { actualDate: await wd(db, -8) });
      await makeTask(db, s, 'B5', 'na');
      await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1`, [await makeTask(db, s, 'B6', 'locked')]);
      return s;
    };
    const withDate = await mk();
    const b6 = await taskId(db, withDate, 'B6');
    await expect(db.query(`UPDATE task_instances SET values = coalesce(values, '{}'::jsonb) || jsonb_build_object('layout_submitted_date', (cal_today() + 5)::text) WHERE id = $1`, [b6])).rejects.toThrow(/validation_failed/);
    await expect(db.query(`UPDATE task_instances SET values = coalesce(values, '{}'::jsonb) || '{"layout_submitted_date": "not a date"}'::jsonb WHERE id = $1`, [b6])).rejects.toThrow(/invalid_date/);
    const layout = await wd(db, -4);
    await db.query(`UPDATE task_instances SET values = coalesce(values, '{}'::jsonb) || jsonb_build_object('layout_submitted_date', $2::text) WHERE id = $1`, [b6, layout]);
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [b6, await wd(db, -2)]);
    expect(await taskRow(db, withDate, 'B6')).toMatchObject({ sla_end_date: layout, sla_elapsed_wd: 4 });
    expect((await gridTask(withDate, 'B6')).sla).toMatchObject({ end_event: 'task.layout_submitted_date', elapsed_wd: 4 });

    const without = await mk();
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [await taskId(db, without, 'B6'), await wd(db, -2)]);
    expect(await taskRow(db, without, 'B6')).toMatchObject({ sla_end_date: null, sla_elapsed_wd: null });   // a data gap, not the actual date
  });

  it('accepts the Layout Submitted Date through the task entry and answers 422 for a future one', async () => {
    const s = await site('new_build');
    await makeTask(db, s, 'B4', 'approved', { actualDate: await wd(db, -8) });
    const id = await makeTask(db, s, 'B6', 'open');
    const e = await actor(app, db, { level: 'entry' });
    await setCell(db, 'B6', 5, 'entry', { user: [e.user.id] });
    const t = (await e.api.call('get', `/tasks/${id}`)).body;
    const bad = await e.api.call('patch', `/tasks/${id}`, { values: { layout_submitted_date: await dbDate(db, 'cal_today() + 3') } }, { 'If-Match': `"${t.version}"` });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/values/layout_submitted_date', code: 'future_date' });
    const day = await wd(db, -1);
    const ok = await e.api.call('patch', `/tasks/${id}`, { values: { layout_submitted_date: day } }, { 'If-Match': `"${t.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.values).toMatchObject({ layout_submitted_date: day });
  });
});

describe('Settings: scenario rules', () => {
  it('lists the rules with an ETag, refuses bad input and a stale version, and replaces the list (step-up, reason, audited)', async () => {
    expect((await plain.api.call('get', '/settings/scenario-rules')).status).toBe(403);
    const res = await admin.api.call('get', '/settings/scenario-rules');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
    expect(res.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_code: 'A1', scenario: 'hot_swap', rule: 'na' }),
      expect.objectContaining({ task_code: 'D1', scenario: 'cold_swap', rule: 'sla_not_measured' }),
      expect.objectContaining({ task_code: 'MS4', scenario: null, rule: 'flag', flag_expr: 'rfi' }),
    ]));
    const rules = res.body.items.map((r: Record<string, unknown>) => ({ task_code: r.task_code, scenario: r.scenario, rule: r.rule, flag_expr: r.flag_expr, reason: r.reason }));
    const etag = String(res.headers.etag);
    expect((await admin.api.call('put', '/settings/scenario-rules', { reason: REASON, rules })).status).toBe(428);
    expect((await noStep.api.call('put', '/settings/scenario-rules', { reason: REASON, rules }, { 'If-Match': etag })).status).toBe(401);
    const bad = await admin.api.call('put', '/settings/scenario-rules', {
      reason: REASON, rules: [...rules, { task_code: 'B1', scenario: null, rule: 'flag', flag_expr: null, reason: 'missing flag' }, { task_code: 'ZZ9', scenario: null, rule: 'na', flag_expr: null, reason: 'unknown task' }],
    }, { 'If-Match': etag });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { code: string }) => e.code)).toEqual(expect.arrayContaining(['duplicate', 'invalid', 'unknown_task_code']));
    const next = [...rules.filter((r: { task_code: string; scenario: string | null }) => !(r.task_code === 'A3' && r.scenario === 'hot_swap')),
      { task_code: 'A3', scenario: 'hot_swap', rule: 'applies', flag_expr: null, reason: 'the owner contract is renewed on Swap sites (synthetic)' }];
    const put = await admin.api.call('put', '/settings/scenario-rules', { reason: REASON, rules: next }, { 'If-Match': etag });
    expect(put.status).toBe(200);
    expect(put.body.version).toBe(res.body.version + 1);
    expect(put.body.items.find((r: { task_code: string; scenario: string }) => r.task_code === 'A3' && r.scenario === 'hot_swap')).toMatchObject({ rule: 'applies' });
    expect((await admin.api.call('put', '/settings/scenario-rules', { reason: REASON, rules: next }, { 'If-Match': etag })).status).toBe(412);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'scenario_rules_update' AND reason = $1`, [REASON])).toHaveLength(1);
    // the new rule reaches a site only when its applicability is applied
    const s = await site('hot_swap');
    await allLocked(db, s);
    const a = await admin.api.call('get', `/sites/${s.id}/applicability`);
    expect(appTask(a.body, 'A3')).toMatchObject({ applies: true, source: 'scenario' });
    expect((await taskRow(db, s, 'A3')).state).toBe('locked');
  });
});
