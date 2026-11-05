import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDb } from './helpers';
import { cellOf, downloadTemplate, fillTemplate, load, uploadFile } from './tpl-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0070 (G1, Q460): site creation, manual and bulk, both ending at L2; the load fixes G8 and G9. Region 7 (Sebha) is the working region and region 6
 * (GM) the "other" region: no other suite sets cells of the Matrix row `site_creation` there. Every Site ID of a test is new (a random prefix), and a Site ID
 * is never reused, so the tests never collide with each other or with a second run.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 7;
const OTHER = 6;
const TAG = randomBytes(2).toString('hex').toUpperCase();
let n = 0;
const code = (): string => `SC${TAG}${String(++n).padStart(3, '0')}`;

const L1_GRANTS: [string, string][] = [['sites', 'view'], ['sites', 'create'], ['templates', 'view'], ['templates', 'import'], ['templates', 'download_documents']];
const L2_GRANTS: [string, string][] = [['sites', 'view'], ['sites', 'approve'], ['templates', 'view']];
let l1: Actor;
let l2: Actor;

/** Replaces the cell of one level of the Site creation row in a region and names its holders (a direct fixture, like setCell of the task cells). */
async function siteCell(region: number, kind: 'entry' | 'approve', users: string[]): Promise<void> {
  const level = kind === 'entry' ? 1 : 3;
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id = $3', ['site_creation', level, region]);
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('site_creation', $1, 'any_one', $2, false, now()) RETURNING id`, [level, region]);
  for (const u of users) await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, u]);
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  l1 = await actor(app, db, { level: 'entry', regions: [R], grants: L1_GRANTS });
  l2 = await actor(app, db, { level: 'approve', regions: [R], grants: L2_GRANTS });
  await siteCell(R, 'entry', [l1.user.id]);
  await siteCell(R, 'approve', [l2.user.id]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  site_code: code(), region_id: R, name: 'Synthetic Site', name_ar: 'موقع تجريبي', delivery_scenario: 'new_build', ...over,
});
const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const siteIn = async (siteCode: string): Promise<{ id: string; overall_status: string; region_id: number; name_ar: string | null; cluster_id: string | null; workflow_version_id: string } | undefined> =>
  (await q<{ id: string; overall_status: string; region_id: number; name_ar: string | null; cluster_id: string | null; workflow_version_id: string }>(
    db, 'SELECT id, overall_status::text, region_id, name_ar, cluster_id, workflow_version_id FROM sites WHERE site_code = $1', [siteCode]))[0];
const tasksOf = async (siteId: string): Promise<Record<string, { state: string; na_reason: string | null }>> =>
  Object.fromEntries((await q<{ code: string; state: string; na_reason: string | null }>(db,
    'SELECT td.code, ti.state::text, ti.na_reason FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id WHERE ti.site_id = $1', [siteId])).map((r) => [r.code, r]));
const audit = (action: string, entity: string): Promise<{ after: Record<string, unknown>; actor_id: string; reason: string | null; site_id: string | null }[]> =>
  q(db, 'SELECT after, actor_id, reason, site_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, entity]);

/** The whole manual way: draft by L1, sent, approved by L2 (with step-up). Returns the approved draft. */
async function createSite(over: Record<string, unknown> = {}): Promise<{ draft: Record<string, any>; code: string }> {
  const body = input(over);
  const c = await l1.api.call('post', '/sites', body);
  expect(c.status).toBe(201);
  const s = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(c) });
  expect(s.status).toBe(200);
  expect(s.body.status).toBe('in_approval');
  const d = await l2.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(s) });
  expect(d.status).toBe(200);
  return { draft: d.body, code: String(body.site_code) };
}

describe('manual entry: draft, L1 submit, L2 approve', () => {
  it('creates a draft, a site only on L2 approval, on the workflow in force, with its tasks, the first task open, the creation audited', async () => {
    const body = input({ cluster_code: `CL-${TAG}-1`, scope_tower_erection: 'Yes', scope_site_adaption: 'No', latitude: 32.89, longitude: 13.18, site_type: 'Core' });
    const c = await l1.api.call('post', '/sites', body);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: 'entry', site_code: body.site_code, region_id: R, allowed_actions: expect.arrayContaining(['edit', 'submit']) });
    expect(c.body.warnings).toEqual([expect.objectContaining({ code: 'cluster_will_be_created' })]);
    expect(c.body.data).toMatchObject({ delivery_scenario: 'new_build', scope_tower_erection: 'yes', scope_site_adaption: 'na', name_ar: 'موقع تجريبي' });
    expect(await siteIn(String(body.site_code))).toBeUndefined();   // a draft is not a site

    const sent = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(c) });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('in_approval');
    expect(await siteIn(String(body.site_code))).toBeUndefined();
    // L2 sees it as waiting for them; the L1 does not
    const waiting = await l2.api.call('get', '/site-drafts?waiting_for_me=true&limit=200');
    expect(waiting.status).toBe(200);
    expect(waiting.body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);
    expect((await l1.api.call('get', '/site-drafts?waiting_for_me=true&limit=200')).body.items.map((x: { id: string }) => x.id)).not.toContain(c.body.id);
    const got = await l2.api.call('get', `/site-drafts/${c.body.id}`);
    expect(got.body.allowed_actions).toEqual(['approve', 'reject']);

    const done = await l2.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(sent) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'approved', self_approval: false });
    const site = await siteIn(String(body.site_code));
    expect(site).toBeDefined();
    expect(done.body.site_id).toBe(site!.id);
    expect(site).toMatchObject({ region_id: R, overall_status: 'not_started', name_ar: 'موقع تجريبي' });
    // the workflow version in force, with every active task of it
    const active = (await q<{ id: string }>(db, 'SELECT active_workflow_id() AS id'))[0]!.id;
    expect(site!.workflow_version_id).toBe(active);
    const defs = (await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM task_definitions td JOIN stage_definitions st ON st.id = td.stage_id WHERE td.workflow_id = $1 AND td.is_active AND st.is_active', [active]))[0]!.n;
    const tasks = await tasksOf(site!.id);
    expect(Object.keys(tasks)).toHaveLength(defs);
    expect(tasks.A1!.state).toBe('open');                          // the engine opened the first task
    expect(tasks.MS10!.state).not.toBe('open');
    // the new cluster was created in the region of the site
    const cl = await q<{ cluster_code: string; region_id: number }>(db, 'SELECT cluster_code, region_id FROM clusters WHERE id = $1', [site!.cluster_id]);
    expect(cl[0]).toEqual({ cluster_code: `CL-${TAG}-1`, region_id: R });
    // the audit rows: the creation with the draft reference, the cluster, and the draft's own steps
    const created = await audit('site_create', site!.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_id: l2.user.id, site_id: site!.id });
    expect(created[0]!.after).toMatchObject({ draft_id: c.body.id, self_approval: false, cluster_created: true, created_by: l1.user.id });
    expect((await audit('site_draft_create', c.body.id)).length).toBe(1);
    expect((await audit('site_draft_submit', c.body.id)).length).toBe(1);
    // the Site Register shows it with both names (G9)
    const detail = await l2.api.call('get', `/sites/${site!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ site_code: body.site_code, name: 'Synthetic Site', name_ar: 'موقع تجريبي', region_id: R, scope_flags: { tower_erection: 'yes', site_adaption: 'na' } });
    const list = await l2.api.call('get', `/sites?q=${body.site_code}`);
    expect(list.body.items[0]).toMatchObject({ site_code: body.site_code, name_ar: 'موقع تجريبي' });
  });

  it('refuses the approval without a recent step-up, and creates nothing', async () => {
    const noStep = await actor(app, db, { level: 'approve', regions: [R], grants: L2_GRANTS, stepUp: false });
    await siteCell(R, 'approve', [l2.user.id, noStep.user.id]);
    try {
      const c = await l1.api.call('post', '/sites', input());
      const s = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(c) });
      const d = await noStep.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(s) });
      expect(d.status).toBe(401);
      expect(d.body.code).toBe('step_up_required');
      expect(await siteIn(String(c.body.site_code))).toBeUndefined();
      expect((await l2.api.call('get', `/site-drafts/${c.body.id}`)).body.status).toBe('in_approval');
    } finally {
      await siteCell(R, 'approve', [l2.user.id]);
    }
  });

  it('returns a draft to L1 with a mandatory note, L1 edits it and sends it again', async () => {
    const c = await l1.api.call('post', '/sites', input());
    const s = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(c) });
    const noNote = await l2.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'reject' }, { 'If-Match': etag(s) });
    expect(noNote.status).toBe(422);
    expect(noNote.body.code).toBe('note_required');
    const back = await l2.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'reject', note: 'Name is wrong' }, { 'If-Match': etag(s) });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'entry', return_count: 1, last_return_note: 'Name is wrong' });
    // L2 cannot edit; L1 can, and the second send is approved
    const denied = await l2.api.call('patch', `/site-drafts/${c.body.id}`, input({ site_code: c.body.site_code }), { 'If-Match': etag(back) });
    expect(denied.status).toBe(403);
    const edited = await l1.api.call('patch', `/site-drafts/${c.body.id}`, input({ site_code: c.body.site_code, name: 'Right name' }), { 'If-Match': etag(back) });
    expect(edited.status).toBe(200);
    expect(edited.body.data.name).toBe('Right name');
    const again = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(edited) });
    const ok = await l2.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(again) });
    expect(ok.body.status).toBe('approved');
    expect((await audit('site_draft_return', c.body.id)).length).toBe(1);
    expect((await audit('site_draft_update', c.body.id)).length).toBe(1);
  });

  it('discards a draft in entry and frees its Site ID; a stale If-Match is refused', async () => {
    const body = input();
    const c = await l1.api.call('post', '/sites', body);
    expect((await l1.api.call('post', '/sites', body)).status).toBe(422);     // the open draft holds the Site ID
    const stale = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': '"99"' });
    expect(stale.status).toBe(412);
    const gone = await l1.api.call('delete', `/site-drafts/${c.body.id}`, undefined, { 'If-Match': etag(c) });
    expect(gone.status).toBe(200);
    expect(gone.body.status).toBe('discarded');
    expect((await l1.api.call('post', '/sites', body)).status).toBe(201);      // free again
  });

  it('a person who holds both levels approves their own submission at once: step-up, flagged, audited', async () => {
    const both = await actor(app, db, { level: 'approve', regions: [R], grants: [...L1_GRANTS, ['sites', 'approve']] });
    const other = 5;
    await siteCell(other, 'entry', [both.user.id]);
    await siteCell(other, 'approve', [both.user.id]);
    const body = input({ region_id: other });
    const c = await both.api.call('post', '/sites', body);
    expect(c.status).toBe(403);       // the grants are for the working region only
    // in the working region the same person holds both cells
    await siteCell(R, 'entry', [l1.user.id, both.user.id]);
    await siteCell(R, 'approve', [l2.user.id, both.user.id]);
    try {
      const b2 = input();
      const c2 = await both.api.call('post', '/sites', b2);
      expect(c2.status).toBe(201);
      const s2 = await both.api.call('post', `/site-drafts/${c2.body.id}/submit`, undefined, { 'If-Match': etag(c2) });
      expect(s2.status).toBe(200);
      expect(s2.body).toMatchObject({ status: 'approved', self_approval: true });
      const site = await siteIn(String(b2.site_code));
      expect(site).toBeDefined();
      expect((await audit('site_create', site!.id))[0]!.after).toMatchObject({ self_approval: true });
    } finally {
      await siteCell(R, 'entry', [l1.user.id]);
      await siteCell(R, 'approve', [l2.user.id]);
    }
    // without a step-up the self-approval is refused and nothing is created
    const nostep = await actor(app, db, { level: 'approve', regions: [R], grants: [...L1_GRANTS, ['sites', 'approve']], stepUp: false });
    await siteCell(R, 'entry', [l1.user.id, nostep.user.id]);
    await siteCell(R, 'approve', [l2.user.id, nostep.user.id]);
    try {
      const b3 = input();
      const c3 = await nostep.api.call('post', '/sites', b3);
      const s3 = await nostep.api.call('post', `/site-drafts/${c3.body.id}/submit`, undefined, { 'If-Match': etag(c3) });
      expect(s3.status).toBe(401);
      expect(s3.body.code).toBe('step_up_required');
      expect(await siteIn(String(b3.site_code))).toBeUndefined();
    } finally {
      await siteCell(R, 'entry', [l1.user.id]);
      await siteCell(R, 'approve', [l2.user.id]);
    }
  });
});

