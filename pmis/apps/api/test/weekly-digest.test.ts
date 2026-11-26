import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, superDb } from './helpers';
import { addAssignment, makeSite, newRole, taskDef, type Site } from './wf-helpers';

/**
 * Migration 0166: weekly_digest_notify(), the weekly digest (IN-APP ONLY). One notification per person per week, only on a Sunday, only for active people whose
 * assignment covers the Sites module, counting only the open tasks in their region scope. It changes nothing else.
 */
const REGION = 7;
const OTHER_REGION = 5;
const PREFIX = `WKD${randomBytes(3).toString('hex').toUpperCase()}`;
const SUNDAY = '2031-03-02';
const MONDAY = '2031-03-03';
let db: PgClient;

beforeAll(async () => {
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

async function task(s: Site, code: string, state: string): Promise<string> {
  const td = await taskDef(db, code);
  const level = state === 'open' || state === 'entry' ? 1 : state === 'in_review' ? 2 : state === 'in_approval' ? 3 : 0;
  const r = await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, level_round, updated_at)
     VALUES ($1, $2, $3, $4::"TaskState", $5, 3, 1, now()) RETURNING id`,
    [s.id, s.region, td.id, state, level],
  );
  return r.rows[0].id as string;
}

const digest = async (u: string): Promise<{ title: string; body: string; link: string; channel: string }[]> =>
  (await db.query(`SELECT title, body, link, channel::text AS channel FROM notifications WHERE kind = 'weekly_digest' AND user_id = $1`, [u])).rows;

describe('weekly_digest_notify', () => {
  it('writes one in-app digest per person per week, only on a Sunday, only to people who may see the tasks, counting only their region', async () => {
    const roleId = await newRole(db);
    const site = await makeSite(db, REGION, { prefix: PREFIX });
    const otherSite = await makeSite(db, OTHER_REGION, { prefix: PREFIX });
    await task(site, 'D6', 'entry');
    await task(otherSite, 'D6', 'entry');
    const inScope = await makeUser(db, { status: 'active' });
    const wrongModule = await makeUser(db, { status: 'active' });
    const expired = await makeUser(db, { status: 'active' });
    const deleted = await makeUser(db, { status: 'active' });
    const noAssignment = await makeUser(db, { status: 'active' });
    await addAssignment(db, inScope.id, { roleId, regions: [REGION], modules: ['sites'] });
    await addAssignment(db, wrongModule.id, { roleId, regions: [REGION], modules: ['quality'] });
    const exp = await addAssignment(db, expired.id, { roleId, regions: [REGION], modules: ['sites'] });
    await db.query(`UPDATE user_role_assignments SET valid_from = now() - interval '10 days', valid_to = now() - interval '1 day' WHERE id = $1`, [exp]);
    await addAssignment(db, deleted.id, { roleId, regions: [REGION], modules: ['sites'] });
    await db.query("UPDATE users SET deleted_at = now(), status = 'disabled' WHERE id = $1", [deleted.id]);

    // not a Sunday: nothing is written
    expect((await db.query('SELECT weekly_digest_notify($1::date) AS n', [MONDAY])).rows[0].n).toBe(0);
    expect(await digest(inScope.id)).toEqual([]);

    const n = (await db.query('SELECT weekly_digest_notify($1::date) AS n', [SUNDAY])).rows[0].n as number;
    expect(n).toBeGreaterThanOrEqual(1);
    const mine = await digest(inScope.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Weekly summary, week of 2031-03-02', link: '/my-work', channel: 'in_app' });
    expect(mine[0]!.body).toMatch(/^\d+ open tasks in your scope/);
    for (const u of [wrongModule, expired, deleted, noAssignment]) expect(await digest(u.id)).toEqual([]);

    // safe to repeat: one per person per week
    await db.query('SELECT weekly_digest_notify($1::date) AS n', [SUNDAY]);
    expect(await digest(inScope.id)).toHaveLength(1);
    // the count follows the region: an all-regions person sees at least the two tasks of this test, the one-region person fewer
    const all = await makeUser(db, { status: 'active' });
    await addAssignment(db, all.id, { roleId, regions: null, modules: null });
    await db.query('SELECT weekly_digest_notify($1::date) AS n', ['2031-03-09']);
    const a = Number(/^(\d+) open/.exec((await digest(all.id))[0]!.body)![1]);
    const b = Number(/^(\d+) open/.exec((await digest(inScope.id)).find((x) => x.title.includes('2031-03-09'))!.body)![1]);
    expect(a).toBeGreaterThan(b);
  });
});
