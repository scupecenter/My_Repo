import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbDate, newSite, open, q, taskRow, wd } from './calc-helpers';
import { loadConfig } from '../src/config/config';
import { JobsService } from '../src/jobs/jobs.service';
import { startApp, superDbCalc2 } from './helpers';
import { actor, makeTask, plainAdmin, setCell } from './wf-helpers';
import type { Actor, Site } from './wf-helpers';

/**
 * Migration 0018, owner answers Q76 to Q82 (the calculation layer). The whole file runs in its own database (TEST_DATABASE_URL_CALC2, see
 * global-setup) because it changes settings that the other calculation suites must not meet (the gate-lock exempt list, the CW DLP days).
 * Dates are counted back from `wd(db, -n)`: the n-th working day before today, so the suite holds on a Friday or a Saturday (weekend days here).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_CALC2 as string });
  db = await superDbCalc2();
  admin = await plainAdmin(app, db, true);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const permit = (site: Site, type: string, o: { status?: string; from?: string | null; to?: string | null; stop?: boolean; lifted?: string | null; hse?: object | null } = {}) =>
  db.query(
    `INSERT INTO permit_records (site_id, region_id, permit_type, status, valid_from, valid_to, stop_work, stop_lifted_date, hse_checks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [site.id, site.region, type, o.status ?? 'Approved', o.from ?? null, o.to ?? null, o.stop ?? false, o.lifted ?? null, o.hse ? JSON.stringify(o.hse) : null],
  );

const gate = async (site: Site, code: string) =>
  (await q<{ status: string; gate_date: string | null; reasons: { kind: string; ref_code: string | null }[] }>(db, 'SELECT status, gate_date::text AS gate_date, reasons FROM gate_eval($1, $2)', [site.id, code]))[0]!;

const setting = async (key: string): Promise<unknown> => (await q<{ value: unknown }>(db, 'SELECT value FROM settings WHERE key = $1', [key]))[0]?.value;
const setSetting = (key: string, value: unknown) =>
  db.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);

const unlock = async (id: string): Promise<string[]> => (await q<{ ids: string[] }>(db, 'SELECT wf_unlock_successors($1) AS ids', [id]))[0]!.ids;

/** A site at the gate CW Readiness (G3): PRE-CW done, Layout approval (B7) done, the two MOS tasks (B8, B9) locked behind the gate, no permits yet. */
async function g3Site(): Promise<{ site: Site; b7: string; b8: string; b9: string; b7Day: string }> {
  const site = await newSite(db);
  const b7Day = await wd(db, -5);
  await makeTask(db, site, 'MS2', 'approved', { actualDate: await wd(db, -6) });
  const b7 = await makeTask(db, site, 'B7', 'approved', { actualDate: b7Day });
  const b8 = await makeTask(db, site, 'B8', 'locked');
  const b9 = await makeTask(db, site, 'B9', 'locked');
  return { site, b7, b8, b9, b7Day };
}

describe('Q76: every calculated milestone takes the later of its conditions and its gate', () => {
  it('has the empty list in calc.milestone_ge_gate, so no milestone stays blank', async () => {
    expect(await setting('calc.milestone_ge_gate')).toEqual([]);
  });
});

describe('Q77: Commissioning Power Safe stays yes/no and gate G6 has no condition on it', () => {
  it('opens the On-Air Readiness gate on the TE Completion date whatever the yes/no says', async () => {
    const conds = await q<{ link_code: string; conditions: unknown }>(db, `SELECT link_code, conditions FROM phase_gate_rules WHERE link_code = 'G6' AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1)`);
    expect(conds[0]!.conditions === null || (Array.isArray(conds[0]!.conditions) && conds[0]!.conditions.length === 0)).toBe(true);
    const every = await q<{ c: string }>(db, `SELECT conditions::text AS c FROM phase_gate_rules WHERE conditions IS NOT NULL`);
    expect(every.some((r) => /power/i.test(r.c))).toBe(false);          // no gate asks for it
    const site = await newSite(db);
    const ms5 = await wd(db, -4);
    await makeTask(db, site, 'MS5', 'approved', { actualDate: ms5 });
    for (const v of [false, null, true]) {
      await db.query(
        `INSERT INTO readiness_handover (site_id, region_id, commissioning_power_safe) VALUES ($1, $2, $3)
         ON CONFLICT (site_id) DO UPDATE SET commissioning_power_safe = EXCLUDED.commissioning_power_safe`, [site.id, site.region, v]);
      expect(await gate(site, 'G6')).toMatchObject({ status: 'open', gate_date: ms5 });
    }
    // the field is still a yes/no
    const col = await q<{ data_type: string }>(db, `SELECT data_type FROM information_schema.columns WHERE table_name = 'readiness_handover' AND column_name = 'commissioning_power_safe'`);
    expect(col[0]!.data_type).toBe('boolean');
  });
});

