import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, q } from './calc-helpers';
import { startApp, superDbGmp } from './helpers';
import { SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0133 (owner decisions 2026-11-22), on ANY site (not only a historical load):
 *   1. a phase gate the site moved past (a task the gate holds, or a later one, approved with an actual date) is open as an admin override of the site (kind
 *      gate_moved_past_open), the permits stay unrecorded, the engine opens the held tasks and calculates the milestones; a stop work in force still holds it;
 *   2. MW alignment (D8) is N/A (kind no_microwave_na) when the site's TE installation D6 is approved with no MW antenna; never a D8 with a date, a measured
 *      value or a human workflow step, never when D6 has an MW antenna or is not approved.
 * Both run in the calculation path (calc_refresh_site) and once in the migration (gmp_backfill); both are taken back by POST /overrides/{id}/revert (System
 * Admin, reason, step-up) and never applied again. Its own database (TEST_DATABASE_URL_GMP): the backfill reads every active site. Synthetic data only. Region 6.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 6;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_GMP as string });
  db = await superDbGmp();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

interface TaskRow { id: string; code: string; state: string; actual_date: string | null; lock_reason: string | null; na_reason: string | null; nmw: boolean; override: boolean }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT t.id::text AS id, td.code, t.state::text AS state, t.actual_date::text AS actual_date, t.lock_reason, t.na_reason, t.no_microwave_na AS nmw,
          t.admin_override AS override
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const gate = async (siteId: string, g: string) => (await q<{ status: string; reasons: { kind: string }[] }>(db,
  'SELECT status, reasons FROM gate_eval($1, $2)', [siteId, g]))[0]!;
const overrides = async (siteId: string, kind: string) => q<{ id: string; entity: string; task_id: string | null; after: Record<string, any>; reverted: boolean; acted_by: string | null }>(db,
  `SELECT id::text AS id, entity, task_id::text AS task_id, after, reverted_at IS NOT NULL AS reverted, acted_by::text AS acted_by FROM admin_overrides
   WHERE site_id = $1 AND kind = $2 ORDER BY created_at`, [siteId, kind]);
