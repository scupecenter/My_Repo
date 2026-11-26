import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchRanges } from '../src/search/search-text';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Global search (plan F4, migration 0099, contract 0.15.19): Arabic-normalised matching, highlight offsets, the group visibility rules
 * (module and region, never a 403 for a group), and the Site ID list (found, not found, out of reach reported as not found).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let inRegion: Actor;
let nothing: Actor;
const R = 5;
const OTHER = 6;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  inRegion = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R], modules: null });
  nothing = await actor(app, db, { level: 'view', grants: [], regions: [R], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('matchRanges (the highlight rule)', () => {
  it('finds the match across Arabic letter forms and returns raw offsets', () => {
    const title = 'SITE-1 - مَحطة الاختبار';
    const ranges = matchRanges(title, 'محطه الاختبار');
    expect(ranges).toHaveLength(1);
    const [s, e] = ranges[0]!;
    expect(title.slice(s, e)).toBe('مَحطة الاختبار');
  });

  it('ignores case and Latin diacritics, and maps Arabic-Indic digits', () => {
    const r = matchRanges('Café Site ٣٤', 'CAFE');
    expect(r).toEqual([[0, 4]]);
    expect(matchRanges('Site ٣٤', '34')).toEqual([[5, 7]]);
  });

  it('returns nothing for a term that is only tashkeel or an unmatched text', () => {
    expect(matchRanges('مدينة', 'ً')).toEqual([]);
    expect(matchRanges('Tripoli', 'benghazi')).toEqual([]);
  });
});

describe('GET /search', () => {
  it('finds a site by its Arabic name in another letter form, and highlights it in the title', async () => {
    const site = await makeSite(db, R, { prefix: 'SRA' });
    await db.query("UPDATE sites SET name_ar = 'محطة الاختبار الأولى' WHERE id = $1", [site.id]);
    const res = await admin.api.call('get', `/search?q=${encodeURIComponent('محطه الاختبار')}&types=sites`);
    expect(res.status).toBe(200);
    const group = res.body.groups[0];
    expect(group.type).toBe('sites');
    const hit = group.items.find((i: { id: string }) => i.id === site.id);
    expect(hit).toBeDefined();
    const [range] = hit.match_ranges;
    expect(hit.title.slice(range[0], range[1])).toBe('محطة الاختبار');
    expect(hit.href).toBe(`/sites/${site.id}`);
  });

  it('answers 200 with no groups for a caller who may read nothing', async () => {
    const res = await nothing.api.call('get', '/search?q=sra');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it('leaves out the people and contractors groups unless the caller holds their module', async () => {
    const res = await inRegion.api.call('get', '/search?q=site');
    const types = res.body.groups.map((g: { type: string }) => g.type);
    expect(types).toContain('sites');
    expect(types).not.toContain('people');
    expect(types).not.toContain('contractors');
    const asAdmin = await admin.api.call('get', '/search?q=site&types=people');
    expect(asAdmin.body.groups.map((g: { type: string }) => g.type)).toEqual(['people']);
  });

  it('refuses a query under two characters and an unknown group (422)', async () => {
    expect((await admin.api.call('get', '/search?q=a')).status).toBe(422);
    expect((await admin.api.call('get', '/search?q=ab&types=gold')).status).toBe(422);
  });

  it('does not show a site of a region the caller cannot read', async () => {
    const site = await makeSite(db, OTHER, { prefix: 'OUT' });
    const res = await inRegion.api.call('get', `/search?q=${site.code}&types=sites`);
    expect(res.body.groups[0]?.items ?? []).toHaveLength(0);
  });
});

describe('GET /search tasks and warehouse_items', () => {
  it('finds a task by its code inside the caller regions only, and opens it from the site page', async () => {
    const mine = await makeSite(db, R, { prefix: 'TSK' });
    const far = await makeSite(db, OTHER, { prefix: 'TSK' });
    const def = await db.query(
      "SELECT td.code FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.is_active ORDER BY td.code LIMIT 1");
    const code = def.rows[0].code as string;
    const taskId = await makeTask(db, mine, code);
    const farTask = await makeTask(db, far, code);
    const res = await inRegion.api.call('get', `/search?q=${encodeURIComponent(`${code}`)}&types=tasks&limit=10`);
    expect(res.status).toBe(200);
    const items = (res.body.groups[0]?.items ?? []) as { id: string; href: string; region_id: number }[];
    expect(items.every((i) => i.region_id === R)).toBe(true);
    expect(items.find((i) => i.id === farTask)).toBeUndefined();
    const bySite = await inRegion.api.call('get', `/search?q=${encodeURIComponent(mine.code)}&types=tasks&limit=10`);
    const hit = (bySite.body.groups[0]?.items as { id: string; href: string }[]).find((i) => i.id === taskId);
    expect(hit?.href).toBe(`/sites/${mine.id}?task=${taskId}`);
  });

  it('leaves the tasks group out for a caller who may read no site, and warehouse_items without the warehouse right', async () => {
    const res = await nothing.api.call('get', '/search?q=item&types=tasks,warehouse_items');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it('finds a warehouse item by code or Arabic-normalised name for a warehouse viewer', async () => {
    const code = `SRCH-${Date.now()}`;
    await db.query("INSERT INTO warehouse_items (item_code, item_group, name, name_ar) VALUES ($1, 'WL', 'Search probe', 'كابل اختبار')", [code]);
    const res = await admin.api.call('get', `/search?q=${encodeURIComponent('كابل اختبار')}&types=warehouse_items`);
    expect(res.status).toBe(200);
    const g = res.body.groups[0];
    expect(g.type).toBe('warehouse_items');
    expect((g.items as { title: string }[]).some((i) => i.title.startsWith(code))).toBe(true);
  });
});

describe('POST /search/site-ids', () => {
  it('finds sites in reach, case-insensitively, and lists the others as not found in input order', async () => {
    const mine = await makeSite(db, R, { prefix: 'LST' });
    const far = await makeSite(db, OTHER, { prefix: 'LSO' });
    const res = await inRegion.api.call('post', '/search/site-ids', {
      ids: [mine.code.toLowerCase(), far.code, 'NO-SUCH-1', `  ${mine.code}  `, 'NO-SUCH-1'],
    });
    expect(res.status).toBe(200);
    expect(res.body.found.map((f: { id: string }) => f.id)).toEqual([mine.id]);
    expect(res.body.found[0].href).toBe(`/sites/${mine.id}`);
    expect(res.body.not_found).toEqual([far.code, 'NO-SUCH-1']);
  });

  it('refuses an empty list (422)', async () => {
    expect((await admin.api.call('post', '/search/site-ids', { ids: [] })).status).toBe(422);
  });
});

describe('GET /sites?site_codes=', () => {
  it('keeps only the listed Site IDs, from a list with commas, spaces and new lines', async () => {
    const a = await makeSite(db, R, { prefix: 'FLT' });
    const b = await makeSite(db, R, { prefix: 'FLT' });
    await makeSite(db, R, { prefix: 'FLT' });
    const res = await admin.api.call('get', `/sites?site_codes=${encodeURIComponent(`${a.code},\n${b.code.toLowerCase()} `)}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});
