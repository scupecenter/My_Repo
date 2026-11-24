import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { createRec, otherSite, PROC, recPath, team } from './reg-helpers';
import { actor, addAssignment, makeSite, makeTask, setCell } from './wf-helpers';
import { G } from './reg-helpers';

/**
 * W8 items 5 and 6 (contract 0.15.68) on the other site-data lists: the register records, the Approvals inbox and My Work read the pasted list
 * of Site IDs on the server and answer the total and the filtered counts, with the caller's rights (region scope B3, the matrix, row security).
 */
const PREFIX = `W8L${randomBytes(3).toString('hex').toUpperCase()}`;
const REGION = 2;
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

describe('W8: the register list', () => {
  it('a pasted list keeps the records of those sites; counts total and filtered; the not-found list never names a site of another region', async () => {
    const t = await team(app, db, 'procurement', 'procurement', 4);
    const t2 = await otherSite(db, t);
    const t3 = await otherSite(db, t);
    await createRec(t, PROC);
    await createRec(t2, PROC);
    await createRec(t3, PROC);
    const away = await makeSite(db, 5, { prefix: PREFIX });
    await addAssignment(db, t.entry.user.id, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null }); // found = a site the caller may see
    const q = encodeURIComponent(`${t.site.code.toLowerCase()}\n${t2.site.code} ${away.code} ${PREFIX}-NONE`);
    const res = await t.entry.api.call('get', `${recPath('procurement')}?limit=100&q=${q}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { site_code: string }) => r.site_code).sort()).toEqual([t.site.code, t2.site.code].sort());
    expect(res.body.counts.filtered).toBe(2);
    expect(res.body.counts.total).toBeGreaterThanOrEqual(3);
    expect(res.body.search).toEqual({ pasted: 4, found: 2, not_found: [away.code, `${PREFIX}-NONE`] });
    // one token keeps the contains search
    const one = await t.entry.api.call('get', `${recPath('procurement')}?limit=100&q=${t3.site.code}`);
    expect(one.body.items.map((r: { site_code: string }) => r.site_code)).toEqual([t3.site.code]);
    expect(one.body.search).toBeUndefined();
    // the total does not move with a filter
    const plain = await t.entry.api.call('get', `${recPath('procurement')}?limit=1`);
    expect(plain.body.counts.total).toBe(res.body.counts.total);
    expect(plain.body.counts.filtered).toBe(plain.body.counts.total);
    expect((await t.entry.api.call('get', `${recPath('procurement')}?q=${encodeURIComponent(Array.from({ length: 1001 }, (_, i) => `X${i}`).join(' '))}`)).status).toBe(422);
  });
});

describe('W8: the not-found list follows the Sites view regions (security review 2026-11-24)', () => {
  it('a user with the register in two regions but Sites view in one gets the other region\'s codes as "not found"', async () => {
    const t = await team(app, db, 'procurement', 'procurement', 4);
    const s5 = await makeSite(db, 5, { prefix: PREFIX });
    const u = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [4, 5], modules: null });
    await addAssignment(db, u.user.id, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
    const q = encodeURIComponent(`${t.site.code} ${s5.code}`);
    const res = await u.api.call('get', `${recPath('procurement')}?limit=100&q=${q}`);
    expect(res.status).toBe(200);
    expect(res.body.search).toEqual({ pasted: 2, found: 1, not_found: [s5.code] });
    // with Sites view in both regions the same code is found
    const both = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [4, 5], modules: null });
    await addAssignment(db, both.user.id, { level: 'view', grants: G('sites', 'view'), regions: [4, 5], modules: null });
    const res2 = await both.api.call('get', `${recPath('procurement')}?limit=100&q=${q}`);
    expect(res2.body.search).toEqual({ pasted: 2, found: 2, not_found: [] });
    // and a register user without any Sites view finds nothing, yet still reads the register
    const none = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [4, 5], modules: null });
    const res3 = await none.api.call('get', `${recPath('procurement')}?limit=100&q=${q}`);
    expect(res3.status).toBe(200);
    expect(res3.body.search.found).toBe(0);
  });

  it('Approvals: a site the caller may see but in a region where the caller has no Approvals is "not found"', async () => {
    const s7 = await makeSite(db, 7, { prefix: PREFIX });
    const a = await actor(app, db, { level: 'approve', grants: [...G('sites', 'view'), ...G('approvals', 'view')], regions: [REGION], modules: null });
    await addAssignment(db, a.user.id, { level: 'view', grants: G('sites', 'view'), regions: [7], modules: null });
    const s2 = await makeSite(db, REGION, { prefix: PREFIX });
    const res = await a.api.call('get', `/approvals?limit=200&q=${encodeURIComponent(`${s2.code} ${s7.code}`)}`);
    expect(res.status).toBe(200);
    expect(res.body.search).toEqual({ pasted: 2, found: 1, not_found: [s7.code] });
  });
});

describe('W8: Approvals and My Work', () => {
  it('Approvals: the pasted list, the counts (all tabs, no filter vs the tab and the search), the filter tree', async () => {
    const a = await actor(app, db, { level: 'approve', regions: [REGION] });
    const s1 = await makeSite(db, REGION, { prefix: PREFIX });
    const s2 = await makeSite(db, REGION, { prefix: PREFIX });
    const s3 = await makeSite(db, REGION, { prefix: PREFIX });
    const t1 = await makeTask(db, s1, 'A2', 'in_approval');
    const t2 = await makeTask(db, s2, 'A2', 'in_approval');
    await makeTask(db, s3, 'A2', 'in_approval');
    await setCell(db, 'A2', REGION, 'approve', { user: [a.user.id] });
    const all = await a.api.call('get', '/approvals?limit=200');
    expect(all.status).toBe(200);
    expect(all.body.counts.total).toBe(all.body.counts.filtered);
    expect(all.body.counts.total).toBeGreaterThanOrEqual(3);
    const q = encodeURIComponent(`${s1.code} ${s2.code.toLowerCase()};${PREFIX}-NONE`);
    const res = await a.api.call('get', `/approvals?limit=200&q=${q}`);
    expect(res.body.items.map((i: { task: { id: string } }) => i.task.id).sort()).toEqual([t1, t2].sort());
    expect(res.body.counts).toEqual({ total: all.body.counts.total, filtered: 2 });
    expect(res.body.search).toEqual({ pasted: 3, found: 2, not_found: [`${PREFIX}-NONE`] });
    expect((await a.api.call('get', `/approvals?limit=200&q=${q}&tab=review`)).body.counts.filtered).toBe(0);
    const tree = encodeURIComponent(JSON.stringify({ op: 'and', items: [{ field: 'site_code', operator: 'is', value: s1.code }] }));
    const f = await a.api.call('get', `/approvals?limit=200&filter=${tree}`);
    expect(f.status).toBe(200);
    expect(f.body.items.map((i: { task: { id: string } }) => i.task.id)).toEqual([t1]);
    // another approver in another region sees none of it, and its counts say so
    const other = await actor(app, db, { level: 'approve', regions: [1] });
    const o = await other.api.call('get', `/approvals?limit=200&q=${q}`);
    expect(o.body.items).toEqual([]);
    expect(o.body.counts.filtered).toBe(0);
    expect(o.body.search.found).toBe(0);
  });

  it('My Work: the pasted list and the counts of a bucket', async () => {
    const e = await actor(app, db, { level: 'entry', regions: [REGION] });
    const s1 = await makeSite(db, REGION, { prefix: PREFIX });
    const s2 = await makeSite(db, REGION, { prefix: PREFIX });
    const t1 = await makeTask(db, s1, 'A3', 'open', { dueDate: '2099-01-01' });
    await makeTask(db, s2, 'A3', 'open', { dueDate: '2099-01-01' });
    await setCell(db, 'A3', REGION, 'entry', { user: [e.user.id] });
    const all = await e.api.call('get', '/me/tasks?bucket=do_now&limit=200');
    expect(all.status).toBe(200);
    expect(all.body.counts.total).toBeGreaterThanOrEqual(2);
    const res = await e.api.call('get', `/me/tasks?bucket=do_now&limit=200&q=${encodeURIComponent(`${s1.code}\t${PREFIX}-NONE`)}`);
    expect(res.body.items.map((x: { id: string }) => x.id)).toEqual([t1]);
    expect(res.body.counts).toEqual({ total: all.body.counts.total, filtered: 1 });
    expect(res.body.search).toEqual({ pasted: 2, found: 1, not_found: [`${PREFIX}-NONE`] });
  });
});