describe('Q78: the PTW HSE checks are information only; stop work still holds the gate', () => {
  it('does not evaluate the HSE checks, even if the old setting is put back', async () => {
    const hits = await q<{ proname: string }>(db, `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosrc ILIKE '%hse_checks%' AND p.proname <> 'reg_apply'`);  // reg_apply only stores the register value
    expect(hits).toEqual([]);                                                // no function of the database reads them
    expect(await setting('calc.ptw_hse_check_keys')).toBeUndefined();         // the setting that asked for them is gone
    await setSetting('calc.ptw_hse_check_keys', ['jsa_tra', 'toolbox_talk']);
    try {
      const { site } = await g3Site();
      await permit(site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
      await permit(site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30), hse: { jsa_tra: 'Open', toolbox_talk: 'Open', work_at_height: 'Open' } });
      const g = await gate(site, 'G3');
      expect(g.status).toBe('open');                                          // every HSE check is still Open and the gate does not care
      expect((await q<{ d: string }>(db, `SELECT permit_start(p)::text AS d FROM permit_records p WHERE site_id = $1 AND permit_type = 'PTW - CW'`, [site.id]))[0]!.d).toBe(await wd(db, -7));
    } finally {
      await db.query(`DELETE FROM settings WHERE key = 'calc.ptw_hse_check_keys'`);
    }
  });

  it('still holds the gate while a stop work is active, and releases it on the lift date', async () => {
    const { site } = await g3Site();
    await permit(site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    await permit(site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30), stop: true, hse: { jsa_tra: 'Done' } });
    const g = await gate(site, 'G3');
    expect(g.status).toBe('blocked');
    expect(g.reasons.map((r) => r.kind)).toContain('stop_work');
    await db.query(`UPDATE permit_records SET stop_lifted_date = $2 WHERE site_id = $1 AND permit_type = 'PTW - CW'`, [site.id, await wd(db, -3)]);
    expect((await gate(site, 'G3')).status).toBe('open');
  });
});

describe('Q80: the SLA of B-15 (CW FAC) starts from the CW PAC date + 90 calendar days', () => {
  it('has the setting sla.dlp_days.cw = 90 and the new start event on B-15 only; the TE FAC keeps the Master months', async () => {
    expect(await setting('sla.dlp_days.cw')).toBe(90);
    const r = await q<{ code: string; start_ref: string }>(db, `SELECT DISTINCT code COLLATE "C" AS code, start_ref FROM sla_rules WHERE code IN ('B-15', 'B06') ORDER BY 1`);
    expect(r).toEqual([{ code: 'B-15', start_ref: 'DLPD:B13:sla.dlp_days.cw' }, { code: 'B06', start_ref: 'DLP:D16:dlp.months.te' }]);
    const items = await q<{ start_ref: string }>(db, `SELECT start_ref FROM sla_rule_set_items WHERE code = 'B-15'`);
    expect(items.every((i) => i.start_ref === 'DLPD:B13:sla.dlp_days.cw')).toBe(true);
    expect((await q<{ v: boolean }>(db, `SELECT sla_start_ref_valid('DLPD:B13:sla.dlp_days.cw', (SELECT id FROM workflow_definitions WHERE version = 1)) AS v`))[0]!.v).toBe(true);
    expect((await q<{ v: boolean }>(db, `SELECT sla_start_ref_valid('DLPD:NOPE:sla.dlp_days.cw', (SELECT id FROM workflow_definitions WHERE version = 1)) AS v`))[0]!.v).toBe(false);
  });

  it('starts the clock of B-15 on the PAC date plus 90 calendar days, and follows the setting', async () => {
    const site = await newSite(db);
    const pac = await wd(db, -9);
    await makeTask(db, site, 'B13', 'approved', { actualDate: pac });
    await makeTask(db, site, 'B14', 'approved', { actualDate: pac });
    const b15 = await makeTask(db, site, 'B15', 'locked');
    await open(db, b15);
    const row = await taskRow(db, site, 'B15');
    expect(row.sla_start_date).toBe(await dbDate(db, `DATE '${pac}' + 90`));
    expect(row.due_date).toBe(await dbDate(db, `cal_add_workdays(DATE '${pac}' + 90, 10)`));
    // another number of days
    await setSetting('sla.dlp_days.cw', 60);
    try {
      const s2 = await newSite(db);
      await makeTask(db, s2, 'B13', 'approved', { actualDate: pac });
      const id2 = await makeTask(db, s2, 'B15', 'locked');
      await open(db, id2);
      expect((await taskRow(db, s2, 'B15')).sla_start_date).toBe(await dbDate(db, `DATE '${pac}' + 60`));
    } finally {
      await setSetting('sla.dlp_days.cw', 90);
    }
    // the TE FAC (B06) still counts 12 months from the TE PAC, as the Master (EDATE)
    const te = await newSite(db);
    await makeTask(db, te, 'D16', 'approved', { actualDate: pac });
    const d18 = await makeTask(db, te, 'D18', 'locked');
    await open(db, d18);
    expect((await taskRow(db, te, 'D18')).sla_start_date).toBe(await dbDate(db, `(DATE '${pac}' + interval '12 months')::date`));
  });
});

