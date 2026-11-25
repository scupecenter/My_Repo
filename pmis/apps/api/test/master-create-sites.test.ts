import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportJobsService } from '../src/templates/import-jobs.service';
import { q } from './calc-helpers';
import { Api, delegate, loggedIn, makeUser, startApp, superDbMcs } from './helpers';
import { day } from './tpl-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0155 (owner request 2026-11-25, Q350): "Create the sites that are not in GSDN Workspace from the Master". The apply of a Master import run creates
 * the sites of its file that GSDN Workspace does not hold (the New sites validation and writer, the audit naming the run), then enters their task dates; an
 * existing Site ID is never touched; the option is for a System Admin or the holder of both L1 and L2 of the Matrix row site_creation; a big run creates the
 * sites in chunks in the background. Its own database (TEST_DATABASE_URL_MCS): it replaces the site_creation cells and changes imports.async_rows. Synthetic
 * data only.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 2;        // Middle
const OTHER = 4;    // Zawia
const R3 = 5;       // Benghazi: the admin-override region (its site_creation cells name another person)
const TAG = randomBytes(2).toString('hex').toUpperCase();
let n = 0;
const code = (): string => `MCS${TAG}${String(++n).padStart(3, '0')}`;
const REASON = 'Historical Master of the owner after the project data reset';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_MCS as string });
  db = await superDbMcs();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

type Cell = string | number | Date | { formula: string; result: string | number } | null;

