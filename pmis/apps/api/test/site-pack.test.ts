import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, sleep, startApp, superDb } from './helpers';
import { actor, makeSite, type Site } from './wf-helpers';
import { MasterExportService } from '../src/exports/master-export.service';

/** Contract 0.15.461 (D5): the site pack, a zip of one site with one workbook per part the caller may export. */
const TAG = randomBytes(3).toString('hex').toUpperCase();
let app: NestExpressApplication;
let db: PgClient;
let sebha: Site, other: Site, gm: Site;
const EXPORTER: [string, string][] = [['sites', 'view'], ['sites', 'export']];

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  sebha = await makeSite(db, 7, { prefix: `SP${TAG}S` });
  other = await makeSite(db, 7, { prefix: `SP${TAG}T` });
  gm = await makeSite(db, 6, { prefix: `SP${TAG}G` });
});
afterAll(async () => {
  await app.get(MasterExportService).idle();
  await db.end();
  await app.close();
});

async function finished(api: Api, id: string): Promise<Record<string, any>> {
  await app.get(MasterExportService).idle();
  for (let i = 0; i < 100; i++) {
    const e = (await api.call('get', '/exports/master')).body.items.find((x: { id: string }) => x.id === id);
    if (e && (e.status === 'done' || e.status === 'failed')) return e;
    await sleep(100);
  }
  throw new Error('the pack did not finish');
}

describe('POST /exports/master with site_pack', () => {
  it('writes a zip of the site: the parts the caller may export, a README, only that site', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    const start = await a.api.call('post', '/exports/master', { site_pack: { site_id: sebha.id } });
    expect(start.status).toBe(202);
    const done = await finished(a.api, start.body.id);
    expect(done.status).toBe('done');
    expect(done.kind).toBe('site_pack');
    expect(done.site_id).toBe(sebha.id);
    const res = await a.api.call('get', `/exports/master/${start.body.id}/download`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('.zip');
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'milestones.xlsx', 'sites.xlsx', 'tasks.xlsx']);
    expect(strFromU8(files['README.txt']!)).toContain(sebha.code);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(files['sites.xlsx']!) as unknown as ExcelJS.Buffer);
    const codes: string[] = [];
    book.worksheets[0]!.eachRow((row) => { const v = row.getCell(2).value; if (typeof v === 'string' && v.startsWith(`SP${TAG}`)) codes.push(v); });
    expect(codes).toEqual([sebha.code]);
  });

  it('is refused for a site outside the export region, for a caller without the export grant, and for an unknown site', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    expect((await a.api.call('post', '/exports/master', { site_pack: { site_id: gm.id } })).status).toBe(404);
    const viewer = await actor(app, db, { regions: [7], grants: [['sites', 'view']] });
    expect((await viewer.api.call('post', '/exports/master', { site_pack: { site_id: other.id } })).status).toBe(403);
    expect((await a.api.call('post', '/exports/master', { site_pack: { site_id: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
  });

  it('refuses the site pack together with parts, a view or regions, and a part the caller may not export', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    expect((await a.api.call('post', '/exports/master', { site_pack: { site_id: sebha.id }, parts: ['sites'] })).status).toBe(422);
    expect((await a.api.call('post', '/exports/master', { site_pack: { site_id: sebha.id, parts: ['gecol'] } })).status).toBe(403);
  });

  it('audits the start with the site id', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    const start = await a.api.call('post', '/exports/master', { site_pack: { site_id: other.id, parts: ['sites'] } });
    expect(start.status).toBe(202);
    await finished(a.api, start.body.id);
    const aud = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'master_export.start' AND entity_id = $1 AND after->>'site_id' = $2`, [start.body.id, other.id]);
    expect(aud.rows[0].n).toBe(1);
  });
});
