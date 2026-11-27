import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, superDb } from './helpers';
import { regCell } from './reg-helpers';
import { addAssignment, newRole } from './wf-helpers';

/**
 * Migration 0360 (A3): expiry_radar_notify(). In-app notice to the Matrix holders of a register when a date that ends something is within a lead time of the
 * setting expiry.radar. One notice per record, date and lead step; nothing for a record that is not current and approved, for an expired date, or for a person
 * who is not in the register's Matrix row; nothing at all when the setting is off. It changes no record.
 */
const REGION = 7;
let db: PgClient;
let saved: unknown;

beforeAll(async () => {
  db = await superDb();
  saved = (await db.query(`SELECT value FROM settings WHERE key = 'expiry.radar'`)).rows[0]?.value;
});
afterAll(async () => {
  if (saved) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'expiry.radar'`, [JSON.stringify(saved)]);
  await db.end();
});

const day = async (n: number): Promise<string> => (await db.query(`SELECT (cal_today() + $1::int)::text AS d`, [n])).rows[0].d as string;
const today = async (): Promise<string> => day(0);

async function permit(data: Record<string, unknown>, o: { state?: string; current?: boolean } = {}): Promise<string> {
  const r = await db.query(
    `INSERT INTO register_records (entity_id, version_no, register_key, region_id, state, is_current, data, approved_at, current_level)
     VALUES (gen_random_uuid(), 1, 'permits_hse', $1, $2, $3, $4::jsonb, now(), 3) RETURNING id`,
    [REGION, o.state ?? 'approved', o.current ?? true, JSON.stringify(data)],
  );
  return r.rows[0].id as string;
}
const notices = async (u: string): Promise<{ title: string; body: string; link: string; channel: string }[]> =>
  (await db.query(`SELECT title, body, link, channel::text AS channel FROM notifications WHERE kind = 'expiry_radar' AND user_id = $1 ORDER BY created_at, title`, [u])).rows;

describe('expiry_radar_notify', () => {
  it('notices the Matrix holders once per lead step, and nobody else', async () => {
    const roleId = await newRole(db);
    const holder = await makeUser(db, { status: 'active' });
    const reviewer = await makeUser(db, { status: 'active' });
    const outsider = await makeUser(db, { status: 'active' });
    for (const u of [holder, reviewer]) await addAssignment(db, u.id, { roleId, regions: [REGION], modules: ['permits_hse'] });
    await regCell(db, 'permits_hse', REGION, 'entry', { user: [holder.id] });
    await regCell(db, 'permits_hse', REGION, 'review', { user: [reviewer.id] });
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{enabled}', 'true'::jsonb) WHERE key = 'expiry.radar'`);

    const in10 = await permit({ valid_to: await day(10) });          // inside the 14-day step
    await permit({ valid_to: await day(60) });                       // too far
    await permit({ valid_to: await day(-3) });                       // expired already
    await permit({ valid_to: await day(5) }, { state: 'entry', current: false }); // not approved
    await permit({ valid_to: await day(5) }, { state: 'approved', current: false }); // an older version

    const n = (await db.query('SELECT expiry_radar_notify() AS n')).rows[0].n as number;
    expect(n).toBeGreaterThanOrEqual(2);
    const mine = await notices(holder.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ channel: 'in_app', link: `/registers/permits_hse/records/${in10}` });
    expect(mine[0]!.title).toContain('Expiry in 14 days or less');
    expect(mine[0]!.body).toMatch(/^10 day\(s\) left/);
    expect(await notices(reviewer.id)).toHaveLength(1);
    expect(await notices(outsider.id)).toEqual([]);

    // safe to repeat: the same step is not noticed twice
    await db.query('SELECT expiry_radar_notify()');
    expect(await notices(holder.id)).toHaveLength(1);

    // the date moves closer: the 7-day step is a new notice
    await db.query(`UPDATE register_records SET data = jsonb_set(data, '{valid_to}', to_jsonb($2::text)) WHERE id = $1`, [in10, await day(6)]);
    await db.query('SELECT expiry_radar_notify()');
    const after = await notices(holder.id);
    expect(after).toHaveLength(2);
    expect(after.some((x) => x.title.includes('Expiry in 7 days or less'))).toBe(true);
  });

  it('follows the setting: another lead list, another register field, and off', async () => {
    const roleId = await newRole(db);
    const holder = await makeUser(db, { status: 'active' });
    await addAssignment(db, holder.id, { roleId, regions: [REGION], modules: ['acquisition'] });
    await regCell(db, 'acquisition', REGION, 'entry', { user: [holder.id] });
    const lease = (await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, region_id, state, is_current, data, approved_at, current_level)
       VALUES (gen_random_uuid(), 1, 'acquisition', $1, 'approved', true, $2::jsonb, now(), 3) RETURNING id`,
      [REGION, JSON.stringify({ lease_expiry_date: await day(20) })])).rows[0].id as string;
    expect(await today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 20 days left and the default steps are 30, 14, 7: the 30-day notice
    await db.query('SELECT expiry_radar_notify()');
    expect((await notices(holder.id)).map((x) => x.title)).toEqual([expect.stringContaining('Expiry in 30 days or less')]);

    // lead times are data: with only a 10-day step the 20-day record is quiet; off means off
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{registers,acquisition,lead_days}', '[10]'::jsonb) WHERE key = 'expiry.radar'`);
    await db.query(`DELETE FROM notifications WHERE kind = 'expiry_radar' AND user_id = $1`, [holder.id]);
    await db.query('SELECT expiry_radar_notify()');
    expect(await notices(holder.id)).toEqual([]);
    await db.query(`UPDATE settings SET value = jsonb_set(jsonb_set(value, '{registers,acquisition,lead_days}', '[30]'::jsonb), '{enabled}', 'false'::jsonb) WHERE key = 'expiry.radar'`);
    await db.query('SELECT expiry_radar_notify()');
    expect(await notices(holder.id)).toEqual([]);
    expect((await db.query(`SELECT data ->> 'lease_expiry_date' AS d FROM register_records WHERE id = $1`, [lease])).rows[0].d).toBe(await day(20));
  });
});
