import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDb } from './helpers';
import { day } from './tpl-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';
import { G } from './reg-helpers';

/**
 * Migration 0492 (owner decision D49 part 3, 2026-11-27): the upload policy of the imports. The setting imports.upload_policy is enforce (default, no behaviour
 * change) or accept_incomplete. With accept_incomplete the apply of a Master import run opens the sites of the file first through the door of the screens
 * (site_workflow_locks_set: unlock right, reason, step-up, audit per site). Synthetic data only. Region 6.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 6;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '"enforce"'::jsonb WHERE key = 'imports.upload_policy'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const policy = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'imports.upload_policy'`))[0]?.value;

describe('Settings, Imports: the upload policy setting', () => {
  it('every signed-in user reads it (default enforce); only a System Admin may edit; a change is validated, audited and refused when it is the same value', async () => {
    const admin = await plainAdmin(app, db, false);
    const plain: Actor = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
    const rp = await plain.api.call('get', '/settings/imports/upload-policy');
    expect(rp.status).toBe(200);
    expect(rp.body).toMatchObject({ policy: 'enforce', default_policy: 'enforce', policies: ['enforce', 'accept_incomplete'], can_edit: false });
    expect((await new Api(app).raw('get', '/settings/imports/upload-policy')).status).toBe(401);
    const cur = await admin.api.call('get', '/settings/imports/upload-policy');
    expect(cur.body).toMatchObject({ policy: 'enforce', can_edit: true });

    const denied = await plain.api.call('put', '/settings/imports/upload-policy', { policy: 'accept_incomplete', reason: 'I want it' }, { 'If-Match': etag(cur) });
    expect(denied.status).toBe(403);
    expect(await policy()).toBe('enforce');

    expect((await admin.api.call('put', '/settings/imports/upload-policy', { policy: 'accept_incomplete', reason: 'no tag' })).status).toBe(428);
    for (const bad of [{ policy: 'accept_incomplete' }, { policy: 'accept_incomplete', reason: 'ab' }, { policy: 'valid_rows_only', reason: 'not yet built' },
      { policy: 'accept_incomplete', reason: 'extra key', mode: 'x' }]) {
      const r = await admin.api.call('put', '/settings/imports/upload-policy', bad, { 'If-Match': etag(cur) });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    const same = await admin.api.call('put', '/settings/imports/upload-policy', { policy: 'enforce', reason: 'same value' }, { 'If-Match': etag(cur) });
    expect(same.status).toBe(409);

    const ok = await admin.api.call('put', '/settings/imports/upload-policy', { policy: 'accept_incomplete', reason: 'Historical sheets arrive incomplete' }, { 'If-Match': etag(cur) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ policy: 'accept_incomplete', updated_by: { id: admin.user.id } });
    expect(await policy()).toBe('accept_incomplete');
    const a = await q<{ before: any; after: any; reason: string; actor_id: string }>(db,
      `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'imports_upload_policy_update' ORDER BY id DESC LIMIT 1`);
    expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: 'Historical sheets arrive incomplete', before: { policy: 'enforce' }, after: { policy: 'accept_incomplete' } });
    const back = await admin.api.call('put', '/settings/imports/upload-policy', { policy: 'enforce', reason: 'Back to the default' }, { 'If-Match': etag(ok) });
    expect(back.status).toBe(200);
    expect(await policy()).toBe('enforce');
  });
});

type Cell = string | number | Date | null;
async function masterFile(masterRows: Record<string, Cell>[]): Promise<Buffer> {
  const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
  const ws = wb.addWorksheet('Master');
  for (const c of cols) {
    ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
    ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
    ws.getCell(`${c.letter}3`).value = c.name ?? null;
  }
  masterRows.forEach((r, i) => {
    for (const [L, v] of Object.entries(r)) {
      const cell = ws.getCell(`${L}${5 + i}`);
      cell.value = v as ExcelJS.CellValue;
      if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd';
    }
  });
  const st = wb.addWorksheet('Setting');
  st.getCell('I1').value = 'Project Staff';
  ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const uploadMaster = (api: Api, buf: Buffer): request.Test => {
  const r = api.raw('post', '/master-import/runs');
  if (api.csrf) r.set('X-CSRF-Token', api.csrf);
  return r.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
};
const locks = async (siteId: string) => (await q<{ l: boolean }>(db, 'SELECT workflow_locks AS l FROM sites WHERE id = $1', [siteId]))[0]!.l;

describe('The Master import apply reads the upload policy', () => {
  const applyWith = async (admin: Actor, p: 'enforce' | 'accept_incomplete', code: string) => {
    await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'imports.upload_policy'`, [JSON.stringify(p)]);
    const file = await masterFile([{ A: 1, B: code, AO: day('2026-02-10') }]);
    const up = await uploadMaster(admin.api, file);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    return admin.api.call('post', `/master-import/runs/${up.body.id}/apply`, { mode: 'draft', reason: `Apply under ${p}` }, { 'If-Match': `"${up.body.version}"` });
  };

  it('enforce leaves the site locked; accept_incomplete opens it with an audit row', async () => {
    const admin = await plainAdmin(app, db);
    const keep = await makeSite(db, R, { prefix: 'UPE', status: 'not_started' });
    await makeTask(db, keep, 'MS1', 'approved', { actualDate: '2026-01-05' });
    const open = await makeSite(db, R, { prefix: 'UPA', status: 'not_started' });
    await makeTask(db, open, 'MS1', 'approved', { actualDate: '2026-01-05' });
    expect(await locks(keep.id)).toBe(true);
    expect(await locks(open.id)).toBe(true);

    const e = await applyWith(admin, 'enforce', keep.code);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(await locks(keep.id)).toBe(true);

    const a = await applyWith(admin, 'accept_incomplete', open.code);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(await locks(open.id)).toBe(false);
    const au = await q<{ reason: string; actor_id: string }>(db, `SELECT reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'site_workflow_locks_set' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [open.id]);
    expect(au[0]!.actor_id).toBe(admin.user.id);
    expect(au[0]!.reason).toContain('Upload policy accept incomplete');
  });
});
