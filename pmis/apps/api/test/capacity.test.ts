import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Resource capacity planning (migration 0666, contract 0.15.595): GET and PUT /settings/capacity-plan (setting capacity.plan) and GET /capacity/plan.
 * The suite puts the setting back to the default at the end; no other suite reads it.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let allDelegate: Actor;
let regDelegate: Actor;
const REASON = 'Owner request 2026-11-28';
const DEFAULT = { skills: [], crews: [], efforts: [], days_per_week: 5, utilization_pct: 80, horizon_weeks: 8 };
const SAMPLE = {
  skills: [{ code: 'civil', name_en: 'Civil', name_ar: 'مدني' }, { code: 'rf', name_en: 'RF', name_ar: '' }],
  crews: [{ id: 'c1', region_id: 5, name: 'Crew A', size: 4, skills: ['civil', 'rf'] }],
  efforts: [{ task_code: 'civil_works', skill: 'civil', person_days: 2.5 }],
  days_per_week: 5, utilization_pct: 80, horizon_weeks: 6,
};

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  allDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, allDelegate.user.id, [['settings', 'edit']]);
  regDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, regDelegate.user.id, [['settings', 'edit']], [5]);
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = $1::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'capacity.plan'`, [JSON.stringify(DEFAULT)]);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/capacity-plan');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/capacity-plan', body, tag === undefined ? {} : { 'If-Match': tag });
const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'capacity.plan'`))[0]?.value;

describe('GET and PUT /settings/capacity-plan', () => {
  it('every signed-in user reads the default; only a System Admin or an all-regions settings delegate may edit', async () => {
    for (const [who, can] of [[plain, false], [regDelegate, false], [allDelegate, true], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ...DEFAULT, updated_by: null, can_edit: can });
    }
    expect((await new Api(app).raw('get', '/settings/capacity-plan')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, regDelegate]) expect((await put(who, { ...SAMPLE, reason: REASON }, tag)).status).toBe(403);
    expect(await value()).toEqual(DEFAULT);
  });

  it('checks the body, If-Match and the step-up', async () => {
    const tag = etag(await read(admin));
    const body = { ...SAMPLE, reason: REASON };
    expect((await put(admin, body)).status).toBe(428);
    expect((await put(admin, body, '"999"')).status).toBe(412);
    expect((await put(noStep, body, tag)).body.code).toBe('step_up_required');
    for (const bad of [
      { ...body, skills: [...SAMPLE.skills, SAMPLE.skills[0]] }, { ...body, utilization_pct: 5 }, { ...body, days_per_week: 8 }, { ...body, horizon_weeks: 27 },
      { ...body, crews: [{ ...SAMPLE.crews[0], skills: ['nope'] }] }, { ...body, crews: [{ ...SAMPLE.crews[0], region_id: 9 }] },
      { ...body, efforts: [{ task_code: 'x', skill: 'nope', person_days: 1 }] }, { ...body, efforts: [{ task_code: 'x', skill: 'rf', person_days: 0 }] },
      { ...body, efforts: [SAMPLE.efforts[0], SAMPLE.efforts[0]] }, { ...body, reason: 'ab' }, { ...body, extra: 1 },
    ]) expect((await put(admin, bad, tag)).status, JSON.stringify(bad)).toBe(422);
    expect(await value()).toEqual(DEFAULT);
  });

  it('saves, audits, refuses the same values again (409) and a stale tag (412)', async () => {
    const cur = await read(admin);
    const ok = await put(admin, { ...SAMPLE, reason: REASON }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ...SAMPLE, can_edit: true });
    expect(ok.body.version).toBe(cur.body.version + 1);
    expect((await put(admin, { ...SAMPLE, reason: REASON }, etag(ok))).status).toBe(409);
    expect((await put(admin, { ...SAMPLE, horizon_weeks: 4, reason: REASON }, etag(cur))).status).toBe(412);
    const a = await q<{ reason: string }>(db, `SELECT reason FROM audit_log WHERE action = 'capacity_plan_update' AND entity_id = 'capacity.plan'`);
    expect(a.map((x) => x.reason)).toEqual([REASON]);
  });
});

describe('GET /capacity/plan', () => {
  it('answers the weeks of the horizon with the capacity of the crews (split over their skills) and needs the Reports view', async () => {
    const r = await admin.api.call('get', '/capacity/plan');
    expect(r.status).toBe(200);
    expect(r.body.horizon_weeks).toBe(6);
    expect(r.body.weeks).toHaveLength(6);
    const reg = r.body.regions.find((x: { region_id: number }) => x.region_id === 5);
    // 4 people x 5 days x 80 % = 16 days a week, split over two skills = 8 each
    expect(reg.skills.map((s: { skill: string }) => s.skill).sort()).toEqual(['civil', 'rf']);
    for (const s of reg.skills) expect(s.cells[3]).toMatchObject({ capacity_days: 8 });
    expect((await admin.api.call('get', '/capacity/plan?region_id=9')).status).toBe(422);
    expect((await new Api(app).raw('get', '/capacity/plan')).status).toBe(401);
  });
});
