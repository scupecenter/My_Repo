import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor, makeSite, type Site } from './wf-helpers';

/** Contract 0.15.463 (migration 0603): planned dates proposed from predecessors and work calendars; the engineer confirms. */
const TAG = randomBytes(3).toString('hex').toUpperCase();
let app: NestExpressApplication;
let db: PgClient;
let site: Site;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  site = await makeSite(db, 7, { prefix: `PD${TAG}` });
});
afterAll(async () => {
  await db.query(`DELETE FROM settings WHERE key = 'plan.rules'`);
  await db.end();
  await app.close();
});

describe('planned dates', () => {
  it('saves the rules with a reason and the current version', async () => {
    const viewer = await actor(app, db, { grants: [['sites', 'view']] });
    const admin = await loggedIn(app, await makeAdmin(db));
    const cur = await admin.call('get', '/settings/plan-rules');
    expect(cur.body).toMatchObject({ enabled: true, basis: 'max', cascade: true });
    const etag = cur.headers.etag as string;
    const body = { reason: 'Use the minimum days', enabled: true, basis: 'min', cascade: true };
    expect((await viewer.api.call('put', '/settings/plan-rules', body, { 'If-Match': etag })).status).toBe(403);
    expect((await admin.call('put', '/settings/plan-rules', { ...body, reason: 'x' }, { 'If-Match': etag })).status).toBe(422);
    expect((await admin.call('put', '/settings/plan-rules', { ...body, basis: 'avg' }, { 'If-Match': etag })).status).toBe(422);
    const ok = await admin.call('put', '/settings/plan-rules', body, { 'If-Match': etag });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ basis: 'min', version: 1 });
    expect((await admin.call('put', '/settings/plan-rules', body, { 'If-Match': etag })).status).toBe(412);
    await admin.call('put', '/settings/plan-rules', { ...body, basis: 'max' }, { 'If-Match': ok.headers.etag as string });
  });

  it('proposes from the actual date of the first task and cascades; nothing changes until apply', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    await db.query(
      `UPDATE task_instances SET actual_date = DATE '2026-11-01', state = 'approved' WHERE site_id = $1 AND task_def_id = (SELECT td.id FROM task_definitions td WHERE td.workflow_id = (SELECT workflow_version_id FROM sites WHERE id = $1) AND td.code = 'MS1')`,
      [site.id],
    );
    const r = await admin.call('get', `/sites/${site.id}/planned-dates`);
    expect(r.status).toBe(200);
    const b1 = r.body.items.find((x: { task_code: string }) => x.task_code === 'B1');
    expect(b1).toMatchObject({ basis_task_code: 'MS1', basis_kind: 'actual' });
    expect(b1.proposed_date > '2026-11-01').toBe(true);
    const b2 = r.body.items.find((x: { task_code: string }) => x.task_code === 'B2');
    expect(b2).toMatchObject({ basis_task_code: 'B1', basis_kind: 'proposed' });
    expect(b2.proposed_date > b1.proposed_date).toBe(true);
    const before = await db.query(`SELECT planned_date FROM task_instances WHERE id = $1`, [b1.task_id]);
    expect(before.rows[0].planned_date).toBeNull();
    const viewer = await actor(app, db, { regions: [7], grants: [['sites', 'view']] });
    expect((await viewer.api.call('post', `/sites/${site.id}/planned-dates/apply`, { task_ids: [b1.task_id] })).status).toBe(403);
    const ok = await admin.call('post', `/sites/${site.id}/planned-dates/apply`, { task_ids: [b1.task_id] });
    expect(ok.body).toEqual({ applied: 1, skipped: 0 });
    const after = await db.query(`SELECT planned_date::text AS d FROM task_instances WHERE id = $1`, [b1.task_id]);
    expect(after.rows[0].d).toBe(b1.proposed_date);
    const aud = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_planned_date_proposal_applied' AND entity_id = $1`, [b1.task_id]);
    expect(aud.rows[0].n).toBe(1);
    expect((await admin.call('post', `/sites/${site.id}/planned-dates/apply`, { task_ids: [] })).status).toBe(422);
    expect((await admin.call('get', `/sites/00000000-0000-4000-8000-000000000000/planned-dates`)).status).toBe(404);
  });
});
