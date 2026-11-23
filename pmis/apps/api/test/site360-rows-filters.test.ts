import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, makeSite, makeTask, setCell, Site } from './wf-helpers';

/** GET /site360/{menu}/rows (0.15.50): the stage, mine, late, workflow locks and data gaps filters mean what they mean in GET /sites (same SQL, sites.service). */
const PREFIX = `S360F${randomBytes(3).toString('hex').toUpperCase()}`;
const REGION = 6;
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

const created: string[] = [];
const site = async (over: { status?: string } = {}): Promise<Site> => {
  const s = await makeSite(db, REGION, { prefix: PREFIX, ...over });
  created.push(s.code);
  return s;
};
const rowCodes = (body: { rows: { site_code: string }[] }): string[] => body.rows.map((r) => r.site_code).sort();
const listCodes = (body: { items: { site_code: string }[] }): string[] => body.items.map((r) => r.site_code).sort();

/** Three sites: `late` (B1 overdue, in MS2), `fine` (B1 not due yet, in MS2) and `open` (no task, workflow locks off). */
async function fixture() {
  const late = await site();
  await makeTask(db, late, 'A1', 'approved');
  await makeTask(db, late, 'B1', 'open', { dueDate: '2020-01-01' });
  const fine = await site();
  await makeTask(db, fine, 'A1', 'approved');
  await makeTask(db, fine, 'B1', 'open', { dueDate: '2099-01-01' });
  const open = await site();
  await db.query('UPDATE sites SET workflow_locks = false WHERE id = $1', [open.id]);
  return { late, fine, open };
}

describe('GET /site360/{menu}/rows: the filters of GET /sites', () => {
  it('late, stage, workflow locks: the same sites as GET /sites, on the master menu and a sub-menu', async () => {
    const { late, fine, open } = await fixture();
    const a = await actor(app, db, { regions: [REGION] });
    const ids = created.join(',');
    const rows = async (menu: string, qs: string) => {
      const res = await a.api.call('get', `/site360/${menu}/rows?site_code=${ids}&limit=200&${qs}`);
      expect(res.status, qs).toBe(200);
      return rowCodes(res.body);
    };
    const sites = async (qs: string) => listCodes((await a.api.call('get', `/sites?site_codes=${ids}&limit=200&${qs}`)).body);

    expect(await rows('master', 'bucket=late')).toEqual([late.code]);
    expect(await rows('cw', 'bucket=late')).toEqual([late.code]);
    expect(await sites('bucket=late')).toEqual([late.code]);

    expect(await rows('master', 'stage_code=MS2')).toEqual([fine.code, late.code].sort());
    expect(await rows('te', 'stage_code=MS2')).toEqual(await sites('stage_code=MS2'));
    expect(await rows('master', 'stage_code=MS9')).toEqual([]);

    expect(await rows('master', 'workflow_locks=open')).toEqual([open.code]);
    expect(await rows('master', 'workflow_locks=locked')).toEqual([fine.code, late.code].sort());
    expect(await rows('master', 'workflow_locks=open')).toEqual(await sites('workflow_locks=open'));

    // a filter narrows the count and keeps the total of the sites the caller may see
    const res = await a.api.call('get', `/site360/master/rows?site_code=${ids}&limit=200&bucket=late`);
    expect(res.body.filtered).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
  });

  it('data gaps with and without: the same sites as GET /sites, and together they are every site', async () => {
    await fixture();
    const a = await actor(app, db, { regions: [REGION] });
    const ids = created.join(',');
    const rows = async (qs: string) => rowCodes((await a.api.call('get', `/site360/master/rows?site_code=${ids}&limit=200&${qs}`)).body);
    const sites = async (qs: string) => listCodes((await a.api.call('get', `/sites?site_codes=${ids}&limit=200&${qs}`)).body);
    const withGaps = await rows('data_gaps=with');
    const without = await rows('data_gaps=without');
    expect(withGaps).toEqual(await sites('data_gaps=with'));
    expect(without).toEqual(await sites('data_gaps=without'));
    expect([...withGaps, ...without].sort()).toEqual(await rows(''));
  });

  it('mine: the sites with open work of the caller, and none for a caller who holds nothing', async () => {
    const { late, fine, open } = await fixture();
    const me = await actor(app, db, { regions: [REGION] });
    await setCell(db, 'B1', REGION, 'entry', { user: [me.user.id] });
    const other = await actor(app, db, { regions: [REGION] });
    const ids = [late.code, fine.code, open.code].join(','); // this fixture only: the earlier fixtures of the file hold open B1 work of the same region too
    const rows = async (who: typeof me) => rowCodes((await who.api.call('get', `/site360/master/rows?site_code=${ids}&limit=200&bucket=mine`)).body);
    const mineList = async (who: typeof me) => listCodes((await who.api.call('get', `/sites?site_codes=${ids}&limit=200&bucket=mine`)).body);
    expect(await rows(me)).toEqual([fine.code, late.code].sort());
    expect(await rows(me)).not.toContain(open.code);
    expect(await rows(me)).toEqual(await mineList(me));
    expect(await rows(other)).toEqual([]);
  });

  it('combines with the other filters and refuses an unknown value', async () => {
    const { late, fine, open } = await fixture();
    const a = await actor(app, db, { regions: [REGION] });
    const ids = [late.code, fine.code, open.code].join(','); // this fixture only, earlier fixtures have late sites too
    const ok = await a.api.call('get', `/site360/master/rows?site_code=${ids}&limit=200&bucket=late&stage_code=MS2&workflow_locks=locked&scenario=new_build&region_id=${REGION}`);
    expect(ok.status).toBe(200);
    expect(rowCodes(ok.body)).toEqual([late.code]);
    expect((await a.api.call('get', `/site360/master/rows?bucket=nope`)).status).toBe(422);
    expect((await a.api.call('get', `/site360/master/rows?workflow_locks=maybe`)).status).toBe(422);
    expect((await a.api.call('get', `/site360/master/rows?data_gaps=some`)).status).toBe(422);
  });
});