describe('Q81: a gate locks the tasks of the next stage until it opens', () => {
  it('keeps the next stage locked while the permits are missing, and shows gate_closed with the gate code and its reasons', async () => {
    const f = await g3Site();
    expect(await unlock(f.b7)).toEqual([]);                                  // B8 and B9 have no open predecessor left, but the gate is closed
    for (const id of [f.b8, f.b9]) {
      const row = (await q<{ state: string; lock_reason: string }>(db, `SELECT state::text AS state, lock_reason FROM task_instances WHERE id = $1`, [id]))[0]!;
      expect(row).toMatchObject({ state: 'locked', lock_reason: 'gate_closed:G3' });
    }
    const res = await admin.api.call('get', `/tasks/${f.b8}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('locked');
    const reasons = res.body.lock_reasons as { kind: string; ref_code: string | null; message: string }[];
    expect(reasons[0]).toMatchObject({ kind: 'gate_closed', ref_code: 'G3' });
    expect(reasons[0]!.message).toMatch(/Access - CW/);
    expect(reasons.filter((r) => r.kind === 'condition_not_met').map((r) => r.ref_code).sort()).toEqual(['Access - CW', 'PTW - CW']);
    expect(res.body.sla.start_date).toBeNull();                              // no clock yet
  });

  it('opens them when the gate opens: unlocked by the existing mechanism, SLA clocks started, audited', async () => {
    const f = await g3Site();
    await unlock(f.b7);
    await permit(f.site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    expect((await taskRow(db, f.site, 'B8')).state).toBe('locked');          // PTW - CW is still missing
    await permit(f.site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    for (const code of ['B8', 'B9']) {
      const t = await taskRow(db, f.site, code);
      expect(t.state).toBe('open');
      expect(t.lock_reason).toBeNull();
      expect(t.sla_start_date).toBe(f.b7Day);                                // B-8 and B-9 start from the layout approval
      expect(t.due_date).not.toBeNull();
    }
    const audit = await q<{ reason: string; before: { state: string }; after: { state: string } }>(db,
      `SELECT reason, before, after FROM audit_log WHERE action = 'task_unlock' AND entity_id = $1`, [f.b8]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'gate G3 is open', before: { state: 'locked' }, after: { state: 'open' } });
    const view = await admin.api.call('get', `/tasks/${f.b8}`);
    expect(view.body.state).toBe('open');
    expect(view.body.lock_reasons).toEqual([]);
  });

  it('does not lock the GECOL and HLC tasks (C1 to C4), and the exempt list is a setting', async () => {
    expect(await setting('calc.gate_lock_exempt_tasks')).toEqual(['C1', 'C2', 'C3', 'C4']);
    const site = await newSite(db);
    const b1 = await makeTask(db, site, 'B1', 'approved', { actualDate: await wd(db, -4) });
    const c1 = await makeTask(db, site, 'C1', 'locked');
    const c3 = await makeTask(db, site, 'C3', 'locked');
    const b2 = await makeTask(db, site, 'B2', 'locked');                     // not exempt: its gate G2 has no Site Release date
    expect((await unlock(b1)).sort()).toEqual([c1, c3].sort());
    expect((await taskRow(db, site, 'B2')).state).toBe('locked');
    expect((await taskRow(db, site, 'B2')).lock_reason).toBe('gate_closed:G2');
    expect(b2).toBeTruthy();
    // a prefix entry covers every task whose code starts with it; the held task opens when the next unlock runs
    const ms4Site = await newSite(db);
    const ms4 = await makeTask(db, ms4Site, 'MS4', 'approved', { actualDate: await wd(db, -3) });
    const d1 = await makeTask(db, ms4Site, 'D1', 'locked');
    expect(await unlock(ms4)).toEqual([]);                                   // G5 needs the TE permits
    await setSetting('calc.gate_lock_exempt_tasks', ['C*', 'D1']);
    try {
      expect(await unlock(ms4)).toEqual([d1]);
      expect((await taskRow(db, ms4Site, 'D1')).state).toBe('open');
    } finally {
      await setSetting('calc.gate_lock_exempt_tasks', ['C1', 'C2', 'C3', 'C4']);
    }
  });

  it('respects the gate when a task is approved through the API, and opens the held tasks when the permits come', async () => {
    const f = await g3Site();
    await db.query(`DELETE FROM task_instances WHERE id = $1`, [f.b7]);       // B7 is done through the engine instead
    const b7 = await makeTask(db, f.site, 'B7', 'open', { actualDate: f.b7Day });
    const one = await actor(app, db, { level: 'approve' });                   // one person holds the three levels: self-approval with step-up
    for (const kind of ['entry', 'review', 'approve'] as const) await setCell(db, 'B7', f.site.region, kind, { user: [one.user.id] });
    const call = (verb: string, version: number | string) => one.api.call('post', `/tasks/${b7}/${verb}`, {}, { 'If-Match': `"${version}"` });
    let res = await call('start', (await one.api.call('get', `/tasks/${b7}`)).body.version);
    expect(res.status).toBe(200);
    res = await call('submit', res.body.task.version);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('approved');
    expect(res.body.unlocked_task_ids).toEqual([]);                           // the gate holds B8 and B9
    expect((await taskRow(db, f.site, 'B8')).state).toBe('locked');
    await permit(f.site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    await permit(f.site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    expect((await taskRow(db, f.site, 'B8')).state).toBe('open');
    expect((await taskRow(db, f.site, 'B9')).state).toBe('open');
  });

  it('does not re-lock tasks that are already open when the gate closes again: it only raises an alert', async () => {
    const f = await g3Site();
    await unlock(f.b7);
    await permit(f.site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    await permit(f.site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    expect((await taskRow(db, f.site, 'B8')).state).toBe('open');
    const alerts = () => q<{ user_id: string }>(db, `SELECT user_id::text AS user_id FROM notifications WHERE kind = 'gate_closed_again' AND title LIKE $1`, [`%${f.site.code}`]);
    expect(await alerts()).toEqual([]);                                       // nothing yet
    // a new stop work on the PTW
    await permit(f.site, 'PTW - CW', { from: await wd(db, -2), to: await wd(db, 30), stop: true });
    expect((await gate(f.site, 'G3')).status).toBe('blocked');
    for (const code of ['B8', 'B9']) expect((await taskRow(db, f.site, code)).state).toBe('open');   // not re-locked
    const sent = await alerts();
    expect(sent.map((r) => r.user_id)).toContain(admin.user.id);              // the System Admins are told
    const audit = await q<{ after: { gate: string; open_tasks_kept_open: number } }>(db, `SELECT after FROM audit_log WHERE action = 'gate_closed_again' AND entity_id = $1`, [f.site.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ gate: 'G3', open_tasks_kept_open: 2 });
    // refreshing again, or one more register change, does not repeat the alert
    await db.query('SELECT calc_refresh_site($1)', [f.site.id]);
    await db.query(`UPDATE permit_records SET remark = 'seen' WHERE site_id = $1`, [f.site.id]);
    expect((await alerts()).length).toBe(sent.length);
    // the stop work is lifted: the gate is open again and the tasks were never touched
    await db.query(`UPDATE permit_records SET stop_lifted_date = $2 WHERE site_id = $1 AND stop_work`, [f.site.id, await wd(db, -1)]);
    expect((await gate(f.site, 'G3')).status).toBe('open');
    expect((await alerts()).length).toBe(sent.length);
  });

  it('sends the alert to the stage lead as well', async () => {
    const f = await g3Site();
    const lead = await actor(app, db, { level: 'approve', stepUp: false });
    await setCell(db, 'B8', f.site.region, 'approve', { user: [lead.user.id] });
    await unlock(f.b7);
    await permit(f.site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    await permit(f.site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    await permit(f.site, 'PTW - CW', { from: await wd(db, -2), to: await wd(db, 30), stop: true });
    const sent = await q<{ user_id: string }>(db, `SELECT user_id::text AS user_id FROM notifications WHERE kind = 'gate_closed_again' AND title LIKE $1`, [`%${f.site.code}`]);
    expect(sent.map((r) => r.user_id)).toContain(lead.user.id);
  });

  it('answers 404 to a user outside the region, as for any task', async () => {
    const f = await g3Site();
    await unlock(f.b7);
    const other = await actor(app, db, { level: 'entry', regions: [1] });
    expect((await other.api.call('get', `/tasks/${f.b8}`)).status).toBe(404);
  });
});

describe('Q82: the SLA clock closes at the actual date; a negative duration is a data-quality alert', () => {
  it('flags an actual date before the start: negative elapsed days, a notification to the System Admins and the stage lead, an audit row, and sla.negative in the API', async () => {
    const lead = await actor(app, db, { level: 'approve', stepUp: false });
    const site = await newSite(db);
    await setCell(db, 'A2', site.region, 'approve', { user: [lead.user.id] });
    const id = await makeTask(db, site, 'A2', 'locked');
    await open(db, id);
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [id, await wd(db, -3)]);
    const row = await taskRow(db, site, 'A2');
    expect(row.sla_start_date).toBe(await dbDate(db, 'cal_today()'));
    expect(row.sla_end_date).toBe(await wd(db, -3));                          // the clock closes at the actual date
    expect(Number(row.sla_elapsed_wd)).toBeLessThan(0);
    const audit = await q<{ before: { sla_start_date: string }; after: { sla_elapsed_wd: number } }>(db, `SELECT before, after FROM audit_log WHERE action = 'sla_negative_duration' AND entity_id = $1`, [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after.sla_elapsed_wd).toBe(Number(row.sla_elapsed_wd));
    expect(audit[0]!.before.sla_start_date).toBe(row.sla_start_date);
    const who = (await q<{ user_id: string }>(db, `SELECT user_id::text AS user_id FROM notifications WHERE kind = 'sla_negative_duration' AND task_id = $1`, [id])).map((r) => r.user_id);
    expect(who).toContain(admin.user.id);
    expect(who).toContain(lead.user.id);
    expect(new Set(who).size).toBe(who.length);                               // once each
    const view = await admin.api.call('get', `/tasks/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.sla.negative).toBe(true);
    expect(view.body.sla.elapsed_wd).toBeLessThan(0);
  });

  it('raises nothing for a task closed on or after its start', async () => {
    const site = await newSite(db);
    const ok = await makeTask(db, site, 'A2', 'locked');
    await open(db, ok);
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = cal_today(), approved_date = cal_today() WHERE id = $1`, [ok]);
    expect(Number((await taskRow(db, site, 'A2')).sla_elapsed_wd)).toBe(0);
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'sla_negative_duration' AND entity_id = $1`, [ok])).toHaveLength(0);
    expect(await q(db, `SELECT 1 FROM notifications WHERE kind = 'sla_negative_duration' AND task_id = $1`, [ok])).toHaveLength(0);
    const view = await admin.api.call('get', `/tasks/${ok}`);
    expect(view.body.sla.negative).toBe(false);
  });
});

