import type { NestExpressApplication } from '@nestjs/platform-express';
import { unzipSync } from 'fflate';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOC_GRANTS, PDF, PNG, docFlow, slotOf, upload } from './doc-helpers';
import { Api, sleep, startApp, superDbDocs } from './helpers';
import { actor } from './wf-helpers';
import { ZipService } from '../src/documents/zip.service';

/** The bulk zip: per site, per stage, per document type across sites; a background job; region scope; audit. Regions 2 and 3 only (own matrix cells). */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
});
afterAll(async () => {
  await app.get(ZipService).idle();
  await db.end();
  await app.close();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

async function waitJob(api: Api, id: string): Promise<{ status: string; result?: Record<string, unknown>; error?: { detail?: string } }> {
  for (let i = 0; i < 100; i++) {
    const r = await api.call('get', `/jobs/${id}`);
    expect(r.status).toBe(200);
    if (r.body.status === 'done' || r.body.status === 'failed') return r.body;
    await sleep(100);
  }
  throw new Error('the zip job did not finish');
}

const fetchZip = (api: Api, id: string) =>
  api.call('get', `/exports/zip/${id}/download`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

const names = (zipBytes: Buffer): string[] => Object.keys(unzipSync(new Uint8Array(zipBytes))).sort();

describe('bulk zip', () => {
  it('packs one site as SITE/STAGE/NAME with a manifest, as a job, audited at the start and at the download', async () => {
    const f = await docFlow(app, db, 'A2', { region: 2 });
    const g = await docFlow(app, db, 'A3', { region: 2, site: f.site, entry: f.e, approve: f.a });
    const v1 = await upload(f.e.api, f.taskId, (await slotOf(f.e.api, f.taskId, 'A2')).id, PDF, 'one.pdf');
    await upload(f.e.api, f.taskId, (await slotOf(f.e.api, f.taskId, 'A2')).id, PNG, 'one-v2.png', { replaces: v1.body.file_group_id });
    await upload(f.e.api, g.taskId, (await slotOf(f.e.api, g.taskId, 'A3')).id, PDF, 'contract.pdf');

    const start = await f.e.api.call('post', '/exports/zip', { site_id: f.site.id }, { 'Idempotency-Key': `zip-key-${f.site.code}` });
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({ kind: 'zip_export', status: 'queued' });
    const again = await f.e.api.call('post', '/exports/zip', { site_id: f.site.id }, { 'Idempotency-Key': `zip-key-${f.site.code}` });
    expect(again.body.id).toBe(start.body.id);
    const done = await waitJob(f.e.api, start.body.id);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ export_id: start.body.id, file_count: 2 });
    const dl = await fetchZip(f.e.api, start.body.id);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/zip');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="GSDN_Documents_\d{8}\.zip"$/);
    const code = f.site.code;
    const list = names(dl.body as Buffer);
    const files = list.filter((n) => n !== 'manifest.csv');
    expect(files).toHaveLength(2); // the superseded version is not packed
    expect(files.every((n) => n.startsWith(`${code}/MS1/`))).toBe(true);
    expect(files.some((n) => /_A2_A2_DRAFT-\d{8}\.png$/.test(n))).toBe(true);
    expect(files.some((n) => /_A3_A3_DRAFT-\d{8}\.pdf$/.test(n))).toBe(true);
    const unzipped = unzipSync(new Uint8Array(dl.body as Buffer));
    const manifest = Buffer.from(unzipped['manifest.csv']!).toString('utf8');
    expect(manifest).toContain('sha256');
    expect(manifest).toContain('contract.pdf');
    expect(Buffer.from(unzipped[files.find((n) => n.endsWith('.pdf'))!]!).equals(PDF)).toBe(true);
    // audit: the start with its scope and number of files, and the download
    const start_ = await q<{ after: { scope: { site_id: string }; file_count: number } }>(`SELECT after FROM audit_log WHERE action = 'document_zip_start' AND entity_id = $1`, [start.body.id]);
    expect(start_[0]!.after).toMatchObject({ scope: { site_id: f.site.id }, file_count: 2 });
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'document_zip_download' AND entity_id = $1`, [start.body.id])).length).toBe(1);
    // with the history
    const h = await f.e.api.call('post', '/exports/zip', { site_id: f.site.id, include_superseded: true });
    const hd = await waitJob(f.e.api, h.body.id);
    expect(hd.result).toMatchObject({ file_count: 3 });
    expect(names((await fetchZip(f.e.api, h.body.id)).body as Buffer).some((n) => /_v1\.pdf$/.test(n))).toBe(true);
    // per stage, within the site
    const st = await f.e.api.call('post', '/exports/zip', { site_id: f.site.id, stage_code: 'MS2' });
    expect(st.status).toBe(422);
  });

  it('packs one document type across sites, only from the caller regions', async () => {
    const f = await docFlow(app, db, 'A2', { region: 2 });
    const g = await docFlow(app, db, 'A2', { region: 3 });
    const other = await docFlow(app, db, 'A2', { region: 2, entry: f.e, approve: f.a });
    await upload(f.e.api, f.taskId, (await slotOf(f.e.api, f.taskId, 'A2')).id, PDF, 'a.pdf');
    await upload(f.e.api, other.taskId, (await slotOf(f.e.api, other.taskId, 'A2')).id, PNG, 'b.png');
    await upload(g.e.api, g.taskId, (await slotOf(g.e.api, g.taskId, 'A2')).id, PDF, 'c.pdf');
    const s = await f.e.api.call('post', '/exports/zip', { doc_code: 'A2' });
    expect(s.status).toBe(202);
    const done = await waitJob(f.e.api, s.body.id);
    expect(done.status).toBe('done');
    const list = names((await fetchZip(f.e.api, s.body.id)).body as Buffer);
    expect(list.some((n) => n.startsWith(`${f.site.code}/`))).toBe(true);
    expect(list.some((n) => n.startsWith(`${other.site.code}/`))).toBe(true);
    expect(list.some((n) => n.startsWith(`${g.site.code}/`))).toBe(false); // region 3 is outside the caller's regions
    // the person of region 3 gets theirs, not region 2
    const s3 = await g.e.api.call('post', '/exports/zip', { doc_code: 'A2' });
    await waitJob(g.e.api, s3.body.id);
    const list3 = names((await fetchZip(g.e.api, s3.body.id)).body as Buffer);
    expect(list3.some((n) => n.startsWith(`${g.site.code}/`))).toBe(true);
    expect(list3.some((n) => n.startsWith(`${f.site.code}/`))).toBe(false);
    // by file ids
    const ids = (await f.e.api.call('get', `/documents?site_id=${f.site.id}`)).body.items.map((i: { file: { id: string } }) => i.file.id);
    const byIds = await f.e.api.call('post', '/exports/zip', { file_ids: ids });
    expect((await waitJob(f.e.api, byIds.body.id)).result).toMatchObject({ file_count: 1 });
  });

  it('refuses what is outside the scope: another region, no grant, an empty scope, another person job', async () => {
    const f = await docFlow(app, db, 'A2', { region: 2 });
    const up = await upload(f.e.api, f.taskId, (await slotOf(f.e.api, f.taskId, 'A2')).id, PDF, 'a.pdf');
    // a person of another region packs a site they cannot see: nothing matches
    const outsider = await actor(app, db, { level: 'entry', regions: [3], grants: DOC_GRANTS });
    expect((await outsider.api.call('post', '/exports/zip', { site_id: f.site.id })).status).toBe(422);
    expect((await outsider.api.call('post', '/exports/zip', { file_ids: [up.body.id] })).status).toBe(422);
    // no download right
    const noGrant = await actor(app, db, { level: 'entry', regions: [2], grants: [['sites', 'view'], ['sites', 'edit']] });
    expect((await noGrant.api.call('post', '/exports/zip', { site_id: f.site.id })).status).toBe(403);
    // nothing chosen, unknown field
    expect((await f.e.api.call('post', '/exports/zip', {})).status).toBe(422);
    expect((await f.e.api.call('post', '/exports/zip', { site_id: f.site.id, nope: 1 })).status).toBe(422);
    // someone else's job
    const s = await f.e.api.call('post', '/exports/zip', { site_id: f.site.id });
    await waitJob(f.e.api, s.body.id);
    expect((await outsider.api.call('get', `/jobs/${s.body.id}`)).status).toBe(404);
    expect((await outsider.api.call('get', `/exports/zip/${s.body.id}/download`)).status).toBe(404);
    expect((await f.e.api.call('get', '/jobs/not-a-uuid')).status).toBe(404);
    expect((await f.e.api.call('get', `/exports/zip/${s.body.id}/download`).buffer(true)).status).toBe(200);
    // an expired export is gone (410)
    await db.query(`UPDATE document_export_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1`, [s.body.id]);
    const gone = await f.e.api.call('get', `/exports/zip/${s.body.id}/download`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('export_expired');
  });
});
