import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, plainAdmin } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * Weight sets (contract 0.2.6, migration 0039): the seeds, the 100% rule per level, the draft and publish path with its reason, effective date, audit and
 * step-up, and the comparison run of Project Status with an older set. The suite publishes a new Project Status set in the shared database; no other suite
 * reads Project Status.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStepUp: Actor;
let viewer: Actor;
let outsider: Actor;

const SETS = '/settings/weight-sets';
type J = Record<string, any>;
const ifm = (etag: string | undefined): Record<string, string> => ({ 'If-Match': etag ?? '' });
const sum = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) * 1000) / 1000;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
  noStepUp = await plainAdmin(app, db, false);
  viewer = await actor(app, db, { grants: [['admin.settings', 'view']] });
  outsider = await actor(app, db, { grants: [['sites', 'view']] });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const list = async (a: Actor, qs = ''): Promise<J[]> => {
  const res = await a.api.call('get', `${SETS}${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as J[];
};
const today = async (): Promise<string> => (await db.query('SELECT cal_today()::text AS d')).rows[0].d as string;

describe('the seeds', () => {
  it('has the Project Status set: 8 activities 12/8/5/25/20/12/13/5 and 45 items, every level totalling 100', async () => {
    const [ps] = await list(admin, '?code=project_status&status=published');
    expect(ps).toMatchObject({ code: 'project_status', version: 1, status: 'published', is_active: true });
    expect(ps!.activities.map((a: J) => a.weight)).toEqual([12, 8, 5, 25, 20, 12, 13, 5]);
    expect(ps!.activities.map((a: J) => a.items.length)).toEqual([5, 3, 10, 8, 4, 6, 7, 2]);
    expect(ps!.activities.flatMap((a: J) => a.items)).toHaveLength(45);
    for (const a of ps!.activities) expect(sum(a.items.map((i: J) => i.weight))).toBe(100);
    expect(sum(ps!.activities.map((a: J) => a.weight))).toBe(100);
    const item = ps!.activities[0].items[0];
    expect(item).toMatchObject({ code: '1.1', weight: 30, unit: 'units' });
    expect(JSON.parse(item.measure_rule)).toEqual({ method: 'tasks', tasks: ['A2'], plan: 'MS1' });
  });

  it('has the health index set with six factors totalling 100, and no delay-attribution set yet', async () => {
    const [hi] = await list(admin, '?code=health_index');
    expect(hi!.activities.map((a: J) => a.code)).toEqual(['P', 'B', 'S', 'D', 'F', 'I']);
    expect(sum(hi!.activities.map((a: J) => a.weight))).toBe(100);
    expect(await list(admin, '?code=delay_attribution')).toEqual([]);
  });
});

describe('who may read and write', () => {
  it('reads need the Settings screen, writes need the weights right; a signed-in caller without them is refused', async () => {
    expect((await outsider.api.call('get', SETS)).status).toBe(403);
    expect((await viewer.api.call('get', SETS)).status).toBe(200);
    const ps = (await list(viewer, '?code=project_status'))[0]!;
    expect((await viewer.api.call('get', `${SETS}/${ps.id}`)).status).toBe(200);
    expect((await viewer.api.call('post', SETS, { code: 'project_status', reason: 'try it' })).status).toBe(403);
    expect((await outsider.api.call('post', SETS, { code: 'project_status', reason: 'try it' })).status).toBe(403);
    expect((await viewer.api.call('post', `${SETS}/${ps.id}/preview`)).status).toBe(403);
    expect((await viewer.api.call('post', `${SETS}/${ps.id}/publish`, { effective_date: await today(), reason: 'try it' }, { 'If-Match': '*' })).status).toBe(403);
    expect((await admin.api.raw('get', SETS).set('Cookie', 'pmis_session=bad')).status).toBe(401);
  });

  it('the application role cannot write the weight tables or the snapshot tables directly', async () => {
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await appDb.connect();
    try {
      await expect(appDb.query('UPDATE weight_items SET weight = 1')).rejects.toThrow(/permission denied/);
      await expect(appDb.query("INSERT INTO weight_sets (code, version, effective_from, reason, changed_by) VALUES ('health_index', 99, now(), 'x', gen_random_uuid())")).rejects.toThrow(/permission denied/);
      await expect(appDb.query('DELETE FROM weight_activities')).rejects.toThrow(/permission denied/);
      await expect(appDb.query('SELECT admin_save_weight_set(NULL, \'project_status\', NULL, \'direct call\', NULL, NULL)')).rejects.toThrow(/admin path/);
    } finally {
      await appDb.end();
    }
  });
});

describe('draft, 100% rule and publish', () => {
  let draftId: string;
  let etag: string;
  let v1: J;

  it('creates one draft per code as a copy of the set in force, with a reason', async () => {
    v1 = (await list(admin, '?code=project_status&status=published'))[0]!;
    const bad = await admin.api.call('post', SETS, { code: 'project_status', reason: 'x' });
    expect(bad.status).toBe(422);
    expect((await admin.api.call('post', SETS, { code: 'nope', reason: 'a good reason' })).status).toBe(422);
    const res = await admin.api.call('post', SETS, { code: 'project_status', reason: 'More weight on survey and engineering' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    draftId = res.body.id;
    etag = res.headers.etag!;
    expect(res.body).toMatchObject({ status: 'draft', version: 2, code: 'project_status' });
    expect(res.body.activities.flatMap((a: J) => a.items)).toHaveLength(45);
    expect((await admin.api.call('post', SETS, { code: 'project_status', reason: 'a second draft' })).status).toBe(409);
  });

  it('saves a draft whose totals are not 100 (the screen shows the live sum), and the preview and the publish refuse it with one error per level', async () => {
    const draft = (await admin.api.call('get', `${SETS}/${draftId}`)).body as J;
    const acts = draft.activities.map((a: J, i: number) => ({
      code: a.code, name_en: a.name_en, name_ar: a.name_ar, weight: i === 0 ? 11 : a.weight,
      items: a.items.map((it: J, j: number) => ({ code: it.code, name_en: it.name_en, name_ar: it.name_ar, weight: i === 1 && j === 0 ? it.weight + 5 : it.weight, unit: it.unit, measure_rule: it.measure_rule, source: it.source })),
    }));
    expect((await admin.api.call('put', `${SETS}/${draftId}`, { reason: 'work in progress', activities: acts })).status).toBe(428); // If-Match is required
    expect((await admin.api.call('put', `${SETS}/${draftId}`, { reason: 'work in progress', activities: acts }, ifm('"1"'))).status).toBe(412); // a stale one
    const saved = await admin.api.call('put', `${SETS}/${draftId}`, { reason: 'work in progress', activities: acts }, ifm(etag));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.headers.etag).not.toBe(etag);
    etag = saved.headers.etag!;
    const prev = await admin.api.call('post', `${SETS}/${draftId}/preview`);
    expect(prev.status).toBe(200);
    expect(prev.body.valid).toBe(false);
    expect(prev.body.errors).toEqual([
      expect.objectContaining({ path: '/activities', code: 'weights_must_total_100', message: expect.stringContaining('99') }),
      expect.objectContaining({ path: '/activities/1/items', code: 'weights_must_total_100', message: expect.stringContaining('105') }),
    ]);
    expect(prev.body.progress_new_pct).toBeNull();
    const pub = await admin.api.call('post', `${SETS}/${draftId}/publish`, { effective_date: await today(), reason: 'try' }, { 'If-Match': etag });
    expect(pub.status).toBe(422);
    expect(pub.body.errors.map((e: J) => e.code)).toEqual(['weights_must_total_100', 'weights_must_total_100']);
    expect(pub.body.errors.map((e: J) => e.path)).toEqual(['/activities', '/activities/1/items']);
  });

  it('refuses a body with an unknown key, a weight with more than 3 decimals, a duplicate code and a missing reason', async () => {
    const one = (extra: J = {}, act: J = {}) => ({ reason: 'a good reason', activities: [{ code: 'X', name_en: 'X', weight: 100, ...act }], ...extra });
    expect((await admin.api.call('put', `${SETS}/${draftId}`, one({ surprise: 1 }), ifm(etag))).status).toBe(422);
    expect((await admin.api.call('put', `${SETS}/${draftId}`, one({}, { weight: 12.3456 }), ifm(etag))).status).toBe(422);
    expect((await admin.api.call('put', `${SETS}/${draftId}`, one({}, { weight: 101 }), ifm(etag))).status).toBe(422);
    expect((await admin.api.call('put', `${SETS}/${draftId}`, one({ reason: 'no' }), ifm(etag))).status).toBe(422);
    const dup = { reason: 'a good reason', activities: [{ code: 'X', name_en: 'X', weight: 50 }, { code: 'X', name_en: 'Y', weight: 50 }] };
    expect((await admin.api.call('put', `${SETS}/${draftId}`, dup, ifm(etag))).status).toBe(422);
    const dupItem = { reason: 'a good reason', activities: [{ code: 'X', name_en: 'X', weight: 100, items: [{ code: '1', name_en: 'a', weight: 50 }, { code: '1', name_en: 'b', weight: 50 }] }] };
    expect((await admin.api.call('put', `${SETS}/${draftId}`, dupItem, ifm(etag))).status).toBe(422);
  });

  it('accepts weights that total 100 at every level, shows the effect in the preview, and publishes only with step-up, a date from today and a reason', async () => {
    const draft = (await admin.api.call('get', `${SETS}/${draftId}`)).body as J;
    etag = (await admin.api.call('get', `${SETS}/${draftId}`)).headers.etag!;
    const acts = draft.activities.map((a: J, i: number) => ({
      code: a.code, name_en: a.name_en, name_ar: a.name_ar, weight: i === 0 ? 10 : i === 1 ? 10 : a.weight,
      items: a.items.map((it: J, j: number) => ({ code: it.code, name_en: it.name_en, name_ar: it.name_ar, weight: i === 1 ? [30, 30, 40][j]! : it.weight, unit: it.unit, measure_rule: it.measure_rule, source: it.source })),
    }));
    const saved = await admin.api.call('put', `${SETS}/${draftId}`, { reason: 'Survey 10, acquisition 10', activities: acts }, ifm(etag));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    etag = saved.headers.etag!;
    const prev = await admin.api.call('post', `${SETS}/${draftId}/preview`);
    expect(prev.body.valid).toBe(true);
    expect(prev.body.errors).toEqual([]);
    expect(typeof prev.body.progress_current_pct).toBe('number');
    expect(typeof prev.body.progress_new_pct).toBe('number');
    expect(prev.body.activities.map((a: J) => a.code)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
    const body = { effective_date: await today(), reason: 'Owner asked for it' };
    // no step-up
    expect((await noStepUp.api.call('post', `${SETS}/${draftId}/publish`, body, { 'If-Match': etag })).status).toBe(401);
    // a date in the past
    const past = await admin.api.call('post', `${SETS}/${draftId}/publish`, { ...body, effective_date: '2020-01-01' }, { 'If-Match': etag });
    expect(past.status).toBe(422);
    expect(past.body.errors.map((e: J) => e.code)).toContain('effective_date_in_past');
    expect((await admin.api.call('post', `${SETS}/${draftId}/publish`, { ...body, reason: 'no' }, { 'If-Match': etag })).status).toBe(422);
    expect((await admin.api.call('post', `${SETS}/${draftId}/publish`, body, {})).status).toBe(428);
    const ok = await admin.api.call('post', `${SETS}/${draftId}/publish`, body, { 'If-Match': etag, 'Idempotency-Key': `pub-${draftId}` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.weight_set).toMatchObject({ id: draftId, status: 'published', version: 2, is_active: true, effective_from: await today() });
    expect(ok.body.previous_set_id).toBe(v1.id);
    // the previous set ends on that date, and a published set cannot be saved or published again
    const old = (await admin.api.call('get', `${SETS}/${v1.id}`)).body as J;
    expect(old).toMatchObject({ effective_to: await today(), is_active: false });
    expect((await admin.api.call('put', `${SETS}/${draftId}`, { reason: 'again please', activities: acts }, ifm(etag))).status).toBe(409);
    expect((await admin.api.call('post', `${SETS}/${draftId}/publish`, body, { 'If-Match': '*' })).status).toBe(409);
  });

  it('Project Status uses the new set from its date and can be re-run with the older one; the progress of both is computed, not stored', async () => {
    const now = await admin.api.call('get', '/project-status');
    expect(now.status).toBe(200);
    expect(now.body.weight_set).toMatchObject({ version: 2, is_active: true });
    expect(now.body.activities.map((a: J) => a.weight)).toEqual([10, 10, 5, 25, 20, 12, 13, 5]);
    const old = await admin.api.call('get', `/project-status?weight_set_id=${v1.id}`);
    expect(old.body.weight_set).toMatchObject({ version: 1, is_active: false });
    expect(old.body.activities.map((a: J) => a.weight)).toEqual([12, 8, 5, 25, 20, 12, 13, 5]);
    const byVersion = await admin.api.call('get', '/project-status?weight_set_version=1');
    expect(byVersion.body.weight_set.id).toBe(v1.id);
  });

  it('a draft equal to the set in force is refused (no_changes), and so is a date that is not after the set in force', async () => {
    const d = await admin.api.call('post', SETS, { code: 'project_status', reason: 'a copy to test the checks' });
    expect(d.status).toBe(201);
    const same = await admin.api.call('post', `${SETS}/${d.body.id}/publish`, { effective_date: await today(), reason: 'nothing changed' }, { 'If-Match': d.headers.etag! });
    expect(same.status).toBe(422);
    expect(same.body.errors.map((e: J) => e.code)).toEqual(expect.arrayContaining(['no_changes', 'effective_date_not_after_current']));
  });

  it('writes before and after values and the reason to the audit log for the draft, the save and the publish', async () => {
    const rows = (await db.query(
      `SELECT action, reason, before IS NOT NULL AS has_before, after IS NOT NULL AS has_after FROM audit_log WHERE entity_type = 'weight_set' AND entity_id = $1 ORDER BY id`, [draftId])).rows;
    expect(rows.map((r) => r.action)).toEqual(['weights.draft_created', 'weights.draft_saved', 'weights.draft_saved', 'weights.published']);
    expect(rows[1]).toMatchObject({ has_before: true, has_after: true, reason: 'work in progress' });
    expect(rows[3]).toMatchObject({ reason: 'Owner asked for it', has_after: true });
  });
});
