import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve, q } from './calc-helpers';
import { startApp, superDbRfi } from './helpers';
import { SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0136 (owner decision 2026-11-22): on ANY site, a manual milestone (Site RFI, MS4) the site moved past (a later task approved with an actual date)
 * is approved directly with its pre-filled date (else the date of the earliest later task approved, flagged inferred), as an admin override made by a rule
 * (kind manual_ms_moved_past, no acting person); never one a person touched, never a typed date, never while a gate holds it, never again once reverted
 * (this kind or 0129's historical_manual_ms_approved). It runs in the hook of the calculation path before the gate and D8 rules of 0134 (MS4 -> G5 -> MS5
 * -> D8 -> MS6) and once in the migration (mmp_backfill). The hook stands aside only while a Master import apply is running (mi_apply_jobs), no longer
 * while a staged historical batch is left validated. Its own database (TEST_DATABASE_URL_RFI): the backfill reads every active site and a running job
 * defers every site. Synthetic data only. Region 6.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 6;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_RFI as string });
  db = await superDbRfi();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

interface TaskRow { id: string; code: string; state: string; actual_date: string | null; lock_reason: string | null; mmp: boolean; inferred: boolean; nmw: boolean; override: boolean }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT t.id::text AS id, td.code, t.state::text AS state, t.actual_date::text AS actual_date, t.lock_reason, t.manual_ms_moved_past AS mmp,
          t.manual_ms_moved_past_inferred AS inferred, t.no_microwave_na AS nmw, t.admin_override AS override
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const gate = async (siteId: string, g: string) => (await q<{ status: string; reasons: { kind: string }[] }>(db,
  'SELECT status, reasons FROM gate_eval($1, $2)', [siteId, g]))[0]!;
const overrides = async (siteId: string, kind: string) => q<{ id: string; task_id: string | null; before: Record<string, any>; after: Record<string, any>; reverted: boolean; acted_by: string | null }>(db,
  `SELECT id::text AS id, task_id::text AS task_id, before, after, reverted_at IS NOT NULL AS reverted, acted_by::text AS acted_by FROM admin_overrides
   WHERE site_id = $1 AND kind = $2 ORDER BY created_at`, [siteId, kind]);