describe('validation (field errors in the usual problem format)', () => {
  it('refuses a duplicate Site ID: a site (a cancelled one too, in any letter case) and a draft that waits', async () => {
    const first = await createSite({ overall_status: 'Cancelled' });
    const site = await siteIn(first.code);
    expect(site!.overall_status).toBe('cancelled');
    for (const variant of [first.code, first.code.toLowerCase(), `  ${first.code}  `]) {
      const res = await l1.api.call('post', '/sites', input({ site_code: variant }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors).toEqual([expect.objectContaining({ path: '/site_code', code: 'duplicate' })]);
    }
    const waiting = input();
    expect((await l1.api.call('post', '/sites', waiting)).status).toBe(201);
    const dup = await l1.api.call('post', '/sites', waiting);
    expect(dup.body.errors).toEqual([expect.objectContaining({ path: '/site_code', code: 'duplicate' })]);
  });

  it('resolves a region alias, and refuses an unknown region', async () => {
    const alias = await l1.api.call('post', '/sites', input({ region_id: undefined, region: 'Sebha Area' }));
    expect(alias.status).toBe(201);
    expect(alias.body.region_id).toBe(R);
    const arabic = await l1.api.call('post', '/sites', input({ region_id: undefined, region: 'سبها' }));
    expect(arabic.status).toBe(201);
    const unknown = await l1.api.call('post', '/sites', input({ region_id: undefined, region: 'Atlantis' }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toEqual([expect.objectContaining({ path: '/region', code: 'unknown_region' })]);
    const none = await l1.api.call('post', '/sites', input({ region_id: undefined }));
    expect(none.body.errors).toEqual([expect.objectContaining({ path: '/region', code: 'required' })]);
    const clash = await l1.api.call('post', '/sites', input({ region_id: OTHER, region: 'Sebha' }));
    expect(clash.body.errors).toEqual([expect.objectContaining({ path: '/region', code: 'region_mismatch' })]);
  });

  it('checks every field: scenario, lists, flags, dates, coordinates, names, unknown (personal data) fields, cluster of another region', async () => {
    const bad = await l1.api.call('post', '/sites', input({
      delivery_scenario: 'Teleport', site_scenario: 'Underwater', scope_gecol_power: 'Maybe', rf_survey_date: '2999-01-01', latitude: 95, longitude: 'x',
      name: '', overall_status: 'Completed',
    }));
    expect(bad.status).toBe(422);
    const paths = Object.fromEntries((bad.body.errors as { path: string; code: string }[]).map((e) => [e.path, e.code]));
    expect(paths).toMatchObject({ '/delivery_scenario': 'not_in_list', '/site_scenario': 'not_in_list', '/scope_gecol_power': 'invalid', '/rf_survey_date': 'future_date',
      '/latitude': 'invalid', '/longitude': 'invalid', '/name': 'required', '/overall_status': 'invalid' });
    // the Site Type list allows another value (a warning, not an error), as the catalogue says
    const other = await l1.api.call('post', '/sites', input({ site_type: 'Castle' }));
    expect(other.status).toBe(201);
    expect(other.body.warnings).toEqual([expect.objectContaining({ field: 'site_type', code: 'list_other' })]);
    const pair = await l1.api.call('post', '/sites', input({ latitude: 32.5 }));
    expect(pair.body.errors).toEqual([expect.objectContaining({ path: '/longitude', code: 'pair_required' })]);
    const badDate = await l1.api.call('post', '/sites', input({ rf_survey_date: '2026-02-31' }));
    expect(badDate.body.errors).toEqual([expect.objectContaining({ path: '/rf_survey_date', code: 'invalid' })]);
    // Q469: landlord and contact data are not loaded: an unknown field is refused, nothing is kept
    const personal = await l1.api.call('post', '/sites', input({ landlord_name: 'Someone', phone: '+218910000000', email: 'x@example.test' }));
    expect(personal.status).toBe(422);
    expect((personal.body.errors as { code: string }[]).every((e) => e.code === 'unknown_field')).toBe(true);
    expect((personal.body.errors as { path: string }[]).map((e) => e.path).sort()).toEqual(['/email', '/landlord_name', '/phone']);
    // a cluster that belongs to another region is refused; a global one is accepted
    const foreign = `CLF-${TAG}`;
    await db.query(`INSERT INTO clusters (cluster_code, region_id, is_global) VALUES ($1, $2, false)`, [foreign, OTHER]);
    const cl = await l1.api.call('post', '/sites', input({ cluster_code: foreign }));
    expect(cl.status, JSON.stringify(cl.body)).toBe(422);
    expect(cl.body.errors).toEqual([expect.objectContaining({ path: '/cluster_code', code: 'cluster_other_region' })]);
    await db.query(`INSERT INTO clusters (cluster_code, is_global) VALUES ($1, true) ON CONFLICT DO NOTHING`, [`CLG-${TAG}`]);
    expect((await l1.api.call('post', '/sites', input({ cluster_code: `clg-${TAG}` }))).status).toBe(201);
    // nothing but plain values in the body
    expect((await l1.api.call('post', '/sites', { ...input(), name: { a: 1 } })).status).toBe(422);
    expect((await l1.api.call('post', '/sites', [1, 2])).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a Hot Swap with a scope flag Yes at entry (the scenario rules of P1), and accepts it without the flag', async () => {
    const conflict = await l1.api.call('post', '/sites', input({ delivery_scenario: 'Hot Swap', scope_gecol_power: 'Yes' }));
    expect(conflict.status).toBe(422);
    expect(conflict.body.errors).toEqual([expect.objectContaining({ path: '/delivery_scenario', code: 'scope_scenario_conflict' })]);
  });
});

describe('on approval: the scenario applicability of P1 is applied, a cancelled row is cancelled (Q466)', () => {
  it('a Hot Swap site has its scenario tasks N/A and the next task open; every N/A is audited', async () => {
    const { draft, code: c } = await createSite({ delivery_scenario: 'Hot Swap' });
    const site = await siteIn(c);
    expect(draft.site_id).toBe(site!.id);
    const tasks = await tasksOf(site!.id);
    expect(tasks.A1).toMatchObject({ state: 'na' });
    expect(tasks.A1!.na_reason).toMatch(/^applicability:/);
    expect(tasks.A3).toMatchObject({ state: 'na' });
    expect(tasks.A2!.state).toBe('open');                                   // the chain moved on after A1 became N/A
    const rows = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_applicability_na' AND site_id = $1`, [site!.id]);
    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(((await audit('site_create', site!.id))[0]!.after as { applicability_changed: number }).applicability_changed).toBeGreaterThan(0);
  });

  it('a New Build with the CW scope has its CW tasks applicable, and without it they are N/A', async () => {
    const withScope = await createSite({ scope_tower_erection: 'Yes', scope_site_adaption: 'Yes' });
    const t1 = await tasksOf((await siteIn(withScope.code))!.id);
    expect(t1.A1!.state).toBe('open');
    expect(t1.B1!.state).not.toBe('na');
    const without = await createSite();
    const t2 = await tasksOf((await siteIn(without.code))!.id);
    expect(t2.B1).toMatchObject({ state: 'na' });
  });

  it('a Cancelled row creates the site and then sets it cancelled; both are audited', async () => {
    const { code: c } = await createSite({ overall_status: 'Cancelled' });
    const site = await siteIn(c);
    expect(site!.overall_status).toBe('cancelled');
    expect(Object.keys(await tasksOf(site!.id)).length).toBeGreaterThan(10);     // its history exists
    expect((await audit('site_create', site!.id)).length).toBe(1);
    const cancelled = await audit('site_cancelled', site!.id);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.reason).toContain('Q466');
  });

  it('wf_apply_applicability(uuid) is the wrapper of P4a: it applies the rules, and leaves a scenario and scope conflict alone', async () => {
    const { code: c } = await createSite({ scope_tower_erection: 'Yes' });
    const site = (await siteIn(c))!;
    const ok = await q<{ r: { site_id: string; changed: unknown[] } }>(db, 'SELECT wf_apply_applicability($1) AS r', [site.id]);
    expect(ok[0]!.r.site_id).toBe(site.id);
    // the hook of P4a reaches it by name
    const hook = await q<{ r: unknown }>(db, `SELECT p4a_hook('wf_apply_applicability', $1) AS r`, [site.id]);
    expect(hook[0]!.r).not.toBeNull();
    // a conflict (changed behind the validation): nothing is touched and it says so
    await db.query(`UPDATE sites SET delivery_scenario = 'hot_swap', scope_gecol_power = 'yes' WHERE id = $1`, [site.id]);
    const skipped = await q<{ r: { skipped?: string } }>(db, 'SELECT wf_apply_applicability($1) AS r', [site.id]);
    expect(skipped[0]!.r.skipped).toBe('scope_scenario_conflict');
    expect((await q<{ r: unknown }>(db, 'SELECT wf_apply_applicability($1) AS r', ['00000000-0000-4000-8000-000000000999']))[0]!.r).toBeNull();
  });
});

describe('rights', () => {
  it('a caller without the create right on sites is refused (403) and the list answers module_forbidden without the module', async () => {
    const viewer = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view']] });
    const denied = await viewer.api.call('post', '/sites', input());
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    const none = await actor(app, db, { grants: [['warehouse', 'view']] });
    const list = await none.api.call('get', '/site-drafts');
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('module_forbidden');
    expect((await new Api(app).call('post', '/sites', input())).status).toBe(401);
  });

  it('a holder of create for another region only is refused for this region; the Matrix holder alone is not enough either', async () => {
    const elsewhere = await actor(app, db, { level: 'entry', regions: [OTHER], grants: L1_GRANTS });
    await siteCell(OTHER, 'entry', [elsewhere.user.id]);
    const res = await elsewhere.api.call('post', '/sites', input());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
    // the right of the grid in the region, but not named in the Matrix row
    const unnamed = await actor(app, db, { level: 'entry', regions: [R], grants: L1_GRANTS });
    const notHolder = await unnamed.api.call('post', '/sites', input());
    expect(notHolder.status).toBe(403);
    expect(notHolder.body.code).toBe('not_eligible_holder');
    // L1 cannot approve, L2 cannot enter: each level has its own holders
    const c = await l1.api.call('post', '/sites', input());
    const s = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(c) });
    const l1tries = await l1.api.call('post', `/site-drafts/${c.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(s) });
    expect(l1tries.status).toBe(403);
    expect(await siteIn(String(c.body.site_code))).toBeUndefined();
    expect((await l2.api.call('post', '/sites', input())).status).toBe(403);
    // a draft of this region is a 404 for a caller who holds only the other region
    expect((await elsewhere.api.call('get', `/site-drafts/${c.body.id}`)).status).toBe(404);
    expect((await elsewhere.api.call('get', '/site-drafts?limit=200')).body.items.map((x: { id: string }) => x.id)).not.toContain(c.body.id);
  });
});

describe('the bulk way: the approved template "New sites"', () => {
  it('is listed, downloads with the hidden _tpl sheet, and has no landlord or contact column', async () => {
    const list = await l1.api.call('get', '/templates');
    const t = list.body.items.find((x: { template_id: string }) => x.template_id === 'TPL-SITE-NEW');
    expect(t).toMatchObject({ template_kind: 'sites', module_key: 'sites', name_en: 'New sites' });
    // a caller who may not create sites does not see it
    const viewer = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['templates', 'view']] });
    expect((await viewer.api.call('get', '/templates')).body.items.map((x: { template_id: string }) => x.template_id)).not.toContain('TPL-SITE-NEW');
    const dl = await downloadTemplate(l1.api, 'TPL-SITE-NEW');
    expect(dl.status).toBe(200);
    const wb = await load(dl.buffer);
    const tpl = wb.getWorksheet('_tpl')!;
    expect(tpl.state).toBe('veryHidden');
    const kv = new Map<string, string>();
    tpl.eachRow((row) => kv.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(kv.get('template_id')).toBe('TPL-SITE-NEW');
    expect(Number(kv.get('version'))).toBeGreaterThanOrEqual(1);
    const headers = (wb.getWorksheet('Data')!.getRow(1).values as unknown[]).slice(1).map(String);
    expect(headers).toEqual(expect.arrayContaining(['Site ID', 'Region', 'Site Name (EN)', 'Site Name (AR)', 'Cluster', 'Delivery Scenario', 'Tower Erection', 'Overall Status', 'Latitude', 'RF Survey Date']));
    expect(headers.join('|').toLowerCase()).not.toMatch(/landlord|owner name|contact|phone|e-?mail/);
    expect((await downloadTemplate(viewer.api, 'TPL-SITE-NEW')).status).toBe(403);
  });

  it('stages a file: valid rows, a duplicate Site ID, an unknown region, a Cancelled row; the preview shows each row; nothing is a site yet', async () => {
    const a = code(), b = code(), c = code(), dupIn = code(), existing = (await createSite()).code;
    const file = await fillTemplate((await downloadTemplate(l1.api, 'TPL-SITE-NEW')).buffer, [
      { 'Site ID': a, Region: 'Sebha Area', 'Site Name (EN)': 'Bulk A', 'Site Name (AR)': 'موقع أ', 'Delivery Scenario': 'New Build', Cluster: `CLB-${TAG}`, 'Tower Erection': 'Yes', Latitude: 27.04, Longitude: 14.43 },
      { 'Site ID': b, Region: 'Sebha', 'Site Name (EN)': 'Bulk B', 'Delivery Scenario': 'Expansion', 'RF Survey Date': new Date('2026-03-02T00:00:00.000Z') },
      { 'Site ID': c, Region: 'Sebha', 'Site Name (EN)': 'Bulk C (cancelled)', 'Delivery Scenario': 'New Build', 'Overall Status': 'Cancelled' },
      { 'Site ID': existing, Region: 'Sebha', 'Site Name (EN)': 'Dup of a site', 'Delivery Scenario': 'New Build' },
      { 'Site ID': dupIn, Region: 'Atlantis', 'Site Name (EN)': 'Bad region', 'Delivery Scenario': 'New Build' },
      { 'Site ID': a, Region: 'Sebha', 'Site Name (EN)': 'Same as row 1', 'Delivery Scenario': 'New Build' },
    ]);
    const up = await uploadFile(l1.api, file);
    expect(up.status).toBe(202);
    expect(up.body).toMatchObject({ template_id: 'TPL-SITE-NEW', status: 'validated', entity: 'site', register_key: null, counts: { create: 3, error: 3 } });
    const rows = (await l1.api.call('get', `/import-batches/${up.body.id}/rows?limit=50`)).body.items as Record<string, any>[];
    expect(rows.map((r) => r.action)).toEqual(['create', 'create', 'create', 'error', 'error', 'error']);
    expect(rows[0]).toMatchObject({ key: a, site_code: a, diff: { site_code: { old: null, new: a }, region_id: { old: null, new: R }, name_ar: { old: null, new: 'موقع أ' } } });
    expect(rows[0]!.warnings).toEqual([expect.objectContaining({ code: 'cluster_will_be_created' })]);
    expect(rows[3]!.errors).toEqual([expect.objectContaining({ field: 'site_code', code: 'duplicate', column: 'Site ID' })]);
    expect(rows[4]!.errors).toEqual([expect.objectContaining({ field: 'region', code: 'unknown_region', column: 'Region' })]);
    expect(rows[5]!.errors).toEqual([expect.objectContaining({ field: 'site_code', code: 'duplicate_in_file' })]);
    for (const x of [a, b, c]) expect(await siteIn(x)).toBeUndefined();
  });

  it('sends a batch, L2 approves one row, then the rest at once; a return needs a note; the cancelled row is cancelled; step-up and rights are checked', async () => {
    const [a, b, c, d] = [code(), code(), code(), code()];
    const file = await fillTemplate((await downloadTemplate(l1.api, 'TPL-SITE-NEW')).buffer, [
      { 'Site ID': a, Region: 'Sebha', 'Site Name (EN)': 'Bulk A', 'Site Name (AR)': 'موقع أ', 'Delivery Scenario': 'New Build', Cluster: `CLB2-${TAG}` },
      { 'Site ID': b, Region: 'Sebha', 'Site Name (EN)': 'Bulk B', 'Delivery Scenario': 'Hot Swap' },
      { 'Site ID': c, Region: 'Sebha', 'Site Name (EN)': 'Bulk C', 'Delivery Scenario': 'New Build', 'Overall Status': 'Cancelled' },
      { 'Site ID': d, Region: 'Sebha', 'Site Name (EN)': 'Bulk D', 'Delivery Scenario': 'New Build' },
    ]);
    const up = await uploadFile(l1.api, file);
    expect(up.status).toBe(202);
    expect(up.body.counts.create).toBe(4);
    const id = up.body.id as string;

    // only the uploader sends it
    expect((await l2.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': etag(up) })).status).toBe(403);
    const sent = await l1.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': etag(up) });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('in_approval');
    expect(sent.body.outcome).toMatchObject({ submitted: 4, failed: [] });
    for (const x of [a, b, c, d]) expect(await siteIn(x)).toBeUndefined();
    // the rows are site drafts waiting for L2
    expect((await l2.api.call('get', `/site-drafts?waiting_for_me=false&status=in_approval&q=${TAG}&limit=100`)).body.items.filter((x: { batch_id: string }) => x.batch_id === id)).toHaveLength(4);
    // a draft of a batch is decided in its batch, never alone
    const one_ = await l2.api.call('get', `/site-drafts?q=${a}`);
    const draftId = (one_.body.items[0] as { id: string }).id;
    const draftTag = etag(await l2.api.call('get', `/site-drafts/${draftId}`));
    const alone = await l2.api.call('post', `/site-drafts/${draftId}/decide`, { action: 'approve' }, { 'If-Match': draftTag });
    expect(alone.status).toBe(409);
    expect(alone.body.code).toBe('invalid_transition');

    // L1 cannot decide; L2 without a step-up cannot approve
    expect((await l1.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(sent) })).status).toBe(403);
    const noStep = await actor(app, db, { level: 'approve', regions: [R], grants: L2_GRANTS, stepUp: false });
    await siteCell(R, 'approve', [l2.user.id, noStep.user.id]);
    try {
      const refused = await noStep.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(sent) });
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('step_up_required');
    } finally {
      await siteCell(R, 'approve', [l2.user.id]);
    }
    expect(await siteIn(a)).toBeUndefined();

    const rows = (await l2.api.call('get', `/import-batches/${id}/rows?limit=50`)).body.items as Record<string, any>[];
    const rowA = rows.find((r) => r.key === a)!, rowD = rows.find((r) => r.key === d)!;
    // row by row: approve A, return D with a note (a note is required)
    const noNote = await l2.api.call('post', `/import-batches/${id}/decisions`, { action: 'reject', scope: 'rows', rows: [{ row_id: rowD.id, decision: 'rejected' }] }, { 'If-Match': etag(sent) });
    expect(noNote.status).toBe(422);
    expect(noNote.body.code).toBe('note_required');
    const one = await l2.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'rows', rows: [{ row_id: rowA.id, decision: 'approved' }] }, { 'If-Match': etag(sent) });
    expect(one.status).toBe(200);
    expect(one.body.status).toBe('partially_approved');
    expect(one.body.outcome).toMatchObject({ approved: 1, rejected: 0 });
    const siteA = (await siteIn(a))!;
    expect(siteA).toMatchObject({ region_id: R, name_ar: 'موقع أ' });
    expect((await tasksOf(siteA.id)).A1!.state).toBe('open');
    const back = await l2.api.call('post', `/import-batches/${id}/decisions`, { action: 'reject', scope: 'rows', rows: [{ row_id: rowD.id, decision: 'rejected', note: 'Not in scope' }] }, { 'If-Match': etag(one) });
    expect(back.status).toBe(200);
    expect(back.body.outcome).toMatchObject({ approved: 0, rejected: 1 });
    expect(await siteIn(d)).toBeUndefined();
    // the rest at once
    const rest = await l2.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(back) });
    expect(rest.status).toBe(200);
    expect(rest.body.status).toBe('approved');
    expect(rest.body.outcome).toMatchObject({ approved: 2, failed: [] });
    expect((await siteIn(b))).toBeDefined();
    const siteC = (await siteIn(c))!;
    expect(siteC.overall_status).toBe('cancelled');                                // Q466
    expect((await tasksOf((await siteIn(b))!.id)).A1).toMatchObject({ state: 'na' });   // Hot Swap: applicability applied
    expect((await audit('site_cancelled', siteC.id)).length).toBe(1);
    // the audit shows the batch and the row
    const created = (await audit('site_create', siteA.id))[0]!;
    expect(created.after).toMatchObject({ batch_id: id, batch_row_id: rowA.id, created_by: l1.user.id });
    expect(created.reason).toContain(id);
    // rows now carry the site they created
    const after = (await l2.api.call('get', `/import-batches/${id}/rows?limit=50`)).body.items as Record<string, any>[];
    expect(after.find((r) => r.key === a)).toMatchObject({ decision: 'approved', site_id: siteA.id });
    expect(after.find((r) => r.key === d)).toMatchObject({ decision: 'rejected', note: 'Not in scope', site_id: null });
    // the Site ID of the returned row is free (an uploader corrects the file); a returned draft is final
    expect((await l1.api.call('post', '/sites', input({ site_code: d }))).status).toBe(201);
  });

  it('the batch of a sender who also holds L2 is approved at once with a step-up (B5); an unsent batch can be discarded', async () => {
    const both = await actor(app, db, { level: 'approve', regions: [R], grants: [...L1_GRANTS, ['sites', 'approve']] });
    await siteCell(R, 'entry', [l1.user.id, both.user.id]);
    await siteCell(R, 'approve', [l2.user.id, both.user.id]);
    try {
      const x = code();
      const file = await fillTemplate((await downloadTemplate(both.api, 'TPL-SITE-NEW')).buffer, [{ 'Site ID': x, Region: 'Sebha', 'Site Name (EN)': 'Self', 'Delivery Scenario': 'New Build' }]);
      const up = await uploadFile(both.api, file);
      const sent = await both.api.call('post', `/import-batches/${up.body.id}/submit`, undefined, { 'If-Match': etag(up) });
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe('approved');
      const site = (await siteIn(x))!;
      expect((await audit('site_create', site.id))[0]!.after).toMatchObject({ self_approval: true });
    } finally {
      await siteCell(R, 'entry', [l1.user.id]);
      await siteCell(R, 'approve', [l2.user.id]);
    }
    const y = code();
    const file2 = await fillTemplate((await downloadTemplate(l1.api, 'TPL-SITE-NEW')).buffer, [{ 'Site ID': y, Region: 'Sebha', 'Site Name (EN)': 'Dropped', 'Delivery Scenario': 'New Build' }]);
    const up2 = await uploadFile(l1.api, file2);
    const gone = await l1.api.call('post', `/import-batches/${up2.body.id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': etag(up2) });
    expect(gone.status).toBe(200);
    expect(gone.body.status).toBe('discarded');
    expect(await siteIn(y)).toBeUndefined();
  });

  it('refuses a file of an old or foreign template and writes the reason to the System Log', async () => {
    const fresh = (await downloadTemplate(l1.api, 'TPL-SITE-NEW')).buffer;
    const row = { 'Site ID': code(), Region: 'Sebha', 'Site Name (EN)': 'X', 'Delivery Scenario': 'New Build' };
    const reasons = async (reason: string): Promise<number> => (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM system_log WHERE source = 'template-check' AND context ->> 'reason' = $1 AND user_id = $2`, [reason, l1.user.id]))[0]!.n;

    // a version that was never issued
    const never = await fillTemplate(fresh, [row], { edit: (wb) => { const t = wb.getWorksheet('_tpl')!; t.eachRow((r) => { if (r.getCell(1).value === 'version') r.getCell(2).value = 99; }); } });
    const r1 = await uploadFile(l1.api, never, 'refused.xlsx');
    expect(r1.status).toBe(422);
    expect(r1.body).toMatchObject({ code: 'template_rejected', reason: 'tpl_invalid' });
    // a changed header row
    const renamed = await fillTemplate(fresh, [row], { edit: (wb) => { wb.getWorksheet('Data')!.getRow(1).getCell(1).value = 'Site Code'; } });
    const r2 = await uploadFile(l1.api, renamed, 'refused.xlsx');
    expect(r2.body).toMatchObject({ code: 'template_rejected', reason: 'checksum_mismatch' });
    // a file that is not a PMIS template (no _tpl sheet)
    const foreign = await fillTemplate(fresh, [row], { edit: (wb) => { wb.removeWorksheet('_tpl'); } });
    const r3 = await uploadFile(l1.api, foreign, 'refused.xlsx');
    expect(r3.body).toMatchObject({ code: 'template_rejected', reason: 'tpl_missing' });
    // another template's file selected as the New sites template
    const r4 = await uploadFile(l1.api, fresh, 'refused.xlsx', { template_id: 'TPL-GECOL' });
    expect(r4.body).toMatchObject({ code: 'template_rejected', reason: 'wrong_template' });
    // the first version of a template whose typed columns changed: an old file is refused with the list of changes
    const v = await q<{ id: string }>(db, `SELECT v.id FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current`);
    expect(v).toHaveLength(1);
    for (const reason of ['tpl_invalid', 'checksum_mismatch', 'tpl_missing', 'wrong_template']) expect(await reasons(reason)).toBeGreaterThan(0);
    // nothing was staged
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM import_batches WHERE uploaded_by = $1 AND file_name = 'refused.xlsx'`, [l1.user.id]))[0]!.n).toBe(0);
  });

  it('a new template version refuses a file of the old version when a typed column changed, and accepts it when only a list changed', async () => {
    const old = (await downloadTemplate(l1.api, 'TPL-SITE-NEW')).buffer;
    const cur = (await q<{ version: number }>(db, `SELECT current_version AS version FROM template_definitions WHERE template_id = 'TPL-SITE-NEW'`))[0]!.version;
    // a list value of the Site Type list changes: the version moves, a typed column (the list) changes, so the old file is refused
    await db.query(`INSERT INTO list_values (catalogue_code, code, label_en, sort_order) VALUES ('SiteType', $1, $1, 500)`, [`Probe${TAG}`]);
    try {
      const now = (await q<{ version: number }>(db, `SELECT current_version AS version FROM template_definitions WHERE template_id = 'TPL-SITE-NEW'`))[0]!.version;
      expect(now).toBeGreaterThan(cur);
      const file = await fillTemplate(old, [{ 'Site ID': code(), Region: 'Sebha', 'Site Name (EN)': 'Old file', 'Delivery Scenario': 'New Build' }]);
      const res = await uploadFile(l1.api, file, 'refused-old.xlsx');
      // a changed list of a typed column is a change of an input column: the old file is refused and the reason names the version
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'outdated_version' });
      expect(res.body.detail).toContain(`version ${cur}`);
    } finally {
      await db.query(`UPDATE list_values SET is_active = false WHERE catalogue_code = 'SiteType' AND code = $1`, [`Probe${TAG}`]);
    }
    expect(cellOf((await load(old)).getWorksheet('Data')!, 1, 'Site ID')).toBe('Site ID');
  });
});