describe('Q84: the daily job applies due SLA versions and reminds the System Admins of tentative holidays 14 days ahead', () => {
  const jobs = () => app.get(JobsService);
  const addHoliday = async (name: string, offsetDays: number, over: { tentative?: boolean; confirmed?: boolean } = {}): Promise<string> => {
    const r = await db.query(
      `INSERT INTO holidays (calendar_id, date, name, kind, tentative, confirmed_at) VALUES (cal_default(), cal_today() + $2::int, $1, 'religious', $3, $4) RETURNING date::text AS d`,
      [name, offsetDays, over.tentative ?? true, over.confirmed ? new Date() : null]);
    return r.rows[0].d as string;
  };
  const reminders = (date: string) => q<{ user_id: string }>(db, `SELECT user_id::text AS user_id FROM notifications WHERE kind = 'holiday_tentative' AND link = $1`, ['/admin/settings/calendar?date=' + date]);

  it('is off in the test configuration, and loadConfig defaults it on except in tests', () => {
    expect(jobs().enabled).toBe(false);
    expect(jobs().nextRun).toBeNull();
    const env = { DATABASE_URL: 'postgresql://x', LOG_HMAC_KEY: 'a'.repeat(32) };
    expect(loadConfig({ ...env, NODE_ENV: 'production' }).jobsEnabled).toBe(true);
    expect(loadConfig({ ...env, NODE_ENV: 'test' }).jobsEnabled).toBe(false);
    expect(loadConfig({ ...env, NODE_ENV: 'production', JOBS_ENABLED: 'false' }).jobsEnabled).toBe(false);
    expect(loadConfig({ ...env, NODE_ENV: 'test', JOBS_ENABLED: 'true' }).jobsEnabled).toBe(true);
    expect(() => loadConfig({ ...env, JOBS_ENABLED: 'maybe' })).toThrow(/JOBS_ENABLED/);
  });

  it('reminds every System Admin once for a tentative holiday within 14 days, and not for the others; a second run the same day adds nothing', async () => {
    const soon = await addHoliday('Tentative feast (test, soon)', 5);
    const edge = await addHoliday('Tentative feast (test, 14 days)', 14);
    const far = await addHoliday('Tentative feast (test, far)', 40);
    const confirmed = await addHoliday('Confirmed feast (test)', 6, { tentative: true, confirmed: true });
    const fixed = await addHoliday('Fixed feast (test)', 7, { tentative: false });
    const admins = (await q<{ id: string }>(db, `SELECT DISTINCT gm.user_id::text AS id FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
      JOIN users u ON u.id = gm.user_id AND u.status = 'active' AND NOT u.is_break_glass`)).map((r) => r.id).sort();
    expect(admins).toContain(admin.user.id);
    const first = await jobs().runOnce();
    expect(first).not.toBeNull();
    expect(first!.reminders).toBeGreaterThanOrEqual(admins.length * 2);
    for (const d of [soon, edge]) expect((await reminders(d)).map((r) => r.user_id).sort()).toEqual(admins);
    for (const d of [far, confirmed, fixed]) expect(await reminders(d)).toEqual([]);
    const count = async () => (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM notifications WHERE kind = 'holiday_tentative'`))[0]!.n;
    const before = await count();
    const second = await jobs().runOnce();
    expect(second).toEqual({ slaApplied: 0, reminders: 0 });
    expect(await count()).toBe(before);
    // a holiday that moves outside the window is not reminded, and one that is confirmed is not either
    await db.query(`UPDATE holidays SET confirmed_at = now(), tentative = false WHERE date = $1`, [soon]);
    await db.query(`UPDATE holidays SET date = date + 20 WHERE date = $1`, [edge]);
    expect((await jobs().runOnce())!.reminders).toBe(0);
    expect(await count()).toBe(before);
  });

  it('applies the SLA versions whose date has come, once', async () => {
    const v1 = (await q<{ id: string }>(db, `SELECT id::text AS id FROM sla_rule_sets WHERE version = 1`))[0]!.id;
    await db.query(`UPDATE sla_rule_sets SET apply_pending = true WHERE id = $1`, [v1]);       // published with "apply to open tasks" and its day has arrived
    const count = async () => (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'sla_rule_set_apply' AND entity_id = $1`, [v1]))[0]!.n;
    const n0 = await count();
    expect(await jobs().runOnce()).not.toBeNull();
    expect(await count()).toBe(n0 + 1);
    expect((await q<{ p: boolean }>(db, `SELECT apply_pending AS p FROM sla_rule_sets WHERE id = $1`, [v1]))[0]!.p).toBe(false);
    await jobs().runOnce();
    expect(await count()).toBe(n0 + 1);                                                          // nothing extra the second time
  });

  it('runs once at start-up when JOBS_ENABLED is on and schedules the next run at 02:00 Africa/Tripoli', async () => {
    const on = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_CALC2 as string, jobsEnabled: true });
    try {
      const svc = on.get(JobsService);
      expect(svc.enabled).toBe(true);
      for (let i = 0; i < 100 && svc.lastRun === null; i++) await new Promise((r) => setTimeout(r, 50));
      expect(svc.lastRun).not.toBeNull();
      expect(svc.lastRun!.error).toBeUndefined();
      expect(svc.nextRun!.getTime()).toBeGreaterThan(Date.now());
      expect(svc.nextRun!.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
      expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tripoli', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(svc.nextRun!)).toBe('02:00');
    } finally {
      await on.close();
    }
  });
});
