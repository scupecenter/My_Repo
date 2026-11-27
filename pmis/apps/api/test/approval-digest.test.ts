import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, superDb } from './helpers';
import { regCell } from './reg-helpers';
import { addAssignment, makeSite, newRole } from './wf-helpers';

/**
 * Migration 0362 (A9): approval_digest_notify(). One in-app notice per person per day for what waits at THEIR Matrix level (review or approve), with the count
 * that waited longer than the stale threshold of the setting approvals.digest. Nothing for a person outside the cell, for a claimed level (except the claimant),
 * or when the setting is off. It changes no record.
 */
const REGION = 7;
let db: PgClient;
let saved: unknown;

beforeAll(async () => {
  db = await superDb();
  saved = (await db.query(`SELECT value FROM settings WHERE key = 'approvals.digest'`)).rows[0]?.value;
});
afterAll(async () => {
  if (saved) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'approvals.digest'`, [JSON.stringify(saved)]);
  await db.end();
});

async function waiting(state: string, daysAgo: number, claimant: string | null = null, region = REGION): Promise<string> {
  const r = await db.query(
    `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, current_level, level_opened_at, ball_in_court_user_id)
     VALUES (gen_random_uuid(), 1, 'permits_hse', $1, $2, $3, false, '{}'::jsonb, $4, now() - ($5::int * interval '1 day'), $6) RETURNING id`,
    [(await makeSite(db, region, { prefix: 'APD' })).id, region, state, state === 'in_review' ? 2 : 3, daysAgo, claimant],
  );
  return r.rows[0].id as string;
}
const notices = async (u: string): Promise<{ title: string; body: string; channel: string; link: string }[]> =>
  (await db.query(`SELECT title, body, link, channel::text AS channel FROM notifications WHERE kind = 'approval_digest' AND user_id = $1`, [u])).rows;

describe('approval_digest_notify', () => {
  it('counts what waits at each person level, flags the stale ones and writes one notice per day', async () => {
    const roleId = await newRole(db);
    const reviewer = await makeUser(db, { status: 'active' });
    const approver = await makeUser(db, { status: 'active' });
    const outsider = await makeUser(db, { status: 'active' });
    for (const u of [reviewer, approver]) await addAssignment(db, u.id, { roleId, regions: [REGION], modules: ['permits_hse'], level: 'approve' });
    await regCell(db, 'permits_hse', REGION, 'review', { user: [reviewer.id] });
    await regCell(db, 'permits_hse', REGION, 'approve', { user: [approver.id] });
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{enabled}', 'true'::jsonb) WHERE key = 'approvals.digest'`);
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{stale_days}', '3'::jsonb) WHERE key = 'approvals.digest'`);

    await waiting('in_review', 1);
    await waiting('in_review', 9);          // stale
    await waiting('in_approval', 2);
    await waiting('entry', 20);             // not waiting for a reviewer

    expect((await db.query('SELECT approval_digest_notify() AS n')).rows[0].n as number).toBeGreaterThanOrEqual(2);
    const r = await notices(reviewer.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ channel: 'in_app', link: '/my-work' });
    expect(r[0]!.body).toMatch(/^\d+ item\(s\) waiting at your level \(\d+ task\(s\), \d+ register record\(s\)\); [1-9]\d* waiting more than/);
    expect(Number(/^(\d+) item/.exec((await notices(approver.id))[0]!.body)?.[1])).toBeGreaterThanOrEqual(1);
    expect(await notices(outsider.id)).toEqual([]);

    // daily cap
    await db.query('SELECT approval_digest_notify()');
    expect(await notices(reviewer.id)).toHaveLength(1);
  });

  it('a claimed level counts only for the claimant; a register can set its own threshold; off means off', async () => {
    const roleId = await newRole(db);
    const a = await makeUser(db, { status: 'active' });
    const b = await makeUser(db, { status: 'active' });
    for (const u of [a, b]) await addAssignment(db, u.id, { roleId, regions: [6], modules: ['permits_hse'], level: 'approve' });
    await regCell(db, 'permits_hse', 6, 'review', { user: [a.id, b.id] });
    await waiting('in_review', 5, a.id, 6);
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{registers}', '{"permits_hse": {"stale_days": 10}}'::jsonb) WHERE key = 'approvals.digest'`);
    await db.query('SELECT approval_digest_notify()');
    expect((await notices(a.id))[0]!.body).toMatch(/^1 item\(s\).*; 0 waiting more than/);
    expect(await notices(b.id)).toEqual([]);

    await db.query(`DELETE FROM notifications WHERE kind = 'approval_digest' AND user_id = $1`, [a.id]);
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{enabled}', 'false'::jsonb) WHERE key = 'approvals.digest'`);
    await db.query('SELECT approval_digest_notify()');
    expect(await notices(a.id)).toEqual([]);
  });
});
