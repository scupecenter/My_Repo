import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, etag, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0088 (owner decision 2026-11-12 (2), contract 0.15.7): a System Admin edits site data and task dates directly (reason + step-up, audit before and after,
 * the "Admin override" flag, reversible); everybody else keeps the Change Control proposal. Region 6 holds the sites.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let lead: Actor;
const R = 6;
const REASON = 'Owner correction of the Master data';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  lead = await actor(app, db, { level: 'entry', grants: [...G('sites', 'view', 'edit'), ...G('tasks', 'view', 'edit')], regions: [R], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const siteRow = async (id: string) => (await q<{ name: string; name_ar: string | null; lat: number | null; lon: number | null; scenario: string; code: string }>(db,
  `SELECT name, name_ar, latitude::float8 AS lat, longitude::float8 AS lon, site_scenario AS scenario, site_code AS code FROM sites WHERE id = $1`, [id]))[0]!;
const audit = (action: string, entityId: string) => q<{ before: any; after: any; reason: string; is_admin_override: boolean; actor_id: string | null }>(db,
  'SELECT before, after, reason, is_admin_override, actor_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, entityId]);
const taskRow = async (id: string) => (await q<{ planned: string | null; actual: string | null; flag: boolean; version: number; state: string }>(db,
  `SELECT planned_date::text AS planned, actual_date::text AS actual, admin_override AS flag, version, state::text AS state FROM task_instances WHERE id = $1`, [id]))[0]!;
const siteEdit = async (by: Actor, id: string, body: Record<string, unknown>) => {
  const g = await by.api.call('get', `/sites/${id}`);
  return by.api.call('post', `/sites/${id}/admin-edits`, body, { 'If-Match': etag(g) });
};

describe('direct admin edit of a site', () => {
  it('refuses a person who is not a System Admin (403) and changes nothing', async () => {
    const site = await makeSite(db, R, { prefix: 'ADE' });
    const res = await siteEdit(lead, site.id, { reason: REASON, identity: { name: 'Hacked' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
    expect((await siteRow(site.id)).name).toBe(`Site ${site.code}`);
    expect(await audit('site_admin_edit', site.id)).toHaveLength(0);
  });

  it('needs a step-up and a reason', async () => {
    const site = await makeSite(db, R, { prefix: 'ADE' });
    const noStep = await plainAdmin(app, db, false);
    const r1 = await siteEdit(noStep, site.id, { reason: REASON, identity: { name: 'No step-up' } });
    expect(r1.status).toBe(401);
    expect(r1.body.code).toBe('step_up_required');
    const r2 = await siteEdit(admin, site.id, { reason: 'ab', identity: { name: 'Short reason' } });
    expect(r2.status).toBe(422);
    expect((await siteRow(site.id)).name).toBe(`Site ${site.code}`);
  });

  it('applies identity and scenario at once, audits before and after as an admin override, and shows the badge data', async () => {
    const site = await makeSite(db, R, { prefix: 'ADE' });
    const before = await siteRow(site.id);
    const res = await siteEdit(admin, site.id, { reason: REASON, identity: { name: 'Corrected Name', name_ar: 'اسم مصحح', latitude: 32.887, longitude: 13.191 }, scenario: 'Expansion' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.name).toBe('Corrected Name');
    expect(res.body.admin_override_active).toBe(true);
    expect(res.body.can_admin_edit).toBe(true);
    expect(res.body.admin_edits.active_count).toBe(1);
    expect(res.body.admin_edits.items[0].revertible).toBe(true);
    const now = await siteRow(site.id);
    expect(now).toMatchObject({ name: 'Corrected Name', name_ar: 'اسم مصحح', lat: 32.887, lon: 13.191, scenario: 'Expansion', code: before.code });
    const [row] = await audit('site_admin_edit', site.id);
    expect(row).toBeDefined();
    expect(row!.is_admin_override).toBe(true);
    expect(row!.actor_id).toBe(admin.user.id);
    expect(row!.reason).toBe(REASON);
    expect(row!.before.fields['site.name']).toBe(before.name);
    expect(row!.after.fields['site.name']).toBe('Corrected Name');
    const other = await lead.api.call('get', `/sites/${site.id}`);
    expect(other.body.can_admin_edit).toBe(false);
  });

  it('keeps the Site ID immutable and reports field errors with their path', async () => {
    const site = await makeSite(db, R, { prefix: 'ADE' });
    const res = await siteEdit(admin, site.id, { reason: REASON, identity: { site_code: 'NEW-ID' } });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/identity/site_code', code: 'immutable' })]));
    const pair = await siteEdit(admin, site.id, { reason: REASON, identity: { latitude: 32.1 } });
    expect(pair.status).toBe(422);
    expect((await siteRow(site.id)).code).toBe(site.code);
  });

  it('reverts a site edit, then refuses a second revert and a revert after the site moved on', async () => {
    const site = await makeSite(db, R, { prefix: 'ADE' });
    const e1 = await siteEdit(admin, site.id, { reason: REASON, identity: { name: 'First' } });
    expect(e1.status).toBe(200);
    const id1 = e1.body.admin_edits.items[0].id as string;
    const rv = await admin.api.call('post', `/overrides/${id1}/revert`, { reason: 'Edit was a mistake' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.reverted_at).toBeTruthy();
    expect((await siteRow(site.id)).name).toBe(`Site ${site.code}`);
    expect(await audit('site_admin_edit_reverted', site.id)).toHaveLength(1);
    const again = await admin.api.call('post', `/overrides/${id1}/revert`, { reason: 'Again please' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('override_not_revertible');
    const e2 = await siteEdit(admin, site.id, { reason: REASON, identity: { name: 'Second' } });
    const id2 = e2.body.admin_edits.items[0].id as string;
    await siteEdit(admin, site.id, { reason: REASON, identity: { name: 'Third' } });
    const stale = await admin.api.call('post', `/overrides/${id2}/revert`, { reason: 'Back to second' });
    expect(stale.status).toBe(409);
    expect((await siteRow(site.id)).name).toBe('Third');
    const denied = await lead.api.call('post', `/overrides/${id2}/revert`, { reason: 'Not an admin' });
    expect(denied.status).toBe(403);
  });
});

describe('admin override of a task date', () => {
  it('refuses a non-admin, an unknown kind and a missing step-up', async () => {
    const site = await makeSite(db, R, { prefix: 'ADT' });
    const id = await makeTask(db, site, 'A1', 'entry', { actualDate: '2026-03-01' });
    const v = (await taskRow(id)).version;
    const body = { kind: 'edit_date', reason: REASON, date_field: 'planned_date', new_date: '2026-04-01' };
    expect((await lead.api.call('post', `/tasks/${id}/overrides`, body, { 'If-Match': `"${v}"` })).status).toBe(403);
    const unsupported = await admin.api.call('post', `/tasks/${id}/overrides`, { ...body, kind: 'skip' }, { 'If-Match': `"${v}"` });
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.errors[0]).toMatchObject({ path: '/kind', code: 'not_supported' });
    const noStep = await plainAdmin(app, db, false);
    const ns = await noStep.api.call('post', `/tasks/${id}/overrides`, body, { 'If-Match': `"${v}"` });
    expect(ns.status).toBe(401);
    expect((await taskRow(id)).flag).toBe(false);
  });

  it('edits the date of an approved task, flags it, audits it, and reverts it (round trip)', async () => {
    const site = await makeSite(db, R, { prefix: 'ADT' });
    const id = await makeTask(db, site, 'A1', 'approved', { actualDate: '2026-03-01' });
    const v0 = (await taskRow(id)).version;
    const res = await admin.api.call('post', `/tasks/${id}/overrides`, { kind: 'edit_date', reason: REASON, date_field: 'actual_date', new_date: '2026-03-10' }, { 'If-Match': `"${v0}"` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ entity: 'task', kind: 'edit_date', revertible: true, before: { actual_date: '2026-03-01' }, after: { actual_date: '2026-03-10' } });
    const edited = await taskRow(id);
    expect(edited).toMatchObject({ actual: '2026-03-10', flag: true, state: 'approved' });
    const [a] = await audit('task_override_edit_date', id);
    expect(a!.is_admin_override).toBe(true);
    expect(a!.reason).toBe(REASON);
    const detail = await admin.api.call('get', `/tasks/${id}`);
    expect(detail.body.admin_override).toBe(true);
    expect(detail.body.can_override).toBe(true);
    expect(detail.body.overrides).toHaveLength(1);
    const rv = await admin.api.call('post', `/overrides/${res.body.id}/revert`, { reason: 'The first date was right' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    const back = await taskRow(id);
    expect(back).toMatchObject({ actual: '2026-03-01', flag: false });
    expect(await audit('task_override_reverted', id)).toHaveLength(1);
    const again = await admin.api.call('post', `/overrides/${res.body.id}/revert`, { reason: 'Twice' });
    expect(again.status).toBe(409);
  });

  it('refuses a revert once the date moved on and an edit that changes nothing', async () => {
    const site = await makeSite(db, R, { prefix: 'ADT' });
    const id = await makeTask(db, site, 'A1', 'entry', { actualDate: '2026-03-01' });
    const call = (v: number, date: string) => admin.api.call('post', `/tasks/${id}/overrides`, { kind: 'edit_date', reason: REASON, date_field: 'planned_date', new_date: date }, { 'If-Match': `"${v}"` });
    const o1 = await call((await taskRow(id)).version, '2026-05-01');
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    const same = await call((await taskRow(id)).version, '2026-05-01');
    expect(same.status).toBe(422);
    const o2 = await call((await taskRow(id)).version, '2026-06-01');
    expect(o2.status).toBe(201);
    const stale = await admin.api.call('post', `/overrides/${o1.body.id}/revert`, { reason: 'Back' });
    expect(stale.status).toBe(409);
    expect((await taskRow(id)).flag).toBe(true);
    const ok = await admin.api.call('post', `/overrides/${o2.body.id}/revert`, { reason: 'Back one step' });
    expect(ok.status).toBe(200);
    expect((await taskRow(id)).flag).toBe(true);   // the first override is still in force
    const stale1 = await admin.api.call('post', `/overrides/${o1.body.id}/revert`, { reason: 'Back to start' });
    expect(stale1.status).toBe(200);
    expect(await taskRow(id)).toMatchObject({ planned: null, flag: false });
  });
});
