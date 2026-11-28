import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * 0.15.480 (migration 0621): frozen plans. A System Admin freezes the approved baseline dates; readers (dashboard view) get the variance report in their
 * regions only; the official baselines are untouched; hiding keeps the rows. Region 8.
 */
const REGION = 8;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('plan freezes', () => {
  it('freeze copies the approved baselines, the report is region-limited, a reader cannot freeze, hide keeps the rows', async () => {
    const s = await makeSite(db, REGION);
    const v = 800000 + Math.floor(Math.random() * 100000);
    const bv = (await db.query(`INSERT INTO baseline_versions (version, label, status, approved_at) VALUES ($1, 'freeze test', 'approved', now()) RETURNING id`, [v])).rows[0].id;
    await db.query(`INSERT INTO baseline_entries (version_id, site_id, region_id, milestone_code, baseline_date) VALUES ($1, $2, $3, 'MS1', '2026-01-10')`, [bv, s.id, REGION]);
    const admin = await plainAdmin(app, db);
    const reader = await actor(app, db, { level: 'view', grants: G('dashboard', 'view'), regions: [REGION], modules: null });
    const outsider = await actor(app, db, { level: 'view', grants: G('dashboard', 'view'), regions: [1], modules: null });
    const nobody = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: null });

    expect((await reader.api.call('post', '/plan-freezes', { label: 'x' })).status).toBe(403);
    expect((await admin.api.call('post', '/plan-freezes', { label: '   ' })).status).toBe(422);
    const made = await admin.api.call('post', '/plan-freezes', { label: 'Plan Nov', note: 'before re-baseline' });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    expect(made.body.rows).toBeGreaterThanOrEqual(1);

    // the official baselines are untouched; a re-baseline after the freeze does not rewrite it
    await db.query(`UPDATE baseline_entries SET baseline_date = '2026-03-01' WHERE version_id = $1`, [bv]);
    const frozen = await db.query(`SELECT baseline_date::text AS d FROM plan_freeze_rows WHERE freeze_id = $1 AND site_id = $2`, [id, s.id]);
    expect(frozen.rows[0].d).toBe('2026-01-10');

    const list = (await reader.api.call('get', '/plan-freezes')).body;
    expect(list.can_freeze).toBe(false);
    expect(list.items.some((f: { id: string }) => f.id === id)).toBe(true);
    const rep = (await reader.api.call('get', `/plan-freezes/${id}/report?region_id=${REGION}`)).body;
    expect(rep.totals.rows).toBe(1);
    expect(rep.totals.open_overdue).toBe(1);
    expect(rep.worst[0].site_id).toBe(s.id);
    expect(rep.worst[0].open).toBe(true);
    expect(rep.worst[0].days).toBeGreaterThan(0);
    // another region sees nothing of this site; a caller without dashboard view is refused
    const other = (await outsider.api.call('get', `/plan-freezes/${id}/report`)).body;
    expect(other.worst.some((w: { site_id: string }) => w.site_id === s.id)).toBe(false);
    expect((await nobody.api.call('get', '/plan-freezes')).status).toBe(403);

    expect((await reader.api.call('delete', `/plan-freezes/${id}`)).status).toBe(403);
    expect((await admin.api.call('delete', `/plan-freezes/${id}`)).status).toBe(204);
    expect((await reader.api.call('get', `/plan-freezes/${id}/report`)).status).toBe(404);
    expect((await db.query(`SELECT count(*)::int AS n FROM plan_freeze_rows WHERE freeze_id = $1`, [id])).rows[0].n).toBeGreaterThanOrEqual(1);
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_type = 'plan_freeze' AND entity_id = $1 ORDER BY id`, [id]);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(['plan_freeze_create', 'plan_freeze_hide']);
  });
});