/** A synthetic legacy Master: the Master sheet (three header rows, data from row 5). */
async function masterFile(masterRows: Record<string, Cell>[]): Promise<Buffer> {
  const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
  const ws = wb.addWorksheet('Master');
  for (const c of cols) {
    ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
    ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
    ws.getCell(`${c.letter}3`).value = c.name ?? null;
  }
  masterRows.forEach((r, i) => {
    for (const [L, v] of Object.entries(r)) {
      const cell = ws.getCell(`${L}${5 + i}`);
      cell.value = v as ExcelJS.CellValue;
      if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd';
    }
  });
  const st = wb.addWorksheet('Setting');
  st.getCell('I1').value = 'Project Staff';
  ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const uploadMaster = (api: Api, buf: Buffer): request.Test => {
  const r = api.raw('post', '/master-import/runs');
  if (api.csrf) r.set('X-CSRF-Token', api.csrf);
  return r.attach('file', buf, { filename: `GSDN_Site_Master_${randomBytes(3).toString('hex')}.xlsx`, contentType: 'application/octet-stream' });
};
const openWaiver = async (a: Actor) => {
  const r = await a.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-06-30', reason: 'Open for the historical load' });
  expect([200, 409]).toContain(r.status);
};
const regionName = async (id: number): Promise<string> => (await q<{ n: string }>(db, 'SELECT name_en AS n FROM regions WHERE id = $1', [id]))[0]!.n;
/** Replaces the cell of one level of the Site creation row in a region and names its holders. */
async function siteCell(region: number, kind: 'entry' | 'approve', users: string[]): Promise<void> {
  const level = kind === 'entry' ? 1 : 3;
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id = $3', ['site_creation', level, region]);
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('site_creation', $1, 'any_one', $2, false, now()) RETURNING id`, [level, region]);
  for (const u of users) await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, u]);
}
interface SiteRow { id: string; name: string; region_id: number; owner_site_id: string | null; sub_region: string | null; cluster: string | null; cluster_region: number | null;
  latitude: string | null; longitude: string | null; site_scenario: string | null; project_phase: string | null; delivery_batch: string | null; delivery_scenario: string | null;
  cw_delivery_model: string | null; rf_survey_date: string | null; flags: string; overall_status: string }
const siteOf = async (siteCode: string): Promise<SiteRow | undefined> => (await q<SiteRow>(db,
  `SELECT s.id, s.name, s.region_id, s.owner_site_id, s.sub_region, c.cluster_code AS cluster, c.region_id AS cluster_region, s.latitude::text, s.longitude::text,
     s.site_scenario, s.project_phase, s.delivery_batch, s.delivery_scenario::text, s.cw_delivery_model, s.rf_survey_date::text,
     concat_ws(',', s.scope_tower_erection, s.scope_site_adaption, s.scope_gecol_power, s.scope_hlc_fiber, s.scope_te_full, s.scope_te_ip_router_only) AS flags,
     s.overall_status::text
   FROM sites s LEFT JOIN clusters c ON c.id = s.cluster_id WHERE s.site_code = $1`, [siteCode]))[0];
const taskOf = async (siteId: string, taskCode: string) => (await q<{ state: string; actual_date: string | null }>(db,
  `SELECT ti.state::text AS state, ti.actual_date::text AS actual_date FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
   WHERE ti.site_id = $1 AND td.code = $2`, [siteId, taskCode]))[0];
const siteAudit = (siteId: string) => q<{ before: unknown; after: Record<string, any>; reason: string; is_admin_override: boolean; actor_id: string }>(db,
  `SELECT before, after, reason, is_admin_override, actor_id::text AS actor_id FROM audit_log WHERE action = 'site_create' AND entity_id = $1 ORDER BY id`, [siteId]);
/** One full identity row of the Master for a new site of a region (the columns A:AG the New sites template carries, and a CW date). */
const row = (i: number, siteCode: string, region: string, over: Record<string, Cell> = {}): Record<string, Cell> => ({
  A: i, B: siteCode, C: `OWN-${siteCode}`, D: `Synthetic ${siteCode}`, E: region, F: 'Sub A', G: `CL-${TAG}`, H: 32.5, I: 13.25, K: 'Outdoor', S: day('2026-01-03'),
  X: 'Phase 1', Y: 'Batch 7', Z: 'New Build', AA: 'Yes', AB: 'No', AC: 'Yes', AD: 'No', AE: 'Yes', AF: 'No', AG: 'Outsourced', AO: day('2026-02-10'), ...over,
});

describe('0155: create the sites that are not in GSDN Workspace from the Master', () => {
  it('creates the missing sites first (the New sites path, audited with the run), then enters their task dates; an existing site is untouched; invalid rows are refused with their reasons', async () => {
    const admin = await plainAdmin(app, db);
    await openWaiver(admin);
    const region = await regionName(R);
    const [n1, n2, bad1, bad2, race, cancelled] = [code(), code(), code(), code(), code(), code()];
    // an existing site of the file (matched at the comparison) keeps everything it has
    const existing = code();
    const wf = (await q<{ id: string }>(db, 'SELECT id FROM workflow_definitions WHERE version = 1'))[0]!.id;
    await db.query(`INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, updated_at)
                    VALUES ($1, 'Kept name', $2, $3, 'expansion', 'not_started', now())`, [existing, R, wf]);
    const file = await masterFile([
      row(1, n1, region, { C: { formula: '"OWN-F1"', result: 'OWN-F1' } }),   // a formula cell: its cached value is read, as the file shows it
      row(2, n2, region.toUpperCase()),
      row(3, bad1, region, { Z: null }),                                       // no delivery scenario: refused, never defaulted
      row(4, bad2, 'Atlantis'),                                                // an unknown region: refused
      row(5, race, region),                                                    // becomes a site between the comparison and the apply: skipped
      row(6, cancelled, region, { FZ: 'Cancelled', AO: null }),                // Q466: created, then cancelled
      row(7, existing, region, { D: 'Another name', Z: 'Hot Swap' }),
    ]);
    const run = await uploadMaster(admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.summary.missing_in_pmis).toBe(6);
    expect(run.body.create_sites_offer).toMatchObject({ allowed: true, admin: true, reason: null });
    await db.query(`INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, updated_at)
                    VALUES ($1, 'Race name', $2, $3, 'new_build', 'not_started', now())`, [race, R, wf]);
    const before = (await siteOf(existing))!;

    // the apply with the option (and the historical load approved directly, as after a project data reset)
    const url = `/master-import/runs/${run.body.id}/apply`;
    const im = { 'If-Match': `"${run.body.version}"` };
    const body = { mode: 'submit', reason: 'Load after the reset', historical_load: { reason: REASON, approve_directly: true }, create_sites: true };
    const ok = await admin.api.call('post', url, body, im);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const cs = ok.body.outcome.create_sites;
    expect(cs.created.map((x: { site_code: string }) => x.site_code).sort()).toEqual([n1, n2, cancelled].sort());
    expect(cs).toMatchObject({ created_count: 3, skipped_count: 3 });
    const skipped = Object.fromEntries((cs.skipped as { site_code: string; code: string; reason: string; column: string | null }[]).map((s) => [s.site_code, s]));
    expect(skipped[bad1]).toMatchObject({ code: 'required', column: 'Delivery Scenario' });
    expect(skipped[bad2]).toMatchObject({ code: 'unknown_region' });
    expect(skipped[race]).toMatchObject({ code: 'duplicate' });
    expect(skipped[race]!.reason).toContain('exists already');

    // the identity of the created site, read from the Master columns into the New sites fields
    const s1 = (await siteOf(n1))!;
    expect(s1).toMatchObject({ name: `Synthetic ${n1}`, region_id: R, owner_site_id: 'OWN-F1', sub_region: 'Sub A', cluster: `CL-${TAG}`, cluster_region: R,
      latitude: '32.500000', longitude: '13.250000', site_scenario: 'Outdoor', project_phase: 'Phase 1', delivery_batch: 'Batch 7', delivery_scenario: 'new_build',
      cw_delivery_model: 'Outsourced', rf_survey_date: '2026-01-03', flags: 'yes,na,yes,na,yes,na' });
    expect((await siteOf(n2))!.region_id).toBe(R);
    expect((await siteOf(cancelled))!.overall_status).toBe('cancelled');
    expect(await siteOf(bad1)).toBeUndefined();
    expect(await siteOf(bad2)).toBeUndefined();
    // the created site runs on the workflow version in force with every task; its CW date of the file was entered and approved directly
    const active = (await q<{ id: string }>(db, 'SELECT active_workflow_id() AS id'))[0]!.id;
    expect((await q<{ w: string }>(db, 'SELECT workflow_version_id::text AS w FROM sites WHERE id = $1', [s1.id]))[0]!.w).toBe(active);
    expect(await taskOf(s1.id, 'B4')).toMatchObject({ state: 'approved', actual_date: '2026-02-10' });
    // one audit row per created site: before null, after the site, naming the run; the System Admin holds both levels (seeded group): a self-approval
    const a1 = await siteAudit(s1.id);
    expect(a1).toHaveLength(1);
    expect(a1[0]!.before).toBeNull();
    expect(a1[0]!.after).toMatchObject({ site_code: n1, source: 'master_import', master_run_id: run.body.id, self_approval: true, admin_override: false });
    expect(a1[0]!.reason).toContain(`site created from Master run ${run.body.id}`);
    expect(a1[0]!.actor_id).toBe(admin.user.id);
    // the New sites batch of the run: approved, linked to the run, processed by the apply only
    const b = await q<{ status: string; master_run_id: string; source: string; entity: string }>(db,
      'SELECT status, master_run_id::text, source, entity FROM import_batches WHERE id = $1', [cs.batch_id]);
    expect(b[0]).toMatchObject({ status: 'approved', master_run_id: run.body.id, source: 'master_import', entity: 'site' });
    const again = await admin.api.call('post', `/import-batches/${cs.batch_id}/submit`, undefined, { 'If-Match': '"1"' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('batch_processing');
    // the existing sites are untouched: the one matched at the comparison and the one created in between
    expect(await siteOf(existing)).toEqual(before);
    expect((await siteOf(race))!.name).toBe('Race name');
    expect(await siteAudit((await siteOf(race))!.id)).toHaveLength(0);
    // the run rows of the created sites are linked to them
    const linked = await q<{ c: string; s: string | null }>(db, 'SELECT site_code AS c, site_id::text AS s FROM master_reconciliation_rows WHERE run_id = $1', [run.body.id]);
    expect(Object.fromEntries(linked.map((x) => [x.c, x.s]))).toMatchObject({ [n1]: s1.id, [bad1]: null, [race]: null });
  });

  it('without the option, a file of missing sites says so and names the option', async () => {
    const admin = await plainAdmin(app, db);
    const file = await masterFile([row(1, code(), await regionName(R)), row(2, code(), await regionName(R))]);
    const run = await uploadMaster(admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const r = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`, { mode: 'submit', reason: 'Load after the reset' }, { 'If-Match': `"${run.body.version}"` });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('No typed task column of this file belongs to a site of GSDN Workspace');
    expect(r.body.detail).toContain('2 site(s) of the file are not in GSDN Workspace');
    expect(r.body.detail).toContain('Create the sites that are not in GSDN Workspace from the Master');
  });

  it('rights: refused without them (403, nothing created); the holder of both L1 and L2 creates in that region only (self-approval); a System Admin who holds neither creates as an admin override', async () => {
    const admin = await plainAdmin(app, db);
    // a delegate of the Master import (templates administer) who holds no level of site_creation: the option is not offered, and refused
    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['templates', 'view'], ['templates', 'administer'], ['templates', 'import'], ['sites', 'view'], ['sites', 'create'], ['sites', 'approve']]);
    const dgApi = await loggedIn(app, dg);
    await dgApi.stepUp(dg.password);
    const c0 = code();
    const run0 = await uploadMaster(dgApi, await masterFile([row(1, c0, await regionName(R))]));
    expect(run0.status, JSON.stringify(run0.body)).toBe(201);
    expect(run0.body.create_sites_offer.allowed).toBe(false);
    expect(run0.body.create_sites_offer.reason).toContain('both L1 and L2');
    const r0 = await dgApi.call('post', `/master-import/runs/${run0.body.id}/apply`, { mode: 'draft', reason: 'Try', create_sites: true }, { 'If-Match': `"${run0.body.version}"` });
    expect(r0.status).toBe(403);
    expect(r0.body.code).toBe('action_forbidden');
    expect(await siteOf(c0)).toBeUndefined();
    // a System Admin without a step-up: 401, nothing created
    const cold = await plainAdmin(app, db, false);
    const runC = await uploadMaster(cold.api, await masterFile([row(1, code(), await regionName(R))]));
    const rc = await cold.api.call('post', `/master-import/runs/${runC.body.id}/apply`, { mode: 'draft', reason: 'Try', create_sites: true }, { 'If-Match': `"${runC.body.version}"` });
    expect(rc.status).toBe(401);

    // the holder of both levels of site_creation in R (only L1 in OTHER): creates in R, the row of OTHER is refused with the reason
    const holder: Actor = await actor(app, db, { level: 'approve', regions: [R, OTHER], grants: [['sites', 'view'], ['sites', 'create'], ['sites', 'approve'], ['sites', 'import'], ['sites', 'edit'], ['templates', 'view'], ['templates', 'import']] });
    await delegate(db, holder.user.id, [['templates', 'view'], ['templates', 'administer']]);
    const other = await makeUser(db, { assigned: true });
    await siteCell(R, 'entry', [holder.user.id]);
    await siteCell(R, 'approve', [holder.user.id]);
    await siteCell(OTHER, 'entry', [holder.user.id]);
    await siteCell(OTHER, 'approve', [other.id]);
    const [ch, co] = [code(), code()];
    const run1 = await uploadMaster(holder.api, await masterFile([row(1, ch, await regionName(R)), row(2, co, await regionName(OTHER), { G: null })]));
    expect(run1.status, JSON.stringify(run1.body)).toBe(201);
    expect(run1.body.create_sites_offer).toMatchObject({ allowed: true, admin: false, regions: [R] });
    const r1 = await holder.api.call('post', `/master-import/runs/${run1.body.id}/apply`, { mode: 'draft', reason: 'Plan after the reset', create_sites: true }, { 'If-Match': `"${run1.body.version}"` });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.outcome.create_sites).toMatchObject({ created_count: 1, skipped_count: 1, created: [expect.objectContaining({ site_code: ch, self_approval: true })],
      skipped: [expect.objectContaining({ site_code: co, code: 'not_eligible_holder' })] });
    const sh = (await siteOf(ch))!;
    expect((await siteAudit(sh.id))[0]).toMatchObject({ is_admin_override: false, after: expect.objectContaining({ self_approval: true, admin_override: false, master_run_id: run1.body.id }) });
    const draft = await q<{ self_approval: boolean; created_by: string; decided_by: string }>(db,
      'SELECT self_approval, created_by::text, decided_by::text FROM site_drafts WHERE site_id = $1', [sh.id]);
    expect(draft[0]).toMatchObject({ self_approval: true, created_by: holder.user.id, decided_by: holder.user.id });
    expect(await siteOf(co)).toBeUndefined();

    // a System Admin who holds neither level of site_creation in R3 (the cells name another person): created as an admin override, flagged
    await siteCell(R3, 'entry', [other.id]);
    await siteCell(R3, 'approve', [other.id]);
    const ca = code();
    const run2 = await uploadMaster(admin.api, await masterFile([row(1, ca, await regionName(R3), { G: null })]));
    const r2 = await admin.api.call('post', `/master-import/runs/${run2.body.id}/apply`, { mode: 'draft', reason: 'Plan after the reset', create_sites: true }, { 'If-Match': `"${run2.body.version}"` });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.outcome.create_sites.created).toEqual([expect.objectContaining({ site_code: ca, self_approval: false })]);
    const sa = (await siteOf(ca))!;
    expect((await siteAudit(sa.id))[0]).toMatchObject({ is_admin_override: true, after: expect.objectContaining({ self_approval: false, admin_override: true }) });
  });

  it('a big run (more sites than imports.async_rows) creates the sites in the background in chunks, with its progress, then enters the dates', async () => {
    const jobs = app.get(ImportJobsService);
    jobs.autoStart = false;
    await db.query(`UPDATE settings SET value = to_jsonb(2) WHERE key = 'imports.async_rows'`);
    try {
      const admin = await plainAdmin(app, db);
      await openWaiver(admin);
      const region = await regionName(R);
      const codes = [code(), code(), code()];
      const run = await uploadMaster(admin.api, await masterFile(codes.map((c, i) => row(i + 1, c, region))));
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const queued = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
        { mode: 'submit', reason: 'Load after the reset', historical_load: { reason: REASON, approve_directly: true }, create_sites: true }, { 'If-Match': `"${run.body.version}"` });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({ status: 'applying', applying: { state: 'running', create_sites: true, phase: 'create_sites', create_done: 0 } });
      for (const c of codes) expect(await siteOf(c)).toBeUndefined();   // nothing is created in the request
      const job = (await jobs.pending(0)).find((x) => x.apply && x.job_id === queued.body.applying.job_id)!;
      // the first step stages the New sites batch, the next one creates its sites (each step its own transaction), visible as progress
      expect(await jobs.step(job)).toMatchObject({ state: 'running' });
      const p1 = await admin.api.call('get', `/master-import/runs/${run.body.id}`);
      expect(p1.body.applying).toMatchObject({ phase: 'create_sites', create_total: 3, create_done: 0 });
      expect(await jobs.step(job)).toMatchObject({ state: 'running' });
      const p2 = await admin.api.call('get', `/master-import/runs/${run.body.id}`);
      expect(p2.body.applying).toMatchObject({ phase: 'create_sites', create_total: 3, create_done: 3 });
      for (const c of codes) expect(await siteOf(c)).toBeDefined();
      await jobs.process(job);
      const done = await admin.api.call('get', `/master-import/runs/${run.body.id}`);
      expect(done.body).toMatchObject({ status: 'applied', applying: { state: 'done' }, outcome: { create_sites: { created_count: 3, skipped_count: 0 } } });
      for (const b of done.body.outcome.batches as { id: string; queued?: boolean }[]) {
        if (b.queued) await jobs.process((await jobs.pending(0)).find((x) => x.batch_id === b.id)!);
      }
      for (const c of codes) expect(await taskOf((await siteOf(c))!.id, 'B4')).toMatchObject({ state: 'approved', actual_date: '2026-02-10' });
    } finally {
      await db.query(`UPDATE settings SET value = to_jsonb(50) WHERE key = 'imports.async_rows'`);
      jobs.autoStart = true;
    }
  });
});
