import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { downloadTemplate, fillTemplate, load, uploadFile } from './tpl-helpers';
import { makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0156: template IDs follow the section and register names. An old ID is kept in previous_ids; a file that still carries it is refused as an
 * outdated version and the answer names the new template. The filters pre-fill (the Sites list query as JSON) goes through the list and is refused when
 * it is not a JSON object.
 */
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

describe('template IDs after the rename (0156)', () => {
  it('keeps the old ID of every renamed template in previous_ids', async () => {
    const rows = await q<{ template_id: string; previous_ids: string[] }>(db, `SELECT template_id, previous_ids FROM template_definitions WHERE cardinality(previous_ids) > 0`);
    const map = new Map(rows.map((r) => [r.template_id, r.previous_ids]));
    expect(map.get('TPL-MEETINGS')).toContain('TPL-MTG');
    expect(map.get('TPL-PROCUREMENT')).toContain('TPL-PO');
    expect(map.get('TPL-NEW-SITES')).toContain('TPL-SITE-NEW');
    expect(rows.every((r) => r.previous_ids.every((old) => !map.has(old)))).toBe(true);
    const gone = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM template_definitions WHERE template_id IN ('TPL-MTG', 'TPL-PO', 'TPL-SITE-NEW', 'TPL-SITE-CW')`);
    expect(gone[0]!.n).toBe(0);
  });

  it('refuses a file made from an old ID as an outdated version and names the new template', async () => {
    const admin = await plainAdmin(app, db);
    const dl = await downloadTemplate(admin.api, 'TPL-MEETINGS');
    expect(dl.status).toBe(200);
    const buf = await fillTemplate(dl.buffer, [], {
      edit: (wb) => { wb.getWorksheet('_tpl')!.eachRow((r) => { if (r.getCell(1).text === 'template_id') r.getCell(2).value = 'TPL-MTG'; }); },
    });
    const res = await uploadFile(admin.api, buf);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'outdated_version' });
    expect(JSON.stringify(res.body)).toContain('TPL-MEETINGS');
  });

  it('the stored Master create-sites function looks the New sites template up by its new ID', async () => {
    const src = await q<{ s: string }>(db, `SELECT string_agg(prosrc, ' ') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
    expect(src[0]!.s).not.toContain("'TPL-SITE-NEW'");
  });
});

describe('pre-fill by the filters of the Sites list', () => {
  it('refuses filters that are not a JSON object', async () => {
    const admin = await plainAdmin(app, db);
    expect((await downloadTemplate(admin.api, 'TPL-MASTER', '?filters=not-json')).status).toBe(422);
    expect((await downloadTemplate(admin.api, 'TPL-MASTER', `?filters=${encodeURIComponent('[1,2]')}`)).status).toBe(422);
  });

  it('refuses filters that match no site, and pre-fills only the sites the list shows', async () => {
    const admin = await plainAdmin(app, db);
    const none = await downloadTemplate(admin.api, 'TPL-MASTER', `?filters=${encodeURIComponent(JSON.stringify({ q: 'ZZ-NO-SUCH-SITE-0000' }))}`);
    expect(none.status).toBe(422);
    const site = await makeSite(db, 5);
    await makeTask(db, site, 'B4', 'open'); // the pre-fill lists the sites that have a task of the template
    const ok = await downloadTemplate(admin.api, 'TPL-MASTER', `?filters=${encodeURIComponent(JSON.stringify({ q: site.code }))}`);
    expect(ok.status).toBe(200);
    const wb = await load(ok.buffer);
    const ws = wb.getWorksheet('Master')!;
    const cells: string[] = [];
    ws.eachRow((r, n) => { if (n > 1) cells.push(String(r.getCell(2).text)); });
    expect(cells).toContain(site.code);
  });
});