describe('G8 (the Site Scenario list) and G9 (the Arabic name)', () => {
  it('RF & Design reads its own list SiteScenario (Indoor, Outdoor, pending), not the Delivery Scenario', async () => {
    const f = await q<{ list_catalogue: string; options: string[] }>(db, `SELECT list_catalogue, options FROM register_fields WHERE register_key = 'rf_design' AND code = 'site_scenario'`);
    expect(f[0]!.list_catalogue).toBe('SiteScenario');
    expect(f[0]!.options).toEqual(expect.arrayContaining(['Indoor', 'Outdoor']));
    expect(f[0]!.options).not.toContain('New Build');
    const cat = await q<{ status: string; critical: boolean }>(db, `SELECT status, critical FROM list_catalogues WHERE code = 'SiteScenario'`);
    expect(cat[0]).toMatchObject({ status: 'pending' });
    const admin = await plainAdmin(app, db);
    const lists = await admin.api.call('get', '/list-catalogues');
    expect(lists.body.items.find((x: { code: string }) => x.code === 'SiteScenario')).toBeDefined();
  });

  it('the Site Register shows the Arabic name next to the English one', async () => {
    const { code: c } = await createSite({ name: 'English Name', name_ar: 'الاسم العربي' });
    const list = await l2.api.call('get', `/sites?q=${c}`);
    expect(list.body.items[0]).toMatchObject({ name: 'English Name', name_ar: 'الاسم العربي' });
    const bare = await createSite({ name_ar: undefined });
    expect((await l2.api.call('get', `/sites?q=${bare.code}`)).body.items[0].name_ar).toBeNull();
  });
});

describe('the Matrix row Site creation', () => {
  it('is a row of the Responsibility Matrix with L1 and L2, editable like the others, and not an enabled register', async () => {
    const admin = await plainAdmin(app, db);
    const m = await admin.api.call('get', '/matrix');
    expect(m.status).toBe(200);
    const row = m.body.stages.find((s: { register_key: string | null }) => s.register_key === 'site_creation');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ kind: 'register', name_en: 'Site creation', approval_levels: 2 });
    expect(row.cells.some((c: { level_code: string }) => c.level_code === 'L1')).toBe(true);
    expect(row.cells.some((c: { level_code: string }) => c.level_code === 'L2')).toBe(true);
    const regs = await admin.api.call('get', '/registers');
    expect(JSON.stringify(regs.body)).not.toContain('site_creation');
    // the seeded default holder is the System Admins group (global cells), unless an install has no group yet
    const seeded = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM matrix_cells c JOIN matrix_cell_assignees a ON a.cell_id = c.id AND a.kind = 'group'
      WHERE c.register_key = 'site_creation' AND c.region_id IS NULL AND c.is_global`);
    expect(seeded[0]!.n).toBe(2);
  });
});