const audits = async (action: string, siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND site_id = $2', [action, siteId]))[0]!.n;
const notices = async (siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM notifications n JOIN task_instances t ON t.id = n.task_id WHERE t.site_id = $1', [siteId]))[0]!.n;
const refresh = (siteId: string) => db.query('SELECT calc_refresh_site($1)', [siteId]);
const backfill = async () => (await q<{ r: Record<string, any> }>(db, 'SELECT mmp_backfill() AS r'))[0]!.r;

let loader: Actor;
/**
 * The production shape, written straight into the tables with the triggers off (as an earlier load left it; nothing is calculated): CW Completion approved,
 * Site RFI (MS4) open with no human step and no date, the TE work D1..D6 approved (D6 with the MW antenna `mw`, default 'N/A'), TE Completion (MS5) locked
 * gate_closed:G5 (the TE permits never recorded), D7, D9, D10 approved, D8 open, On-Air (MS6) locked; and a stale historical Master batch approved directly
 * with a row of the site, staged and left `validated` (never finished, never closed).
 */
async function prodSite(prefix: string, o: { mw?: unknown; d10?: 'approved' | 'open'; noPrefill?: boolean } = {}): Promise<Site> {
  const s = await makeSite(db, R, { prefix, status: 'in_progress' });
  const tv = (await q<{ id: string }>(db, `SELECT v.id::text AS id FROM template_versions v JOIN template_definitions dd ON dd.id = v.template_def_id WHERE dd.template_id = 'TPL-ACQUISITION' AND v.is_current`))[0]!.id;
  await db.query('SET session_replication_role = replica');
  try {
    await makeTask(db, s, 'MS3', 'approved', { actualDate: o.noPrefill ? null : '2026-02-06' });
    if (o.noPrefill) await makeTask(db, s, 'B13', 'na'); else await makeTask(db, s, 'B13', 'approved', { actualDate: '2026-02-25' });
    await makeTask(db, s, 'C2', 'na');
    await makeTask(db, s, 'C4', 'na');
    const ms4 = await makeTask(db, s, 'MS4', 'open', { levels: 2 });
    for (const [c, d] of [['D1', '2026-03-03'], ['D2', '2026-03-05'], ['D3', '2026-03-06'], ['D4', '2026-03-07'], ['D4b', '2026-03-08'], ['D5', '2026-03-09'], ['D6', '2026-03-15']] as const) {
      await makeTask(db, s, c, 'approved', { actualDate: d });
    }
    await db.query(`UPDATE task_instances t SET values = jsonb_build_object('mw_antenna', $2::jsonb) FROM task_definitions td
      WHERE td.id = t.task_def_id AND td.code = 'D6' AND t.site_id = $1`, [s.id, JSON.stringify(o.mw === undefined ? 'N/A' : o.mw)]);
    await makeTask(db, s, 'MS5', 'locked');
    await db.query(`UPDATE task_instances t SET lock_reason = 'gate_closed:G5' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS5' AND t.site_id = $1`, [s.id]);
    await makeTask(db, s, 'D7', 'approved', { actualDate: '2026-03-20' });
    await makeTask(db, s, 'D8', 'open');
    for (const [c, d] of [['D9', '2026-03-24'], ['D10a', '2026-03-25'], ['D10b', '2026-03-26']] as const) await makeTask(db, s, c, 'approved', { actualDate: d });
    if ((o.d10 ?? 'approved') === 'approved') await makeTask(db, s, 'D10', 'approved', { actualDate: '2026-03-28' });
    else await makeTask(db, s, 'D10', 'open');
    await makeTask(db, s, 'MS6', 'locked');
    const b = (await q<{ id: string }>(db, `INSERT INTO import_batches (template_version_id, source, file_name, file_sha256, status, uploaded_by, register_key, mode,
        historical_load, historical_cutoff, historical_reason, historical_marked_by, historical_marked_at, historical_direct_approve)
      VALUES ($1, 'master_import', 'GSDN_Site_Master.xlsx', repeat('e', 64), 'validated', $2, 'acquisition', 'submit', true, '2026-06-30', 'Synthetic stale load', $2, now(), true)
      RETURNING id::text AS id`, [tv, loader.user.id]))[0]!.id;
    await db.query(`INSERT INTO import_batch_rows (batch_id, row_no, target_entity, payload, task_instance_id) VALUES ($1, 1, 'task', '{}', $2)`, [b, ms4]);
    // D1 was approved from a row of that batch (the site is in the scope of the historical rules of 0126 / 0127 / 0129 too)
    await db.query(`UPDATE task_instances t SET historical_direct_approved = true, historical_direct_batch_id = $2, historical_direct_approved_at = now()
      FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'D1' AND t.site_id = $1`, [s.id, b]);
  } finally {
    await db.query('SET session_replication_role = origin');
  }
  return s;
}
/** The deferral of 0134 would have held this site: a historical batch approved directly, with a row of the site, not closed. */
const staleBatch = async (siteId: string) => (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM import_batches b JOIN import_batch_rows r ON r.batch_id = b.id
  JOIN task_instances t ON t.id = r.task_instance_id WHERE b.historical_load AND b.historical_direct_approve AND b.closed_at IS NULL AND b.status = 'validated' AND t.site_id = $1`, [siteId]))[0]!.n;

/** The whole chain: Site RFI approved by the rule, G5 open as an override, TE Completion calculated, D8 N/A (no microwave), On-Air calculated. */
async function expectChain(s: Site, backfilled: boolean): Promise<void> {
  const t = await tasks(s.id);
  expect(t.MS4).toMatchObject({ state: 'approved', actual_date: '2026-02-25', mmp: true, inferred: false, override: true });
  expect(await gate(s.id, 'G5')).toMatchObject({ status: 'open' });
  expect(t.MS5).toMatchObject({ state: 'approved', actual_date: '2026-03-15' });
  expect(t.D8).toMatchObject({ state: 'na', nmw: true });
  expect(t.MS6).toMatchObject({ state: 'approved', actual_date: '2026-03-28' });
  const m = await overrides(s.id, 'manual_ms_moved_past');
  expect(m).toHaveLength(1);
  expect(m[0]).toMatchObject({ task_id: t.MS4!.id, reverted: false, acted_by: null,
    before: { state: 'open', actual_date: '2026-02-25', prefilled_date: '2026-02-25' },
    after: { state: 'approved', actual_date: '2026-02-25', date_source: 'prefilled', evidence_task: 'D1', evidence_date: '2026-03-03' } });
  expect((await overrides(s.id, 'gate_moved_past_open'))[0]).toMatchObject({ acted_by: null, after: { gate: 'G5', status: 'open' } });
  expect(await overrides(s.id, 'no_microwave_na')).toHaveLength(1);
  const au = await q<{ actor_id: string | null; is_admin_override: boolean; after: Record<string, any> }>(db,
    `SELECT actor_id::text AS actor_id, is_admin_override, after FROM audit_log WHERE action = 'task_manual_ms_moved_past' AND site_id = $1`, [s.id]);
  expect(au).toHaveLength(1);
  expect(au[0]).toMatchObject({ actor_id: null, is_admin_override: true,
    after: { manual_ms_moved_past: true, date_source: 'prefilled', task_code: 'MS4', override_id: m[0]!.id, evidence_task: 'D1', backfill: backfilled } });
  const st = await q<{ acted_by: string | null; note: string }>(db,
    `SELECT acted_by::text AS acted_by, note FROM workflow_steps WHERE task_id = $1 AND action = 'admin_override'`, [t.MS4!.id]);
  expect(st).toHaveLength(1);
  expect(st[0]!.acted_by).toBeNull();
  expect(st[0]!.note).toContain('the site moved past it');
  // no permit is invented
  expect((await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM permit_records WHERE site_id = $1', [s.id]))[0]!.n).toBe(0);
}

describe('0136: Site RFI the site moved past is approved automatically, on any site', () => {
  let admin: Actor;
  let live: Site;

  it('(a) the production shape, before any rule: G5 is pending because Site RFI is not approved, and a stale validated historical batch holds rows of the site', async () => {
    loader = await plainAdmin(app, db);
    admin = loader;
    // the migration ran on an empty database: nothing in scope, no summary row
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'manual_ms_moved_past_backfill'`))[0]!.n).toBe(0);
    const s = await prodSite('RFP');
    const g = await gate(s.id, 'G5');
    expect(g.status).toBe('pending');
    expect(g.reasons.map((r) => r.kind)).toContain('predecessor_not_approved');
    expect(await staleBatch(s.id)).toBe(1);
    // gmp_open_gates alone (0134) acts on a blocked gate only: nothing happens here
    await db.query('BEGIN');
    try {
      expect((await q<{ g: unknown[] }>(db, 'SELECT gmp_open_gates($1, false) AS g', [s.id]))[0]!.g).toEqual([]);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('(b) the one-time backfill (migration session only): Site RFI approved by the rule, G5 open as an override, TE Completion, D8 N/A, On-Air; notices muted; one summary row with counts only; again changes nothing', async () => {
    const s = await prodSite('RFB');
    const out = await backfill();
    expect(out).toMatchObject({ sites_failed: 0 });
    expect(out.sites_scanned).toBeGreaterThanOrEqual(2);
    expect(out.manual_ms_approved).toBeGreaterThanOrEqual(2);
    expect(out.manual_ms_approved_by_code.MS4).toBeGreaterThanOrEqual(2);
    expect(out.gates_opened_by_gate.G5).toBeGreaterThanOrEqual(2);
    expect(out.d8_na).toBeGreaterThanOrEqual(2);
    expect(out.milestones_approved_after.MS6 ?? 0).toBeGreaterThan(out.milestones_approved_before.MS6 ?? 0);
    expect(out.milestones_approved_after.MS4).toBeGreaterThan(out.milestones_approved_before.MS4 ?? 0);
    await expectChain(s, true);
    expect(await notices(s.id)).toBe(0);
    const sum = await q<{ entity_id: string; site_id: string | null; actor_id: string | null; is_admin_override: boolean; after: Record<string, any> }>(db,
      `SELECT entity_id, site_id::text AS site_id, actor_id::text AS actor_id, is_admin_override, after FROM audit_log WHERE action = 'manual_ms_moved_past_backfill'`);
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ entity_id: 'all', site_id: null, actor_id: null, is_admin_override: true });
    for (const k of ['sites_scanned', 'sites_changed', 'manual_ms_approved', 'manual_ms_approved_by_code', 'manual_ms_inferred', 'gates_opened', 'gates_opened_by_gate',
      'd8_na', 'milestones_approved_before', 'milestones_approved_after']) expect(sum[0]!.after).toHaveProperty(k);
    expect(JSON.stringify(sum[0]!.after)).not.toContain(s.id);
    expect(JSON.stringify(sum[0]!.after)).not.toContain(s.code);
    const again = await backfill();
    expect(again).toMatchObject({ manual_ms_approved: 0, gates_opened: 0, d8_na: 0, sites_failed: 0 });
  });

  it('(c) ongoing: any approval on the site runs the hook (the stale validated batch no longer defers it): MS4, then G5, MS5, D8 and MS6', async () => {
    live = await prodSite('RFL', { d10: 'open' });
    expect(await staleBatch(live.id)).toBe(1);
    expect((await tasks(live.id)).MS4!.state).toBe('open');
    await approve(db, live, 'D10', '2026-03-28');   // the state change runs the calculation path (statement trigger -> calc_refresh_site -> gmp_apply_site)
    await expectChain(live, false);
    // the screens: the task lists the override (badge, revertible, no acting person)
    const ms4 = (await tasks(live.id)).MS4!.id;
    const td = await admin.api.call('get', `/tasks/${ms4}`);
    expect(td.status, JSON.stringify(td.body)).toBe(200);
    const item = td.body.overrides.find((x: { kind: string }) => x.kind === 'manual_ms_moved_past');
    expect(item).toMatchObject({ kind: 'manual_ms_moved_past', revertible: true, after: { date_source: 'prefilled' } });
    expect(item.acted_by).toBeUndefined();
    // the calculation again changes nothing
    await refresh(live.id);
    expect(await overrides(live.id, 'manual_ms_moved_past')).toHaveLength(1);
  });

  it('(d) with no pre-filled date (every predecessor approved or N/A, none dated) the date of the earliest later task approved, flagged inferred', async () => {
    const s = await prodSite('RFI', { d10: 'open', noPrefill: true });
    await approve(db, s, 'D10', '2026-03-28');
    const t = await tasks(s.id);
    expect(t.MS4).toMatchObject({ state: 'approved', actual_date: '2026-03-03', mmp: true, inferred: true });
    expect((await overrides(s.id, 'manual_ms_moved_past'))[0]!.after).toMatchObject({ date_source: 'inferred', actual_date: '2026-03-03', evidence_task: 'D1' });
    expect(t.MS6!.state).toBe('approved');
  });

  it('(e) a Site RFI a person touched is never approved by the rule: submitted then rejected, reassigned, a typed date, a date override; nor while G4 holds it', async () => {
    const touched: Site[] = [];
    for (const action of ['submit', 'reassign']) {
      const s = await prodSite('RFH', { d10: 'open' });
      const ms4 = (await tasks(s.id)).MS4!.id;
      await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
        VALUES ($1, 1, $2::"WorkflowAction", $3, 'by a person', 'entry', 'in_review', clock_timestamp())`, [ms4, action, admin.user.id]);
      if (action === 'submit') {
        await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
          VALUES ($1, 2, 'reject', $2, 'the date is wrong', 'in_review', 'open', clock_timestamp())`, [ms4, admin.user.id]);
      }
      touched.push(s);
    }
    const typed = await prodSite('RFT', { d10: 'open' });
    await db.query(`UPDATE task_instances t SET actual_date = '2026-03-01' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS4' AND t.site_id = $1`, [typed.id]);
    touched.push(typed);
    const edited = await prodSite('RFE', { d10: 'open' });
    const ms4e = (await tasks(edited.id)).MS4!.id;
    await db.query(`INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by, reverted_at, reverted_by, revert_reason)
      VALUES ('task', $1, $2, 'edit_date', 'typed by an admin', '{"actual_date": null}', '{"actual_date": "2026-03-02"}', $3, now(), $3, 'taken back')`, [edited.id, ms4e, admin.user.id]);
    touched.push(edited);
    for (const s of touched) {
      await approve(db, s, 'D10', '2026-03-28');
      const t = await tasks(s.id);
      expect(t.MS4).toMatchObject({ state: 'open', mmp: false });
      expect(await overrides(s.id, 'manual_ms_moved_past')).toHaveLength(0);
      expect((await gate(s.id, 'G5')).status).toBe('pending');
      expect(t.MS5!.state).toBe('locked');
    }
    expect((await tasks(typed.id)).MS4!.actual_date).toBe('2026-03-01');
    // G4 not open (CW Completion not approved): Site RFI waits, whatever the TE work says
    const early = await prodSite('RFG', { d10: 'open' });
    await db.query(`UPDATE task_instances t SET state = 'open', actual_date = NULL FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS3' AND t.site_id = $1`, [early.id]);
    await approve(db, early, 'D10', '2026-03-28');
    expect((await tasks(early.id)).MS4).toMatchObject({ state: 'open', mmp: false });
    expect(await overrides(early.id, 'manual_ms_moved_past')).toHaveLength(0);
  });

  it('(f) a stop work in force on PTW - TE: Site RFI is approved (its own gate G4 is open) but G5 stays blocked, TE Completion stays locked', async () => {
    const s = await prodSite('RFS', { d10: 'open' });
    await db.query(`INSERT INTO permit_records (site_id, region_id, permit_type, status, has_expiry, stop_work) VALUES ($1, $2, 'PTW - TE', 'Approved', false, true)`, [s.id, R]);
    await approve(db, s, 'D10', '2026-03-28');
    const t = await tasks(s.id);
    expect(t.MS4).toMatchObject({ state: 'approved', mmp: true });
    const g = await gate(s.id, 'G5');
    expect(g.status).toBe('blocked');
    expect(g.reasons.map((r) => r.kind)).toContain('stop_work');
    expect(await overrides(s.id, 'gate_moved_past_open')).toHaveLength(0);
    expect(t.MS5).toMatchObject({ state: 'locked', lock_reason: 'gate_closed:G5' });
    expect(t.MS6!.state).toBe('locked');
  });

  it('(g) the hook stands aside only while a Master import apply is running (mi_apply_jobs): then it applies at the next calculation', async () => {
    const s = await prodSite('RFJ', { d10: 'open' });
    const run = (await q<{ id: string }>(db, `INSERT INTO master_reconciliation_runs (file_name, file_sha256, file_size, structure, status, created_by)
      VALUES ('GSDN_Site_Master.xlsx', repeat('d', 64), 1024, '{}', 'applying', $1) RETURNING id::text AS id`, [admin.user.id]))[0]!.id;
    const job = (await q<{ id: string }>(db, `INSERT INTO mi_apply_jobs (run_id, actor_id, mode, reason, sites_total, state)
      VALUES ($1, $2, 'submit', 'Synthetic background apply', 1, 'running') RETURNING id::text AS id`, [run, admin.user.id]))[0]!.id;
    try {
      expect((await q<{ d: boolean }>(db, 'SELECT gmp_site_deferred($1) AS d', [s.id]))[0]!.d).toBe(true);
      await approve(db, s, 'D10', '2026-03-28');
      expect((await tasks(s.id)).MS4).toMatchObject({ state: 'open', mmp: false });
      expect(await overrides(s.id, 'manual_ms_moved_past')).toHaveLength(0);
    } finally {
      await db.query(`UPDATE mi_apply_jobs SET state = 'done', finished_at = now() WHERE id = $1`, [job]);
    }
    expect((await q<{ d: boolean }>(db, 'SELECT gmp_site_deferred($1) AS d', [s.id]))[0]!.d).toBe(false);
    await refresh(s.id);
    await expectChain(s, false);
  });

  it('(h) revert through POST /overrides/{id}/revert (System Admin, reason, step-up): Site RFI open again with its pre-filled date; never approved again by either rule; a Site RFI reverted under the historical kind is never approved either', async () => {
    const m = (await overrides(live.id, 'manual_ms_moved_past'))[0]!;
    const clerk = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [R], modules: null });
    expect([403, 404]).toContain((await clerk.api.call('post', `/overrides/${m.id}/revert`, { reason: 'Not an admin' })).status);
    const noStep = await plainAdmin(app, db, false);
    expect((await noStep.api.call('post', `/overrides/${m.id}/revert`, { reason: 'No step-up' })).status).toBe(401);
    const r = await admin.api.call('post', `/overrides/${m.id}/revert`, { reason: 'The team submits Site RFI for L2' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: 'manual_ms_moved_past', revertible: false });
    let t = await tasks(live.id);
    expect(t.MS4).toMatchObject({ state: 'open', actual_date: '2026-02-25', mmp: false, inferred: false });
    expect(t.MS5!.state).toBe('approved');   // never taken back (Q81)
    expect(t.MS6!.state).toBe('approved');
    expect(await audits('task_manual_ms_moved_past_restore', live.id)).toBe(1);
    expect((await admin.api.call('post', `/overrides/${m.id}/revert`, { reason: 'Again' })).status).toBe(409);
    // never again: the calculation, the backfill and the historical settle loop (the site holds a historical batch approved directly) leave it open
    await refresh(live.id);
    await backfill();
    const settled = (await q<{ r: Record<string, any> }>(db, `SELECT hgd_settle_site($1, $2, 'Synthetic historical settle', false) AS r`, [live.id, admin.user.id]))[0]!.r;
    expect(settled).toMatchObject({ in_scope: true, manual: [] });
    t = await tasks(live.id);
    expect(t.MS4).toMatchObject({ state: 'open', mmp: false });
    expect(await overrides(live.id, 'manual_ms_moved_past')).toHaveLength(1);
    expect(await overrides(live.id, 'historical_manual_ms_approved')).toHaveLength(0);

    // reverted under the historical kind of 0129: the new rule never approves it either
    const h = await prodSite('RFR', { d10: 'open' });
    const ms4 = (await tasks(h.id)).MS4!.id;
    await db.query(`INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by, reverted_at, reverted_by, revert_reason)
      VALUES ('task', $1, $2, 'historical_manual_ms_approved', 'historical load', '{"state": "open"}', '{"state": "approved"}', $3, now(), $3, 'taken back')`, [h.id, ms4, admin.user.id]);
    await approve(db, h, 'D10', '2026-03-28');
    expect((await tasks(h.id)).MS4).toMatchObject({ state: 'open', mmp: false });
    expect(await overrides(h.id, 'manual_ms_moved_past')).toHaveLength(0);
    await backfill();
    expect((await tasks(h.id)).MS4).toMatchObject({ state: 'open', mmp: false });
  });

  it('(i) any other path that takes the milestone out of its approval clears the flags and closes the override', async () => {
    const s = await prodSite('RFC', { d10: 'open' });
    await approve(db, s, 'D10', '2026-03-28');
    const ms4 = (await tasks(s.id)).MS4!.id;
    await db.query(`UPDATE task_instances SET actual_date = '2026-02-27' WHERE id = $1`, [ms4]);
    expect((await tasks(s.id)).MS4).toMatchObject({ state: 'approved', mmp: false, actual_date: '2026-02-27' });
    expect((await overrides(s.id, 'manual_ms_moved_past'))[0]).toMatchObject({ reverted: true });
    expect(await audits('task_manual_ms_moved_past_cleared', s.id)).toBe(1);
  });

  it('(j) the application role cannot reach the internal functions, the markers or the flags; a forged setting or the definer without its marker is refused', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_RFI });
    await app2.connect();
    try {
      for (const sql of [`SELECT mmp_backfill()`, `SELECT mmp_approve_site(gen_random_uuid(), false)`, `SELECT mmp_rules_site(gen_random_uuid(), false)`,
        `SELECT mmp_restore_task(gen_random_uuid(), gen_random_uuid(), 'x', 'x', true)`, `SELECT gmp_apply_site(gen_random_uuid())`,
        `SELECT gmp_site_deferred(gen_random_uuid())`, `SELECT hgd_mark('mmp_task', 'x')`, `SELECT hgd_settle_site(gen_random_uuid(), gen_random_uuid(), 'x', false)`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET manual_ms_moved_past = true, manual_ms_moved_past_at = now()`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`UPDATE task_instances SET manual_ms_moved_past_inferred = true`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after) VALUES ('task', gen_random_uuid(), gen_random_uuid(), 'manual_ms_moved_past', 'forged', '{}', '{}')`))
        .rejects.toThrow(/permission denied/);
      await expect(app2.query(`SELECT * FROM mi_apply_jobs`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
    // a person's override always names the person: only the rule kinds may have no acting person
    await expect(db.query(`INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
      VALUES ('task', $1, (SELECT id FROM task_instances WHERE site_id = $1 LIMIT 1), 'edit_date', 'no actor', '{}', '{}', NULL)`, [live.id])).rejects.toThrow(/admin_overrides_rule_actor_check/);
    const s = await prodSite('RFF', { d10: 'open' });
    const ms4 = (await tasks(s.id)).MS4!.id;
    for (const role of ['mmp_forger', 'pmis_definer']) {
      await db.query('BEGIN');
      try {
        if (role === 'mmp_forger') {
          await db.query('CREATE ROLE mmp_forger NOLOGIN BYPASSRLS');
          await db.query('GRANT SELECT, UPDATE ON task_instances TO mmp_forger');
          await db.query(`SELECT set_config('pmis.mmp_task', $1, true)`, [ms4]);
        }
        await db.query(`SET LOCAL ROLE ${role}`);
        await expect(db.query(`UPDATE task_instances SET state = 'approved', actual_date = '2026-02-25', manual_ms_moved_past = true, manual_ms_moved_past_at = now() WHERE id = '${ms4}'`))
          .rejects.toThrow(/written only through wf_\* functions|written only by GSDN Workspace/);
      } finally {
        await db.query('ROLLBACK');
      }
    }
    expect((await tasks(s.id)).MS4).toMatchObject({ state: 'open', mmp: false });
  });
});
