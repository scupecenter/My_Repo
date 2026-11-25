import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, makeSite, Site } from './wf-helpers';

/**
 * W8 (contract 0.15.68): the search box reads a pasted list of Site IDs on the server (items 5) and the lists answer the total and the filtered
 * counts (item 6), on GET /sites and GET /site-master/{menu}/rows. Region scope: a site of another region is never counted, never returned and is
 * reported as not found.
 */
const PREFIX = `W8S${randomBytes(3).toString('hex').toUpperCase()}`;
const REGION = 7;
const OTHER = 3;
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

const site = async (region = REGION, status = 'in_progress'): Promise<Site> => makeSite(db, region, { prefix: PREFIX, status });
const listCodes = (body: { items: { site_code: string }[] }): string[] => body.items.map((r) => r.site_code).sort();
const rowCodes = (body: { rows: { site_code: string }[] }): string[] => body.rows.map((r) => r.site_code).sort();

describe('W8: pasted-list search and counts', () => {
  it('GET /sites: spaces, new lines, tabs, commas and semicolons, mixed case, the owner ID, and the not-found list', async () => {
    const a1 = await site();
    const a2 = await site();
    const a3 = await site();
    const owner = `OWN-${randomBytes(3).toString('hex').toUpperCase()}`;
    await db.query('UPDATE sites SET owner_site_id = $1 WHERE id = $2', [owner, a3.id]);
    const away = await site(OTHER);
    const me = await actor(app, db, { regions: [REGION] });
    const missing = `${PREFIX}-NOPE`;
    const pasted = `${a1.code.toLowerCase()}\n${a2.code}\t${owner.toLowerCase()};${away.code}, ${missing} ${a1.code}`;
    const res = await me.api.call('get', `/sites?limit=200&q=${encodeURIComponent(pasted)}`);
    expect(res.status).toBe(200);
    expect(listCodes(res.body)).toEqual([a1.code, a2.code, a3.code].sort());
    expect(res.body.search).toEqual({ pasted: 5, found: 3, not_found: [away.code, missing] });
    expect(res.body.counts.filtered).toBe(3);
    expect(res.body.page.total).toBe(3);
    // the total is every site of the caller's region, never the other region's
    const all = await db.query('SELECT count(*)::int AS n FROM sites WHERE is_active AND region_id = $1', [REGION]);
    expect(res.body.counts.total).toBe(all.rows[0].n);
  });

  it('GET /sites: one token keeps the contains search, a filter narrows filtered and keeps total', async () => {
    const s1 = await site();
    await site(REGION, 'on_hold');
    const me = await actor(app, db, { regions: [REGION] });
    const one = await me.api.call('get', `/sites?limit=200&q=${s1.code.slice(0, -2).toLowerCase()}`);
    expect(one.status).toBe(200);
    expect(listCodes(one.body)).toContain(s1.code);
    expect(one.body.search).toBeUndefined();
    const plain = await me.api.call('get', '/sites?limit=1');
    const held = await me.api.call('get', `/sites?limit=1&overall_status=on_hold&q=${PREFIX}`);
    expect(held.body.counts.total).toBe(plain.body.counts.total);
    expect(plain.body.counts.filtered).toBe(plain.body.counts.total);
    expect(held.body.counts.filtered).toBeLessThan(held.body.counts.total);
    expect(held.body.counts.filtered).toBeGreaterThanOrEqual(1);
  });

  it('GET /sites and the rows of a menu: more than 1000 codes answer 422 too_many_codes; 1000 are accepted', async () => {
    const me = await actor(app, db, { regions: [REGION] });
    const codes = (n: number) => Array.from({ length: n }, (_, i) => `ZZ${i}`).join(' ');
    const bad = await me.api.call('get', `/sites?q=${encodeURIComponent(codes(1001))}`);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/q', code: 'too_many_codes' });
    const bad2 = await me.api.call('get', `/site-master/master/rows?q=${encodeURIComponent(codes(1001))}`);
    expect(bad2.status).toBe(422);
    const ok = await me.api.call('get', `/sites?q=${encodeURIComponent(codes(1000))}`);
    expect(ok.status).toBe(200);
    expect(ok.body.search.pasted).toBe(1000);
  });

  it('GET /site-master/{menu}/rows: the same pasted list, counts and not-found list, region scope kept', async () => {
    const a1 = await site();
    const a2 = await site();
    const away = await site(OTHER);
    const me = await actor(app, db, { regions: [REGION] });
    const q = encodeURIComponent(`${a1.code} ${a2.code.toLowerCase()} ${away.code}`);
    for (const menu of ['master', 'cw']) {
      const res = await me.api.call('get', `/site-master/${menu}/rows?limit=200&q=${q}`);
      expect(res.status, menu).toBe(200);
      expect(rowCodes(res.body)).toEqual([a1.code, a2.code].sort());
      expect(res.body.filtered).toBe(2);
      expect(res.body.search).toEqual({ pasted: 3, found: 2, not_found: [away.code] });
      expect(res.body.rows.map((r: { row_no: number }) => r.row_no)).toEqual([1, 2]);
    }
    // one token: contains on the code and the name
    const one = await me.api.call('get', `/site-master/master/rows?limit=200&q=${encodeURIComponent(a1.code.toLowerCase())}`);
    expect(rowCodes(one.body)).toEqual([a1.code]);
    expect(one.body.search).toBeUndefined();
    // a caller of the other region sees only that site
    const other = await actor(app, db, { regions: [OTHER] });
    const res = await other.api.call('get', `/site-master/master/rows?limit=200&q=${q}`);
    expect(rowCodes(res.body)).toEqual([away.code]);
    expect(res.body.search.not_found.sort()).toEqual([a1.code, a2.code].sort());
  });
});
