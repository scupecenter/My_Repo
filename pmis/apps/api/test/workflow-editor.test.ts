import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, startApp, superDbWfe } from './helpers';
import { Actor, actor, etag, makeSite, plainAdmin } from './wf-helpers';

/**
 * Migration 0090 (owner decision 4 of 2026-11-12): the workflow editor. Its own database (TEST_DATABASE_URL_WFE): the suite creates a draft, edits it and
 * publishes it, which changes the version every new site uses. The tests build on one another, in order.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_WFE as string });
  db = await superDbWfe();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const REASON = 'The owner asked for an extra inspection step';
const BASE = '/workflow/versions';
interface Placement { task_code: string; stage_code: string; predecessors: string[]; name_en: string; is_active: boolean; counts_toward_milestone: boolean }

let draft = 0;
let tag = `P${Date.now().toString(36).slice(-4).toUpperCase()}`;
let stage = '';
let existing = '';

const hdr = (t: string): Record<string, string> => ({ 'If-Match': t });
const current = async (api: Api, v: number): Promise<{ body: { placements: Placement[]; version_etag: number; milestones: { code: string; name_en: string }[]; status: string }; tag: string }> => {
  const r = await api.call('get', `${BASE}/${v}`);
  expect(r.status).toBe(200);
  return { body: r.body, tag: etag(r) };
};

describe('reads', () => {
  it('lists the versions and reads version 1 with its placements, for any signed-in user', async () => {
    const list = await plain.api.call('get', BASE);
    expect(list.status).toBe(200);
    expect(list.body.items.some((v: { version: number; status: string }) => v.version === 1 && v.status === 'published')).toBe(true);
    const v1 = await current(plain.api, 1);
    expect(v1.body.placements.length).toBeGreaterThan(20);
    expect(v1.body.placements[0]).toMatchObject({ is_active: true });
    stage = v1.body.placements[0]!.stage_code;
    existing = v1.body.placements.find((p) => p.stage_code === stage)!.task_code;
    expect((await plain.api.call('get', `${BASE}/9999`)).status).toBe(404);
    expect((await new Api(app).raw('get', BASE)).status).toBe(401);
  });

  it('GET /settings/task-definitions lists the tasks of the current version', async () => {
    const r = await plain.api.call('get', '/settings/task-definitions');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(20);
    expect(r.body.items.find((t: { code: string }) => t.code === existing)).toMatchObject({ stage_code: stage, is_active: true });
  });
});

describe('phase 2: insert a task between existing tasks (migration 0094)', () => {
  let pred = '';
  let succ = '';
  let sstage = '';
  let code = '';
  let site = '';
  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    stage_code: sstage, code, name_en: 'Extra step', name_ar: 'خطوة إضافية', counts_toward_milestone: false, predecessors: [pred], successors: [succ],
    remove_direct_links: true, reason: REASON, ...over,
  });

  it('previews the affected chain (admin only) and refuses a cycle with a clear error', async () => {
    const v1 = await current(admin.api, 1);
    const s = v1.body.placements.find((x) => x.is_active && x.predecessors.length > 0 && v1.body.placements.some((y) => y.task_code === x.predecessors[0] && y.is_active))!;
    succ = s.task_code;
    pred = s.predecessors[0]!;
    sstage = s.stage_code;
    code = `${tag}I`;
    const pv = await admin.api.call('post', `${BASE}/1/tasks/insert-preview`, { stage_code: sstage, predecessors: [pred], successors: [succ], remove_direct_links: true, counts_toward_milestone: false });
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ valid: true, removed_link_count: 1, version_status: 'published' });
    expect(pv.body.rewiring[0]).toMatchObject({ successor: succ, removed_links: [pred] });
    expect(pv.body.rewiring[0].predecessors_after).not.toContain(pred);
    expect((await plain.api.call('post', `${BASE}/1/tasks/insert-preview`, { stage_code: sstage })).status).toBe(403);
    const cyc = await admin.api.call('post', `${BASE}/1/tasks/insert-preview`, { stage_code: sstage, predecessors: [succ], successors: [pred] });
    expect(cyc.body.valid).toBe(false);
    expect(cyc.body.errors[0]).toMatchObject({ path: '/successors', code: 'cycle' });
    const refused = await admin.api.call('post', `${BASE}/1/tasks/insert`, body({ predecessors: [succ], successors: [pred] }), hdr((await current(admin.api, 1)).tag));
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ path: '/successors', code: 'cycle' });
  });

  it('refuses the insert to a non-admin (403), without If-Match (428) and without step-up (401)', async () => {
    const t = (await current(admin.api, 1)).tag;
    expect((await plain.api.call('post', `${BASE}/1/tasks/insert`, body(), hdr(t))).status).toBe(403);
    expect((await admin.api.call('post', `${BASE}/1/tasks/insert`, body())).status).toBe(428);
    expect((await noStep.api.call('post', `${BASE}/1/tasks/insert`, body(), hdr(t))).status).toBe(401);
  });

  it('inserts between: the successor waits for the new task, the old direct link goes, the open sites get the task, and it is audited', async () => {
    site = (await makeSite(db, 5)).id;
    const r = await admin.api.call('post', `${BASE}/1/tasks/insert`, body({ add_to_open_sites: true }), hdr((await current(admin.api, 1)).tag));
    expect(r.status).toBe(201);
    expect(r.body.open_sites_added).toBeGreaterThanOrEqual(1);
    expect(r.body.rewiring[0]).toMatchObject({ successor: succ, removed_links: [pred] });
    const v = await current(admin.api, 1);
    expect(v.body.placements.find((x) => x.task_code === code)).toMatchObject({ stage_code: sstage, predecessors: [pred], counts_toward_milestone: false });
    const sp = v.body.placements.find((x) => x.task_code === succ)!.predecessors;
    expect(sp).toContain(code);
    expect(sp).not.toContain(pred);
    const inst = await db.query('SELECT ti.state FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id WHERE ti.site_id = $1 AND td.code = $2', [site, code]);
    expect(inst.rowCount).toBe(1);
    const audit = await db.query(`SELECT after FROM audit_log WHERE action = 'workflow_task_insert' AND entity_id = $1`, [code]);
    expect(audit.rows[0].after.rewiring[0]).toMatchObject({ successor: succ, removed_links: [pred] });
  });

  it('keeps the old link when asked, and edits successors (cycle refused)', async () => {
    const code2 = `${tag}J`;
    const t = (await current(admin.api, 1)).tag;
    const r = await admin.api.call('post', `${BASE}/1/tasks/insert`, body({ code: code2, predecessors: [pred], successors: [], remove_direct_links: false }), hdr(t));
    expect(r.status).toBe(201);
    expect(r.body.open_sites_added).toBe(0);
    const t2 = r.headers.etag as string;
    const put = await admin.api.call('put', `${BASE}/1/tasks/${code2}/successors`, { successors: [succ], reason: REASON }, hdr(t2));
    expect(put.status).toBe(200);
    expect(put.body.placements.find((x: Placement) => x.task_code === succ).predecessors).toEqual(expect.arrayContaining([code, code2]));
    const cyc = await admin.api.call('put', `${BASE}/1/tasks/${succ}/successors`, { successors: [code2], reason: REASON }, hdr(put.headers.etag as string));
    expect(cyc.status).toBe(422);
    expect(cyc.body.errors[0]).toMatchObject({ path: '/successors', code: 'cycle' });
    expect((await plain.api.call('put', `${BASE}/1/tasks/${code2}/successors`, { successors: [], reason: REASON }, hdr(t2))).status).toBe(403);
  });
});

describe('who may edit', () => {
  it('refuses a draft to a user who is not a System Admin or a delegate (403) and to a session without step-up (401)', async () => {
    expect((await plain.api.call('post', BASE, { parent_version: 1, reason: REASON })).status).toBe(403);
    const r = await noStep.api.call('post', BASE, { parent_version: 1, reason: REASON });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('step_up_required');
  });

  it('a System Admin creates the draft; a second draft is refused', async () => {
    const r = await admin.api.call('post', BASE, { parent_version: 1, reason: REASON });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'draft', parent_version: 1, can_edit: true });
    draft = r.body.version;
    expect(etag(r)).toBe(`"${r.body.version_etag}"`);
    const again = await admin.api.call('post', BASE, { parent_version: 1, reason: REASON });
    expect(again.status).toBe(409);
  });

  it('refuses every task edit to a non-admin (403), and to a missing If-Match (428)', async () => {
    const t = (await current(admin.api, draft)).tag;
    const body = { stage_code: stage, code: 'ZZ1', name_en: 'Nope', reason: REASON };
    const denied = await plain.api.call('post', `${BASE}/${draft}/tasks`, body, hdr(t));
    expect(denied.status).toBe(403);
    const noMatch = await admin.api.call('post', `${BASE}/${draft}/tasks`, body);
    expect(noMatch.status).toBe(428);
    const light = await plain.api.call('patch', `${BASE}/${draft}/milestones/${stage}`, { name_en: 'Nope', reason: REASON }, hdr(t));
    expect(light.status).toBe(403);
  });
});

describe('draft editing', () => {
  it('adds a task in a stage, with its predecessor, and the draft shows it', async () => {
    tag = `N${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const t = (await current(admin.api, draft)).tag;
    const r = await admin.api.call('post', `${BASE}/${draft}/tasks`, {
      stage_code: stage, code: `${tag}1`, name_en: 'Extra inspection', name_ar: 'فحص إضافي', counts_toward_milestone: false, predecessors: [existing], reason: REASON,
    }, hdr(t));
    expect(r.status).toBe(201);
    expect(r.body.task_code).toBe(`${tag}1`);
    const v = await current(admin.api, draft);
    const p = v.body.placements.find((x) => x.task_code === `${tag}1`)!;
    expect(p).toMatchObject({ stage_code: stage, predecessors: [existing], is_active: true, counts_toward_milestone: false, name_en: 'Extra inspection' });
    expect(v.tag).not.toBe(t);
    // version 1 is untouched
    expect((await current(admin.api, 1)).body.placements.some((x) => x.task_code === `${tag}1`)).toBe(false);
    const defs = await admin.api.call('get', `/settings/task-definitions?workflow_version=${draft}`);
    expect(defs.body.items.find((x: { code: string }) => x.code === `${tag}1`)).toBeTruthy();
    const dup = await admin.api.call('post', `${BASE}/${draft}/tasks`, { stage_code: stage, code: `${tag}1`, name_en: 'Again', reason: REASON }, hdr(v.tag));
    expect(dup.status).toBe(409);
    const bad = await admin.api.call('post', `${BASE}/${draft}/tasks`, { stage_code: 'NOPE', code: `${tag}9`, name_en: 'x', reason: REASON }, hdr(v.tag));
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe('/stage_code');
  });

  it('refuses a stale ETag (412)', async () => {
    const r = await admin.api.call('patch', `${BASE}/${draft}/tasks/${tag}1`, { name_en: 'Stale', reason: REASON }, hdr('"1"'));
    expect(r.status).toBe(412);
  });

  it('renames a task EN/AR, and reorders the tasks of the stage', async () => {
    let v = await current(admin.api, draft);
    const r = await admin.api.call('patch', `${BASE}/${draft}/tasks/${tag}1`, { name_en: 'Extra inspection step', name_ar: 'خطوة فحص إضافية', reason: REASON }, hdr(v.tag));
    expect(r.status).toBe(200);
    expect(r.body.placements.find((x: Placement) => x.task_code === `${tag}1`)).toMatchObject({ name_en: 'Extra inspection step', name_ar: 'خطوة فحص إضافية' });
    v = await current(admin.api, draft);
    const order = v.body.placements.filter((x) => x.stage_code === stage).map((x) => x.task_code);
    const flipped = [order[order.length - 1]!, ...order.slice(0, -1)];
    const o = await admin.api.call('put', `${BASE}/${draft}/milestones/${stage}/task-order`, { task_codes: flipped, reason: REASON }, hdr(v.tag));
    expect(o.status).toBe(200);
    expect(o.body.placements.filter((x: Placement) => x.stage_code === stage).map((x: Placement) => x.task_code)).toEqual(flipped);
    const wrong = await admin.api.call('put', `${BASE}/${draft}/milestones/${stage}/task-order`, { task_codes: [order[0]], reason: REASON }, hdr(o.headers.etag as string));
    expect(wrong.status).toBe(422);
  });

  it('changes the predecessors, visible at once; a cycle and a self-reference are refused as field errors', async () => {
    let v = await current(admin.api, draft);
    const two = await admin.api.call('post', `${BASE}/${draft}/tasks`, { stage_code: stage, code: `${tag}2`, name_en: 'Second extra step', predecessors: [`${tag}1`], reason: REASON }, hdr(v.tag));
    expect(two.status).toBe(201);
    v = await current(admin.api, draft);
    expect(v.body.placements.find((x) => x.task_code === `${tag}2`)!.predecessors).toEqual([`${tag}1`]);
    // a cycle: N1 waiting for N2, which waits for N1
    const cyc = await admin.api.call('put', `${BASE}/${draft}/tasks/${tag}1/predecessors`, { predecessors: [`${tag}2`], reason: REASON }, hdr(v.tag));
    expect(cyc.status).toBe(422);
    expect(cyc.body.errors[0]).toMatchObject({ path: '/predecessors', code: 'cycle' });
    const self = await admin.api.call('put', `${BASE}/${draft}/tasks/${tag}1/predecessors`, { predecessors: [`${tag}1`], reason: REASON }, hdr(v.tag));
    expect(self.body.errors[0]).toMatchObject({ path: '/predecessors', code: 'self' });
    // nothing changed after the refusals
    v = await current(admin.api, draft);
    expect(v.body.placements.find((x) => x.task_code === `${tag}1`)!.predecessors).toEqual([existing]);
    // a valid change: N2 now waits for the existing task as well
    const ok = await admin.api.call('put', `${BASE}/${draft}/tasks/${tag}2/predecessors`, { predecessors: [existing, `${tag}1`], reason: REASON }, hdr(v.tag));
    expect(ok.status).toBe(200);
    expect(ok.body.placements.find((x: Placement) => x.task_code === `${tag}2`).predecessors.sort()).toEqual([existing, `${tag}1`].sort());
    const unknown = await admin.api.call('put', `${BASE}/${draft}/tasks/${tag}2/predecessors`, { predecessors: ['NO_SUCH'], reason: REASON }, hdr(ok.headers.etag as string));
    expect(unknown.body.errors[0]).toMatchObject({ path: '/predecessors', code: 'unknown' });
  });

  it('deactivates a task nobody waits for, refuses one that others wait for, and never deletes', async () => {
    let v = await current(admin.api, draft);
    const blocked = await admin.api.call('patch', `${BASE}/${draft}/tasks/${tag}1`, { is_active: false, reason: REASON }, hdr(v.tag));
    expect(blocked.status).toBe(422);
    expect(blocked.body.errors[0].path).toBe('/is_active');
    const off = await admin.api.call('patch', `${BASE}/${draft}/tasks/${tag}2`, { is_active: false, reason: REASON }, hdr(v.tag));
    expect(off.status).toBe(200);
    v = await current(admin.api, draft);
    expect(v.body.placements.find((x) => x.task_code === `${tag}2`)!.is_active).toBe(false);
  });

  it('light edits of a milestone and of a gate apply at once, with their own ETag', async () => {
    const v = await current(admin.api, draft);
    const m = await admin.api.call('patch', `${BASE}/${draft}/milestones/${stage}`, { name_ar: 'مرحلة معدلة', reason: REASON }, hdr(v.tag));
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ code: stage, name_ar: 'مرحلة معدلة' });
    const gates = (await admin.api.call('get', `${BASE}/${draft}`)).body.gates as { code: string; sla_max_wd: number | null }[];
    const g = gates[0]!;
    const g2 = await admin.api.call('patch', `${BASE}/${draft}/gates/${g.code}`, { name_en: 'Renamed gate', reason: REASON }, hdr(m.headers.etag as string));
    expect(g2.status).toBe(200);
    expect(g2.body).toMatchObject({ code: g.code, name_en: 'Renamed gate' });
    const none = await admin.api.call('patch', `${BASE}/${draft}/gates/${g.code}`, { reason: REASON }, hdr(g2.headers.etag as string));
    expect(none.status).toBe(422);
  });

  it('writes an audit row per change with before and after', async () => {
    const rows = await db.query(`SELECT action, reason FROM audit_log WHERE action LIKE 'workflow_%' AND entity_id = ANY($1) ORDER BY id`, [[`${tag}1`, `${tag}2`]]);
    const actions = rows.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('workflow_task_create');
    expect(actions).toContain('workflow_task_predecessors');
    expect(actions).toContain('workflow_task_update');
    expect(rows.rows.every((r: { reason: string }) => r.reason === REASON)).toBe(true);
  });
});

describe('publish', () => {
  it('needs the typed confirmation v<version> (422 confirmation_mismatch), a reason and a step-up', async () => {
    const v = await current(admin.api, draft);
    const wrong = await admin.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: 'publish' }, hdr(v.tag));
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('confirmation_mismatch');
    expect((await plain.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}` }, hdr(v.tag))).status).toBe(403);
    expect((await noStep.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}` }, hdr(v.tag))).status).toBe(401);
    expect((await admin.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}` })).status).toBe(428);
  });

  it('publishes the draft: it becomes the version new sites use, with the edits in it', async () => {
    const v = await current(admin.api, draft);
    const r = await admin.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}` }, hdr(v.tag));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: draft, status: 'published', is_current: true });
    const list = (await plain.api.call('get', BASE)).body.items as { version: number; is_current: boolean }[];
    expect(list.find((x) => x.version === draft)!.is_current).toBe(true);
    expect(list.find((x) => x.version === 1)!.is_current).toBe(false);
    const defs = await plain.api.call('get', '/settings/task-definitions');
    expect(defs.body.items.find((x: { code: string }) => x.code === `${tag}1`)).toMatchObject({ name_en: 'Extra inspection step', predecessors: [existing] });
    const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'workflow_publish' AND entity_id = $1`, [String(draft)]);
    expect(audit.rowCount).toBe(1);
  });

  it('a published version still takes light edits and new tasks, but not a structural move; a second publish is refused', async () => {
    const v = await current(admin.api, draft);
    const light = await admin.api.call('patch', `${BASE}/${draft}/milestones/${stage}`, { name_en: 'Light rename', reason: REASON }, hdr(v.tag));
    expect(light.status).toBe(200);
    const again = await admin.api.call('post', `${BASE}/${draft}/publish`, { reason: REASON, confirm_text: `v${draft}` }, hdr(light.headers.etag as string));
    expect(again.status).toBe(409);
    const other = v.body.milestones.find((m) => m.code !== stage);
    if (other) {
      const move = await admin.api.call('patch', `${BASE}/${draft}/tasks/${tag}1`, { stage_code: other.code, reason: REASON }, hdr(light.headers.etag as string));
      expect(move.status).toBe(422);
      expect(move.body.errors[0].path).toBe('/stage_code');
    }
  });
});

describe('migration preview and log', () => {
  it('previews the move of sites to the published version (admin only) and lists the log', async () => {
    expect((await plain.api.call('post', `${BASE}/${draft}/migration-preview`, { filter: {} })).status).toBe(403);
    const p = await admin.api.call('post', `${BASE}/${draft}/migration-preview`, { filter: { from_version: 1 } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ to_version: draft });
    expect(typeof p.body.preview_hash).toBe('string');
    const log = await admin.api.call('get', '/workflow/site-migrations');
    expect(log.status).toBe(200);
    expect(Array.isArray(log.body.items)).toBe(true);
    expect((await plain.api.call('get', '/workflow/site-migrations')).status).toBe(403);
  });
});