const audits = async (action: string, siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND site_id = $2', [action, siteId]))[0]!.n;
const refresh = (siteId: string) => db.query('SELECT calc_refresh_site($1)', [siteId]);

/**
 * A live site past Site RFI: the TE work D1..D5 approved, D6 (TE installation) waiting for its approval, TE Completion (MS5) held by the gate G5 for want of
 * the TE permits (none recorded), D7, D9 and the On-Air tasks approved, D8 (MW alignment) open with no date, On-Air (MS6) locked. `mw` is D6's MW antenna.
 */
async function teSite(prefix: string, mw: unknown, o: { d8?: { state?: string; date?: string | null; values?: Record<string, unknown> } } = {}): Promise<Site> {
  const s = await makeSite(db, R, { prefix, status: 'in_progress' });
  await makeTask(db, s, 'MS4', 'approved', { actualDate: '2026-03-01' });
  for (const [c, d] of [['D1', '2026-03-03'], ['D2', '2026-03-05'], ['D3', '2026-03-06'], ['D4', '2026-03-07'], ['D4b', '2026-03-08'], ['D5', '2026-03-09']] as const) {
    await makeTask(db, s, c, 'approved', { actualDate: d });
  }
  const d6 = await makeTask(db, s, 'D6', 'open');
  if (mw !== undefined) await db.query(`UPDATE task_instances SET values = jsonb_build_object('mw_antenna', $2::jsonb) WHERE id = $1`, [d6, JSON.stringify(mw)]);
  await makeTask(db, s, 'MS5', 'locked');
  await db.query(`UPDATE task_instances t SET lock_reason = 'gate_closed:G5' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS5' AND t.site_id = $1`, [s.id]);
  await makeTask(db, s, 'D7', 'approved', { actualDate: '2026-03-20' });
  const d8 = await makeTask(db, s, 'D8', o.d8?.state ?? 'open', { actualDate: o.d8?.date ?? null });
  if (o.d8?.values) await db.query('UPDATE task_instances SET values = $2 WHERE id = $1', [d8, JSON.stringify(o.d8.values)]);
  for (const [c, d] of [['D9', '2026-03-24'], ['D10a', '2026-03-25'], ['D10b', '2026-03-26'], ['D10', '2026-03-28']] as const) {
    await makeTask(db, s, c, 'approved', { actualDate: d });
  }
  await makeTask(db, s, 'MS6', 'locked');
  return s;
}

describe('0133: a gate the site moved past is open, MW alignment is N/A without microwave (any site)', () => {
  let admin: Actor;
  let main: Site;

  it('(a) D6 approved through the approve step while G5 waits for unrecorded permits: G5 opens as an admin override, TE Completion is calculated, D8 is N/A (no MW antenna), On-Air follows', async () => {
    admin = await plainAdmin(app, db);
    main = await teSite('GMA', undefined);   // the D6 values carry no MW antenna at all (79% of the Master)
    expect((await gate(main.id, 'G5')).status).toBe('blocked');
    await approve(db, main, 'D6', '2026-03-15');   // the state change runs the calculation path (statement trigger -> calc_refresh_site)

    const t = await tasks(main.id);
    expect(await gate(main.id, 'G5')).toMatchObject({ status: 'open' });
    expect(t.MS5).toMatchObject({ state: 'approved', actual_date: '2026-03-15', override: false });   // by its own rule (E3), not an override
    expect(t.D8).toMatchObject({ state: 'na', nmw: true, override: true, na_reason: 'no microwave on site (D6 MW antenna empty)', actual_date: null });
    expect(t.MS6).toMatchObject({ state: 'approved', actual_date: '2026-03-28', override: false });
    // no permit is invented
    expect((await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM permit_records WHERE site_id = $1', [main.id]))[0]!.n).toBe(0);

    const g = await overrides(main.id, 'gate_moved_past_open');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ entity: 'site', task_id: null, reverted: false, acted_by: null,
      after: { gate: 'G5', status: 'open', evidence_task: 'D2', evidence_date: '2026-03-05' } });
    const st = await q<{ o: string | null }>(db, `SELECT historical_open_override::text AS o FROM site_gate_state WHERE site_id = $1 AND gate_code = 'G5'`, [main.id]);
    expect(st[0]!.o).toBe(g[0]!.id);
    const n = await overrides(main.id, 'no_microwave_na');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ entity: 'task', task_id: t.D8!.id, reverted: false, acted_by: null,
      after: { state: 'na', na_reason: 'no microwave on site (D6 MW antenna empty)', d6_mw_antenna: null } });
    const au = await q<{ action: string; actor_id: string | null; is_admin_override: boolean; after: Record<string, any> }>(db,
      `SELECT action, actor_id::text AS actor_id, is_admin_override, after FROM audit_log WHERE site_id = $1 AND action IN ('site_gate_moved_past_open', 'task_no_microwave_na') ORDER BY id`, [main.id]);
    expect(au).toHaveLength(2);
    expect(au[0]).toMatchObject({ action: 'site_gate_moved_past_open', actor_id: null, is_admin_override: true, after: { gate: 'G5', override_id: g[0]!.id, evidence_task: 'D2', backfill: false } });
    expect(au[1]).toMatchObject({ action: 'task_no_microwave_na', actor_id: null, is_admin_override: true, after: { task_code: 'D8', override_id: n[0]!.id, backfill: false } });
    const steps = await q<{ action: string; acted_by: string | null; note: string }>(db,
      `SELECT action::text AS action, acted_by::text AS acted_by, note FROM workflow_steps WHERE task_id = $1 AND action = 'admin_override'`, [t.MS5!.id]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ acted_by: null });
    expect(steps[0]!.note).toContain('gate G5 is open');

    // the screens: the site lists the gate override among its admin edits (badge, revertible, no acting person), the task lists the N/A override
    const sd = await admin.api.call('get', `/sites/${main.id}`);
    expect(sd.status, JSON.stringify(sd.body)).toBe(200);
    expect(sd.body.admin_override_active).toBe(true);
    const item = sd.body.admin_edits.items.find((x: { id: string }) => x.id === g[0]!.id);
    expect(item).toMatchObject({ kind: 'gate_moved_past_open', revertible: true });
    expect(item.acted_by).toBeUndefined();
    const td = await admin.api.call('get', `/tasks/${t.D8!.id}`);
    expect(td.status, JSON.stringify(td.body)).toBe(200);
    expect(td.body.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ id: n[0]!.id, kind: 'no_microwave_na', revertible: true })]));

    // running the calculation again changes nothing
    await refresh(main.id);
    expect(await overrides(main.id, 'gate_moved_past_open')).toHaveLength(1);
    expect(await overrides(main.id, 'no_microwave_na')).toHaveLength(1);
  });

  it('(b) D8 is never N/A when D6 has an MW antenna (Done, Pending, a date), when D8 carries a date, a measured RSL or a human step, or while D6 is not approved', async () => {
    const withMw: Site[] = [];
    for (const v of ['Done', ' pending ', '2026-03-14', 1]) {
      const s = await teSite('GMB', v);
      await approve(db, s, 'D6', '2026-03-15');
      withMw.push(s);
    }
    for (const s of withMw) {
      const t = await tasks(s.id);
      expect(t.MS5!.state).toBe('approved');            // the gate rule applies whatever the antenna
      expect(t.D8).toMatchObject({ state: 'open', nmw: false });
      expect(t.MS6!.state).toBe('locked');
      expect(await overrides(s.id, 'no_microwave_na')).toHaveLength(0);
    }
    // explicit "no antenna" answers count as empty
    for (const v of ['N/A', 'No', '', 0, null]) {
      const s = await teSite('GMN', v);
      await approve(db, s, 'D6', '2026-03-15');
      expect((await tasks(s.id)).D8).toMatchObject({ state: 'na', nmw: true });
    }
    const dated = await teSite('GMD', undefined, { d8: { date: '2026-03-22' } });
    const rsl = await teSite('GMR', undefined, { d8: { values: { measured_rsl: -45 } } });
    const human = await teSite('GMH', undefined);
    const d8h = (await tasks(human.id)).D8!.id;
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
      VALUES ($1, 2, 'reject', $2, 'the RSL is missing', 'in_review', 'open', clock_timestamp())`, [d8h, admin.user.id]);
    for (const s of [dated, rsl, human]) {
      await approve(db, s, 'D6', '2026-03-15');
      expect((await tasks(s.id)).D8).toMatchObject({ state: 'open', nmw: false });
      expect(await overrides(s.id, 'no_microwave_na')).toHaveLength(0);
    }
    // D6 not approved yet (in review): nothing happens to D8
    const pending = await teSite('GMP', undefined);
    await db.query(`UPDATE task_instances t SET state = 'in_review', current_level = 2 FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'D6' AND t.site_id = $1`, [pending.id]);
    await refresh(pending.id);
    expect((await tasks(pending.id)).D8).toMatchObject({ state: 'open', nmw: false });
    // D7 not approved yet: D8 would not open, so it waits (the order D7 -> D8 -> D9 is kept)
    const early = await teSite('GME', undefined);
    await db.query(`UPDATE task_instances t SET state = 'open', actual_date = NULL FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'D7' AND t.site_id = $1`, [early.id]);
    await db.query(`UPDATE task_instances t SET state = 'locked' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'D8' AND t.site_id = $1`, [early.id]);
    await approve(db, early, 'D6', '2026-03-15');
    expect((await tasks(early.id)).D8).toMatchObject({ state: 'locked', nmw: false });
    await approve(db, early, 'D7', '2026-03-20');
    expect((await tasks(early.id)).D8).toMatchObject({ state: 'na', nmw: true });
  });

  it('(c) a stop work in force on PTW - TE still holds G5: no override, TE Completion stays locked; lifting it lets the rule open the gate', async () => {
    const s = await teSite('GMS', 'Done');
    await db.query(`INSERT INTO permit_records (site_id, region_id, permit_type, status, has_expiry, stop_work) VALUES ($1, $2, 'PTW - TE', 'Approved', false, true)`, [s.id, R]);
    await approve(db, s, 'D6', '2026-03-15');
    const g = await gate(s.id, 'G5');
    expect(g.status).toBe('blocked');
    expect(g.reasons.map((r) => r.kind)).toContain('stop_work');
    expect(await overrides(s.id, 'gate_moved_past_open')).toHaveLength(0);
    expect((await tasks(s.id)).MS5).toMatchObject({ state: 'locked', lock_reason: 'gate_closed:G5' });
    // the stop work is lifted (the permit is still not valid: the gate is blocked by its conditions only, and the site moved past it)
    await db.query(`UPDATE permit_records SET stop_lifted_date = '2026-03-16' WHERE site_id = $1`, [s.id]);
    expect(await overrides(s.id, 'gate_moved_past_open')).toHaveLength(1);
    expect((await tasks(s.id)).MS5!.state).toBe('approved');
  });

  it('(d) revert of each kind through POST /overrides/{id}/revert: System Admin with a reason and a step-up; restored; never applied again', async () => {
    const g = (await overrides(main.id, 'gate_moved_past_open'))[0]!;
    const n = (await overrides(main.id, 'no_microwave_na'))[0]!;
    const clerk = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [R], modules: null });
    for (const id of [g.id, n.id]) {
      const denied = await clerk.api.call('post', `/overrides/${id}/revert`, { reason: 'Not an admin' });
      expect([403, 404]).toContain(denied.status);
    }
    const noStep = await plainAdmin(app, db, false);
    expect((await noStep.api.call('post', `/overrides/${g.id}/revert`, { reason: 'No step-up' })).status).toBe(401);

    // the gate: blocked again by its conditions; the tasks it released stay open and TE Completion is never taken back (Q81)
    const rg = await admin.api.call('post', `/overrides/${g.id}/revert`, { reason: 'The TE permits will be recorded by the team' });
    expect(rg.status, JSON.stringify(rg.body)).toBe(200);
    expect(rg.body).toMatchObject({ kind: 'gate_moved_past_open', revertible: false });
    expect((await gate(main.id, 'G5')).status).toBe('blocked');
    expect((await tasks(main.id)).MS5!.state).toBe('approved');
    expect(await audits('site_gate_moved_past_restore', main.id)).toBe(1);
    expect((await admin.api.call('post', `/overrides/${g.id}/revert`, { reason: 'Again' })).status).toBe(409);

    // D8: back from N/A, open again (D7 approved, no gate holds it), the flag gone; On-Air is never taken back
    const rn = await admin.api.call('post', `/overrides/${n.id}/revert`, { reason: 'The site has a microwave link after all' });
    expect(rn.status, JSON.stringify(rn.body)).toBe(200);
    expect(rn.body).toMatchObject({ kind: 'no_microwave_na', revertible: false });
    const t = await tasks(main.id);
    expect(t.D8).toMatchObject({ state: 'open', nmw: false, override: false, na_reason: null });
    expect(t.MS6!.state).toBe('approved');
    expect(await audits('task_no_microwave_na_restore', main.id)).toBe(1);
    const st = await q<{ action: string }>(db, `SELECT action::text AS action FROM workflow_steps WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.D8!.id]);
    expect(st[0]!.action).toBe('override_revert');

    // never applied again: the calculation path and the backfill leave both as the admin left them
    await refresh(main.id);
    // a task the gate holds again (MOB-5 of stage MS5, locked by G5): the gate would be moved past, but a System Admin reverted it
    const mob = await makeTask(db, main, 'MOB-5', 'locked');
    await db.query(`UPDATE task_instances SET lock_reason = 'gate_closed:G5' WHERE id = $1`, [mob]);
    await refresh(main.id);
    expect((await tasks(main.id))['MOB-5']).toMatchObject({ state: 'locked', lock_reason: 'gate_closed:G5' });
    expect((await gate(main.id, 'G5')).status).toBe('blocked');
    expect((await tasks(main.id)).D8).toMatchObject({ state: 'open', nmw: false });
    expect(await overrides(main.id, 'gate_moved_past_open')).toHaveLength(1);
    expect(await overrides(main.id, 'no_microwave_na')).toHaveLength(1);
  });

  it('(e) the backfill (migration session only) applies both rules to a site the calculation has not seen yet; one summary row with counts only; again changes nothing', async () => {
    // a site written straight into the tables (inserts do not run the calculation): D6 approved, MS5 held by G5, D8 open, MS6 locked
    const s = await teSite('GMK', 'NA');
    await db.query('SET session_replication_role = replica');
    try {
      await db.query(`UPDATE task_instances t SET state = 'approved', actual_date = '2026-03-15', approved_date = '2026-03-15' FROM task_definitions td
        WHERE td.id = t.task_def_id AND td.code = 'D6' AND t.site_id = $1`, [s.id]);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
    expect((await tasks(s.id)).MS5!.state).toBe('locked');
    const out = (await q<{ r: Record<string, any> }>(db, 'SELECT gmp_backfill() AS r'))[0]!.r;
    expect(out).toMatchObject({ sites_failed: 0 });
    expect(out.gates_opened).toBeGreaterThanOrEqual(1);
    expect(out.gates_opened_by_gate.G5).toBeGreaterThanOrEqual(1);
    expect(out.d8_na).toBeGreaterThanOrEqual(1);
    const t = await tasks(s.id);
    expect(t.MS5!.state).toBe('approved');
    expect(t.D8).toMatchObject({ state: 'na', nmw: true });
    expect(t.MS6).toMatchObject({ state: 'approved', actual_date: '2026-03-28' });
    const ov = await overrides(s.id, 'gate_moved_past_open');
    expect(ov[0]!.after).toMatchObject({ gate: 'G5', evidence_task: 'D2' });
    const au = await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'site_gate_moved_past_open' AND site_id = $1`, [s.id]);
    expect(au[0]!.after.backfill).toBe(true);
    // no notification about the site from the backfill (muted per site)
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM notifications n JOIN task_instances t ON t.id = n.task_id WHERE t.site_id = $1`, [s.id]))[0]!.n).toBe(0);
    // the summary row holds counts only: no site id, code or name
    const sum = await q<{ entity_id: string; site_id: string | null; after: Record<string, any>; actor_id: string | null }>(db,
      `SELECT entity_id, site_id::text AS site_id, after, actor_id::text AS actor_id FROM audit_log WHERE action = 'gate_moved_past_no_microwave_backfill' ORDER BY id DESC LIMIT 1`);
    expect(sum[0]).toMatchObject({ entity_id: 'all', site_id: null, actor_id: null });
    expect(JSON.stringify(sum[0]!.after)).not.toContain(s.id);
    expect(JSON.stringify(sum[0]!.after)).not.toContain(s.code);
    const again = (await q<{ r: Record<string, any> }>(db, 'SELECT gmp_backfill() AS r'))[0]!.r;
    expect(again).toMatchObject({ gates_opened: 0, d8_na: 0, sites_failed: 0 });
  });

  it('(f) the application role cannot reach the internal functions, the markers or the flag; a forged setting or the definer without its marker is refused', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_GMP });
    await app2.connect();
    try {
      for (const sql of [`SELECT gmp_backfill()`, `SELECT gmp_apply_site(gen_random_uuid())`, `SELECT gmp_open_gates(gen_random_uuid(), false)`,
        `SELECT nmw_mark_site(gen_random_uuid(), false)`, `SELECT nmw_restore_task(gen_random_uuid(), gen_random_uuid(), 'x', 'x', true)`,
        `SELECT gmp_site_deferred(gen_random_uuid())`, `SELECT nmw_mw_absent('null'::jsonb)`, `SELECT hgd_mark('nmw_task', 'x')`,
        `SELECT hgd_mark('hgd_gate', 'x')`, `SELECT calc_refresh_site(gen_random_uuid())`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET no_microwave_na = true, no_microwave_na_at = now()`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`INSERT INTO admin_overrides (entity, site_id, kind, reason, before, after) VALUES ('site', gen_random_uuid(), 'gate_moved_past_open', 'forged', '{}', '{}')`))
        .rejects.toThrow(/permission denied/);
      await expect(app2.query(`SELECT status FROM gate_eval(gen_random_uuid(), 'G5')`)).resolves.toBeTruthy();
    } finally {
      await app2.end();
    }
    // a marker in a session setting is never enough: a throwaway role with the table rights (row security bypassed) and the definer owner without the
    // definer-only marker row are both refused by the guards
    const s = await teSite('GMF', 'Done');
    await refresh(s.id);   // the gate watch writes the rows of site_gate_state
    const d8 = (await tasks(s.id)).D8!.id;
    const oid = (await overrides(main.id, 'gate_moved_past_open'))[0]!.id;
    for (const role of ['gmp_forger', 'pmis_definer']) {
      for (const sql of [`UPDATE task_instances SET state = 'na', is_na = true, no_microwave_na = true, no_microwave_na_at = now() WHERE id = '${d8}'`,
        `UPDATE site_gate_state SET historical_open_override = '${oid}', historical_open_at = now() WHERE site_id = '${s.id}' AND gate_code = 'G5'`]) {
        await db.query('BEGIN');
        try {
          if (role === 'gmp_forger') {
            await db.query('CREATE ROLE gmp_forger NOLOGIN BYPASSRLS');
            await db.query('GRANT SELECT, UPDATE ON task_instances, site_gate_state TO gmp_forger');
            await db.query(`SELECT set_config('pmis.nmw_task', $1, true), set_config('pmis.hgd_gate', $2, true)`, [d8, `${s.id}:G5`]);
          }
          await db.query(`SET LOCAL ROLE ${role}`);
          await expect(db.query(sql)).rejects.toThrow(/written only through wf_\* functions|written only by GSDN Workspace/);
        } finally {
          await db.query('ROLLBACK');
        }
      }
    }
    expect((await tasks(s.id)).D8!.nmw).toBe(false);
  });
});
