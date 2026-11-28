import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/** Migration 0642: imp_link_errors, the link fields the data upload checks. Records are written and rolled back inside one transaction. */
let db: PgClient;
beforeAll(async () => { db = await superDb(); });
afterAll(async () => { await db.end(); });

const check = async (key: string, data: Record<string, string>, seed: [string, string | null][]) => {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.region_ids', '*', true)");
    await db.query('SET LOCAL session_replication_role = replica');
    const ids: string[] = [];
    for (const [k, t] of seed) {
      const e = (await db.query('SELECT gen_random_uuid()::text AS u')).rows[0].u as string;
      await db.query("INSERT INTO register_records (entity_id, register_key, record_type, is_global, levels_required, version_no, state) VALUES ($1, $2, $3, true, 2, 1, 'approved')", [e, k, t]);
      ids.push(e);
    }
    const body = JSON.stringify(data).replace(/\$(\d)/g, (_m, i: string) => ids[Number(i)]!);
    return (await db.query('SELECT imp_link_errors($1, $2::jsonb) AS r', [key, body])).rows[0].r as { path: string; code: string }[];
  } finally { await db.query('ROLLBACK'); }
};

describe('imp_link_errors (0642)', () => {
  it('a Procurement link of HLC: a real record passes, a blank passes, text is invalid, an unknown id is link_not_found', async () => {
    expect(await check('hlc', { procurement_record_id: '$0' }, [['procurement', null]])).toEqual([]);
    expect(await check('hlc', { procurement_record_id: '' }, [])).toEqual([]);
    expect(await check('hlc', { procurement_record_id: 'nope' }, [])).toMatchObject([{ path: '/data/procurement_record_id', code: 'invalid' }]);
    expect(await check('hlc', { procurement_record_id: '11111111-1111-4111-8111-111111111111' }, [])).toMatchObject([{ code: 'link_not_found' }]);
  });
  it('vehicle, booking to extend and advance to extend must be of the right kind; links with a rule of their own are not checked here', async () => {
    const seed: [string, string | null][] = [['car_dispatcher', 'vehicle'], ['car_dispatcher', 'booking'], ['financial_advances', 'advance']];
    expect(await check('car_dispatcher', { vehicle_id: '$0', parent_booking_id: '$1' }, seed)).toEqual([]);
    expect((await check('car_dispatcher', { vehicle_id: '$1', parent_booking_id: '$0' }, seed)).map((e) => e.path)).toEqual(['/data/vehicle_id', '/data/parent_booking_id']);
    expect(await check('financial_advances', { parent_advance_id: '$2' }, seed)).toEqual([]);
    expect(await check('financial_advances', { parent_advance_id: '$1' }, seed)).toMatchObject([{ code: 'link_not_found' }]);
    expect(await check('issues', { procurement_order_id: 'nope' }, [])).toEqual([]);
  });
});
