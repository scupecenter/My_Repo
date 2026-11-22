import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { delegate, sleep, startApp, superDbScols } from './helpers';
import { MasterExportService } from '../src/exports/master-export.service';
import { Actor, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Workflow Studio S2 (contract 0.15.43, migration 0132): the admin of the Site Master columns. Its own database (TEST_DATABASE_URL_SCOLS): the suite adds, retypes,
 * moves, deactivates and deletes Master columns. The tests build on one another, in order.
 */
const REASON = 'Studio columns test';
const BAND = 'Studio Test';
const TAG = randomBytes(3).toString('hex');

let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let taskCode: string;
let delegateApi: Actor['api'];
let regionDelegateApi: Actor['api'];

/** The first column the suite adds, and what it needs to be read and changed. */
let first = { ord: 0, letter: '', version: 0, key: '' };
let siteCode = '';

const body = (over: Record<string, unknown> = {}) => ({
  name_en: `Studio Permit Ref ${TAG}`,
  name_ar: 'مرجع الترخيص',
  group_top: BAND,
  group_mid: 'Custom',
  after_ord: 187,
  value_type: 'text',
  source: { kind: 'task_input', task_code: taskCode },
  sections: ['cw'],
  reason: REASON,
  ...over,
});
const ifMatch = (v: number): Record<string, string> => ({
  'If-Match': `"${v}"`,
});
const errorsOf = (res: {
  body: { errors?: { path: string; code: string }[] };
}): string => JSON.stringify(res.body.errors ?? []);

beforeAll(async () => {
  app = await startApp({
    databaseUrl: process.env.TEST_DATABASE_URL_SCOLS as string,
  });
  db = await superDbScols();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
  const t = await q<{ code: string }>(
    db,
    `SELECT td.code FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 ORDER BY td.code LIMIT 1`,
  );
  taskCode = t[0]!.code;
  // a delegate of the custom fields for all regions, and one for a single region
  const d = await actor(app, db, { level: 'entry' });
  await delegate(db, d.user.id, [['fields', 'edit']]);
  delegateApi = d.api;
  const r = await actor(app, db, { level: 'entry' });
  await delegate(db, r.user.id, [['fields', 'edit']], [1]);
  regionDelegateApi = r.api;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('permissions', () => {
  it('refuses a plain user on every endpoint with 403 action_forbidden', async () => {
    const calls = [
      plain.api.call('get', '/site360/columns'),
      plain.api.call('get', '/site360/columns/2'),
      plain.api.call('post', '/site360/columns', body()),
      plain.api.call(
        'patch',
        '/site360/columns/2',
        { name_en: 'x1', reason: REASON },
        ifMatch(1),
      ),
      plain.api.call('post', '/site360/columns/2/type-preview', {
        value_type: 'text',
      }),
      plain.api.call(
        'post',
        '/site360/columns/2/deactivate',
        { reason: REASON },
        ifMatch(1),
      ),
      plain.api.call(
        'post',
        '/site360/columns/2/reactivate',
        { reason: REASON },
        ifMatch(1),
      ),
      plain.api.call(
        'delete',
        `/site360/columns/188?reason=${encodeURIComponent(REASON)}`,
        undefined,
        ifMatch(1),
      ),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('action_forbidden');
    }
  });

  it('refuses a delegate of the custom fields who covers one region only', async () => {
    const res = await regionDelegateApi.call('get', '/site360/columns');
    expect(res.status).toBe(403);
    const w = await regionDelegateApi.call('post', '/site360/columns', body());
    expect(w.status).toBe(403);
  });

  it('lets a delegate of the custom fields for all regions read the columns', async () => {
    const res = await delegateApi.call('get', '/site360/columns');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(187);
  });

  it('asks for the step-up after the permission: an admin without it is 401 step_up_required, a plain user stays 403', async () => {
    const res = await noStep.api.call('post', '/site360/columns', body());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('step_up_required');
    const upd = await noStep.api.call(
      'patch',
      '/site360/columns/2',
      { name_en: 'x2', reason: REASON },
      ifMatch(1),
    );
    expect(upd.status).toBe(401);
  });

  it('needs If-Match on the writes of one column: missing is 428', async () => {
    const upd = await admin.api.call('patch', '/site360/columns/2', {
      name_en: 'x3',
      reason: REASON,
    });
    expect(upd.status).toBe(428);
    const off = await admin.api.call('post', '/site360/columns/2/deactivate', {
      reason: REASON,
    });
    expect(off.status).toBe(428);
    const del = await admin.api.call(
      'delete',
      `/site360/columns/188?reason=${encodeURIComponent(REASON)}`,
    );
    expect(del.status).toBe(428);
  });
});

describe('the list of the columns', () => {
  it('lists the 187 original columns in display order with their bands, types and protection', async () => {
    const res = await admin.api.call('get', '/site360/columns');
    expect(res.status).toBe(200);
    const items = res.body.items as {
      ord: number;
      letter: string;
      display_order: number;
      is_protected: boolean;
      is_added: boolean;
      value_type: string;
      version: number;
    }[];
    expect(items.slice(0, 187).map((c) => c.ord)).toEqual(
      Array.from({ length: 187 }, (_, i) => i + 1),
    );
    expect(items[0]).toMatchObject({
      letter: 'A',
      display_order: 1,
      is_added: false,
    });
    expect(items[186]).toMatchObject({ letter: 'GE', display_order: 187 });
    expect(items[1]!.is_protected).toBe(true); // Site ID
    expect(
      items.every(
        (c) =>
          c.version >= 1 &&
          ['text', 'number', 'date', 'list', 'yes_no'].includes(c.value_type),
      ),
    ).toBe(true);
    expect(res.body.types).toEqual([
      'text',
      'number',
      'date',
      'list',
      'yes_no',
    ]);
    expect(res.body.bands.length).toBeGreaterThan(5);
    expect(res.body.bands[0]).toMatchObject({ name: '#' });
  });

  it('reads one column with its ETag, value_count and delete_mode (null count and blocked for a protected column)', async () => {
    const res = await admin.api.call('get', '/site360/columns/2');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^"\d+"$/);
    expect(res.body).toMatchObject({
      ord: 2,
      letter: 'B',
      is_protected: true,
      value_count: null,
      delete_mode: 'blocked',
    });
    expect((await admin.api.call('get', '/site360/columns/999')).status).toBe(
      404,
    );
    expect((await admin.api.call('get', '/site360/columns/abc')).status).toBe(
      422,
    );
  });
});

describe('adding a column', () => {
  it('refuses a bad place, a reserved band, a missing type or list and an unknown task, with field-level errors', async () => {
    const split = await admin.api.call(
      'post',
      '/site360/columns',
      body({ after_ord: 10, group_top: 'PRE-CW' }),
    );
    expect(split.status).toBe(422);
    expect(errorsOf(split)).toContain('placement_splits_band');
    const reserved = await admin.api.call(
      'post',
      '/site360/columns',
      body({ group_top: 'STATUS' }),
    );
    expect(reserved.status).toBe(422);
    expect(errorsOf(reserved)).toContain('reserved_band');
    const noType = await admin.api.call(
      'post',
      '/site360/columns',
      body({ value_type: undefined }),
    );
    expect(noType.status).toBe(422);
    expect(errorsOf(noType)).toContain('/value_type');
    const noList = await admin.api.call(
      'post',
      '/site360/columns',
      body({ value_type: 'list' }),
    );
    expect(noList.status).toBe(422);
    expect(errorsOf(noList)).toContain('list_required');
    const listOnText = await admin.api.call(
      'post',
      '/site360/columns',
      body({ list_catalogue: 'Whatever' }),
    );
    expect(listOnText.status).toBe(422);
    expect(errorsOf(listOnText)).toContain('list_not_allowed');
    const task = await admin.api.call(
      'post',
      '/site360/columns',
      body({ source: { kind: 'task_input', task_code: 'NO-SUCH-TASK' } }),
    );
    expect(task.status).toBe(422);
    expect(errorsOf(task)).toContain('unknown_task');
    const after = await admin.api.call(
      'post',
      '/site360/columns',
      body({ after_ord: 999 }),
    );
    expect(after.status).toBe(422);
    expect(errorsOf(after)).toContain('unknown_column');
    const unknown = await admin.api.call('post', '/site360/columns', {
      ...body(),
      color: 'red',
    });
    expect(unknown.status).toBe(422);
    expect(
      (await q(db, `SELECT 1 FROM master_columns WHERE ord > 187`)).length,
    ).toBe(0);
  });

  it('adds a column after the last one with a new task input: it takes the letter GF and the next Master order, and is audited', async () => {
    const res = await admin.api.call('post', '/site360/columns', body());
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body).toMatchObject({
      ord: 188,
      letter: 'GF',
      display_order: 188,
      is_added: true,
      is_protected: false,
      is_active: true,
      value_type: 'text',
      group_top: BAND,
      group_mid: 'Custom',
      name_en: `Studio Permit Ref ${TAG}`,
      name_ar: 'مرجع الترخيص',
      header: `Custom / Studio Permit Ref ${TAG}`,
      sections: ['cw'],
      value_count: 0,
      delete_mode: 'hard',
    });
    expect(res.body.source).toMatchObject({
      kind: 'task',
      task_code: taskCode,
    });
    first = {
      ord: res.body.ord,
      letter: res.body.letter,
      version: 1,
      key: String(res.body.source.field_key),
    };
    expect(first.key).toBe(`v:studio_permit_ref_${TAG}`);
    const tf = await q<{
      master_col: string;
      field_type: string;
      is_active: boolean;
    }>(
      db,
      `SELECT master_col, field_type, is_active FROM template_task_fields WHERE task_code = $1 AND field_key = $2`,
      [taskCode, first.key],
    );
    expect(tf).toEqual([
      { master_col: 'GF', field_type: 'text', is_active: true },
    ]);
    const au = await q<{
      before: unknown;
      after: { ord: number };
      reason: string;
      entity_type: string;
    }>(
      db,
      `SELECT before, after, reason, entity_type FROM audit_log WHERE action = 'site360.column_created' AND entity_id = 'GF'`,
    );
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({
      before: null,
      reason: REASON,
      entity_type: 'master_column',
    });
    expect(au[0]!.after.ord).toBe(188);
  });

  it('refuses the same header again (409 duplicate) and the same input again (409 input_already_mapped)', async () => {
    const dup = await admin.api.call(
      'post',
      '/site360/columns',
      body({
        source: {
          kind: 'task_input',
          task_code: taskCode,
          field_key: 'v:another_key',
        },
      }),
    );
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
    const again = await admin.api.call(
      'post',
      '/site360/columns',
      body({
        name_en: `Other name ${TAG}`,
        source: {
          kind: 'task_input',
          task_code: taskCode,
          field_key: first.key,
        },
      }),
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('input_already_mapped');
  });

  it('shows the column in the Master and CW menus after the 187, with the values of the task input, and not in the TE menu', async () => {
    const site = await makeSite(db, 1, { prefix: `SC${TAG.toUpperCase()}` });
    siteCode = site.code;
    const task = await makeTask(db, site, taskCode, 'open');
    await db.query(
      `UPDATE task_instances SET "values" = jsonb_build_object($1::text, 'PR-001') WHERE id = $2`,
      [first.key.slice(2), task],
    );
    const master = await admin.api.call(
      'get',
      `/site360/master/rows?site_code=${site.code}`,
    );
    expect(master.status).toBe(200);
    const cols = master.body.menu.columns as {
      ord: number;
      letter: string;
      display_order: number;
      is_added: boolean;
    }[];
    expect(cols[cols.length - 1]).toMatchObject({
      ord: 188,
      letter: 'GF',
      is_added: true,
      display_order: 188,
    });
    expect(master.body.rows[0].values['188']).toBe('PR-001');
    const cw = await admin.api.call(
      'get',
      `/site360/cw/rows?site_code=${site.code}`,
    );
    expect(cw.body.menu.columns.map((c: { ord: number }) => c.ord)).toContain(
      188,
    );
    expect(cw.body.rows[0].values['188']).toBe('PR-001');
    const te = await admin.api.call(
      'get',
      `/site360/te/rows?site_code=${site.code}`,
    );
    expect(
      te.body.menu.columns.map((c: { ord: number }) => c.ord),
    ).not.toContain(188);
    // a task-backed cell is editable inline like any other task input
    expect(master.body.rows[0].cells['188']).toMatchObject({
      task_id: task,
      values: first.key.slice(2),
    });
  });

  it('counts the sites that hold a value and refuses a delete with 409 column_in_use', async () => {
    const res = await admin.api.call('get', `/site360/columns/${first.ord}`);
    expect(res.body).toMatchObject({
      value_count: 1,
      delete_mode: 'deactivate',
    });
    const del = await admin.api.call(
      'delete',
      `/site360/columns/${first.ord}?reason=${encodeURIComponent(REASON)}`,
      undefined,
      ifMatch(first.version),
    );
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({
      code: 'column_in_use',
      why: 'has_values',
      count: 1,
    });
  });
});

describe('type change with a preview', () => {
  it('previews the values that would not convert to a number, with the site and the reason', async () => {
    const res = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/type-preview`,
      { value_type: 'number' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ord: first.ord,
      from_type: 'text',
      to_type: 'number',
      total_values: 1,
      convertible: 0,
      not_convertible: 1,
    });
    expect(res.body.samples).toEqual([
      { site_code: siteCode, value: 'PR-001', reason: 'not_a_number' },
    ]);
    const toText = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/type-preview`,
      { value_type: 'text' },
    );
    expect(toText.body).toMatchObject({
      total_values: 1,
      convertible: 1,
      not_convertible: 0,
      samples: [],
    });
  });

  it('refuses a list without a list and an unknown list in the preview, and a protected column', async () => {
    const noList = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/type-preview`,
      { value_type: 'list' },
    );
    expect(noList.status).toBe(422);
    expect(errorsOf(noList)).toContain('list_required');
    const unknown = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/type-preview`,
      { value_type: 'list', list_catalogue: 'NoSuchList' },
    );
    expect(unknown.status).toBe(422);
    expect(errorsOf(unknown)).toContain('unknown_list');
    const protectedCol = await admin.api.call(
      'post',
      '/site360/columns/2/type-preview',
      { value_type: 'number' },
    );
    expect(protectedCol.status).toBe(409);
    expect(protectedCol.body.code).toBe('system_field');
  });

  it('answers 409 conversion_unconfirmed with the preview, then converts once confirmed: the task input follows, the value stays, the ETag moves', async () => {
    const un = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { value_type: 'number', reason: REASON },
      ifMatch(first.version),
    );
    expect(un.status).toBe(409);
    expect(un.body).toMatchObject({
      code: 'conversion_unconfirmed',
      conversion: { not_convertible: 1, total_values: 1 },
    });
    const ok = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { value_type: 'number', confirm_unconvertible: true, reason: REASON },
      ifMatch(first.version),
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      value_type: 'number',
      list_catalogue: null,
      version: 2,
    });
    expect(ok.headers.etag).toBe('"2"');
    first.version = 2;
    const tf = await q<{ field_type: string }>(
      db,
      `SELECT field_type FROM template_task_fields WHERE task_code = $1 AND field_key = $2`,
      [taskCode, first.key],
    );
    expect(tf[0]!.field_type).toBe('number');
    const stored = await q<{ v: string }>(
      db,
      `SELECT "values" ->> $1 AS v FROM task_instances WHERE site_id = (SELECT id FROM sites WHERE site_code = $2) AND "values" ? $1`,
      [first.key.slice(2), siteCode],
    );
    expect(stored[0]!.v).toBe('PR-001');
    const au = await q<{
      before: { value_type: string };
      after: { value_type: string };
    }>(
      db,
      `SELECT before, after FROM audit_log WHERE action = 'site360.column_updated' AND entity_id = 'GF' AND after ->> 'value_type' = 'number'`,
    );
    expect(au[0]!.before.value_type).toBe('text');
    expect(au[0]!.after.value_type).toBe('number');
  });

  it('answers 412 for a stale ETag and 409 invalid_transition when nothing changes', async () => {
    const stale = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { name_en: `Stale ${TAG}`, reason: REASON },
      ifMatch(1),
    );
    expect(stale.status).toBe(412);
    const same = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { value_type: 'number', reason: REASON },
      ifMatch(first.version),
    );
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('invalid_transition');
  });

  it('turns the column back to text without a prompt: every value fits', async () => {
    const res = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { value_type: 'text', reason: REASON },
      ifMatch(first.version),
    );
    expect(res.status).toBe(200);
    expect(res.body.value_type).toBe('text');
    first.version = res.body.version;
  });
});

describe('rename and the protected columns', () => {
  it('renames an added column in English and Arabic: the header follows', async () => {
    const res = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { name_en: `Studio Renamed ${TAG}`, name_ar: 'اسم جديد', reason: REASON },
      ifMatch(first.version),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name_en: `Studio Renamed ${TAG}`,
      name_ar: 'اسم جديد',
      header: `Custom / Studio Renamed ${TAG}`,
    });
    first.version = res.body.version;
  });

  it('lets a protected column be renamed but not retyped, moved or deactivated (409 system_field)', async () => {
    const before = (await admin.api.call('get', '/site360/columns/2')).body;
    const type = await admin.api.call(
      'patch',
      '/site360/columns/2',
      { value_type: 'number', reason: REASON },
      ifMatch(before.version),
    );
    expect(type.status).toBe(409);
    expect(type.body.code).toBe('system_field');
    const off = await admin.api.call(
      'post',
      '/site360/columns/2/deactivate',
      { reason: REASON },
      ifMatch(before.version),
    );
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('system_field');
    const del = await admin.api.call(
      'delete',
      `/site360/columns/2?reason=${encodeURIComponent(REASON)}`,
      undefined,
      ifMatch(before.version),
    );
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('system_field');
    const rename = await admin.api.call(
      'patch',
      '/site360/columns/2',
      { name_ar: `معرف ${TAG}`, reason: REASON },
      ifMatch(before.version),
    );
    expect(rename.status).toBe(200);
    expect(rename.body.name_ar).toBe(`معرف ${TAG}`);
    expect(rename.body.version).toBe(before.version + 1);
  });

  it('keeps the place of an original column: band, group and position cannot change', async () => {
    const col = (await admin.api.call('get', '/site360/columns/10')).body;
    const move = await admin.api.call(
      'patch',
      '/site360/columns/10',
      { after_ord: 20, reason: REASON },
      ifMatch(col.version),
    );
    expect(move.status).toBe(409);
    expect(move.body.code).toBe('system_field');
    const band = await admin.api.call(
      'patch',
      '/site360/columns/10',
      { group_top: 'Elsewhere', reason: REASON },
      ifMatch(col.version),
    );
    expect(band.status).toBe(409);
  });

  it('refuses an unknown key and an empty change with 422', async () => {
    const unknown = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { color: 'red', reason: REASON },
      ifMatch(first.version),
    );
    expect(unknown.status).toBe(422);
    const empty = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { reason: REASON },
      ifMatch(first.version),
    );
    expect(empty.status).toBe(422);
  });
});

describe('the menus of an added column', () => {
  it('changes them with PATCH /site360/columns/{ord}/sections, which now takes any order and bumps the version', async () => {
    const res = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}/sections`,
      { sections: ['cw', 'te'], reason: REASON },
    );
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual(['cw', 'te']);
    const col = (await admin.api.call('get', `/site360/columns/${first.ord}`))
      .body;
    expect(col.sections).toEqual(['cw', 'te']);
    expect(col.version).toBe(first.version + 1);
    first.version = col.version;
    const te = await admin.api.call(
      'get',
      `/site360/te/rows?site_code=${siteCode}`,
    );
    expect(te.body.menu.columns.map((c: { ord: number }) => c.ord)).toContain(
      188,
    );
  });

  it('still refuses a plain user and the status columns', async () => {
    expect(
      (
        await plain.api.call(
          'patch',
          `/site360/columns/${first.ord}/sections`,
          { sections: ['cw'], reason: REASON },
        )
      ).status,
    ).toBe(403);
    const status = await admin.api.call(
      'patch',
      '/site360/columns/187/sections',
      { sections: ['cw'], reason: REASON },
    );
    expect(status.status).toBe(422);
  });
});

describe('moving a column and a site field source', () => {
  let second = { ord: 0, version: 0 };
  let fieldId = '';

  it('adds a second column after the first with a site custom field as the source: the values of the field fill it', async () => {
    const code = `studio_${TAG}`;
    const f = await db.query(
      `INSERT INTO field_definitions (entity_type, code, label_en, data_type) VALUES ('site', $1, 'Studio field', 'text') RETURNING id`,
      [code],
    );
    fieldId = f.rows[0].id as string;
    await db.query(
      `UPDATE sites SET custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object($1::text, 'from-field') WHERE site_code = $2`,
      [code, siteCode],
    );
    const res = await admin.api.call(
      'post',
      '/site360/columns',
      body({
        name_en: `Studio Field Col ${TAG}`,
        after_ord: first.ord,
        value_type: undefined,
        source: { kind: 'site_field', field_id: fieldId },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ord: 189,
      letter: 'GG',
      display_order: 189,
      value_type: 'text',
      value_count: 1,
      delete_mode: 'deactivate',
    });
    expect(res.body.source).toMatchObject({
      kind: 'custom_field',
      site_field_id: fieldId,
      site_field_code: code,
    });
    second = { ord: res.body.ord, version: res.body.version };
    const rows = await admin.api.call(
      'get',
      `/site360/master/rows?site_code=${siteCode}`,
    );
    expect(rows.body.rows[0].values['189']).toBe('from-field');
    const dup = await admin.api.call(
      'post',
      '/site360/columns',
      body({
        name_en: `Studio Field Col 2 ${TAG}`,
        after_ord: first.ord,
        value_type: undefined,
        source: { kind: 'site_field', field_id: fieldId },
      }),
    );
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('field_already_mapped');
  });

  it('adds a column after any column inside its band: the next columns shift in display order, not in Master order', async () => {
    const res = await admin.api.call(
      'post',
      '/site360/columns',
      body({
        name_en: `Studio Between ${TAG}`,
        after_ord: first.ord,
        source: {
          kind: 'task_input',
          task_code: taskCode,
          field_key: `v:between_${TAG}`,
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ord: 190,
      letter: 'GH',
      display_order: 189,
    });
    const list = (await admin.api.call('get', '/site360/columns')).body
      .items as { ord: number; display_order: number }[];
    expect(list.slice(187).map((c) => [c.ord, c.display_order])).toEqual([
      [188, 188],
      [190, 189],
      [189, 190],
    ]);
    second = {
      ord: second.ord,
      version: (await admin.api.call('get', `/site360/columns/${second.ord}`))
        .body.version,
    };
  });

  it('moves a column after another one and refuses a move that splits a band', async () => {
    const col = (await admin.api.call('get', `/site360/columns/${first.ord}`))
      .body;
    const split = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { after_ord: 20, reason: REASON },
      ifMatch(col.version),
    );
    expect(split.status).toBe(422);
    expect(errorsOf(split)).toContain('placement_splits_band');
    const move = await admin.api.call(
      'patch',
      `/site360/columns/${first.ord}`,
      { after_ord: second.ord, reason: REASON },
      ifMatch(col.version),
    );
    expect(move.status).toBe(200);
    expect(move.body.ord).toBe(first.ord);
    const list = (await admin.api.call('get', '/site360/columns')).body
      .items as { ord: number; display_order: number }[];
    expect(list.slice(187).map((c) => c.ord)).toEqual([190, 189, 188]);
    first.version = move.body.version;
  });
});

describe('the Master-format export', () => {
  it('carries the added columns after the 187 under their letters, with the values; the original columns stay where they are', async () => {
    const start = await admin.api.call('post', '/exports/master', {
      parts: ['sites', 'tasks'],
    });
    expect(start.status).toBe(202);
    await app.get(MasterExportService).idle();
    let status = '';
    for (let i = 0; i < 100 && status !== 'done' && status !== 'failed'; i++) {
      const list = await admin.api.call('get', '/exports/master');
      status =
        (list.body.items as { id: string; status: string }[]).find(
          (x) => x.id === start.body.id,
        )?.status ?? '';
      if (status !== 'done' && status !== 'failed') await sleep(100);
    }
    expect(status).toBe('done');
    const res = await admin.api
      .call('get', `/exports/master/${start.body.id}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as unknown as ExcelJS.Buffer);
    const ws = book.getWorksheet('Master')!;
    const cell = (r: number, c: number): string | null => {
      const v = ws.getRow(r).getCell(c).value;
      return v === null || v === undefined || v === '' ? null : String(v);
    };
    // the three header rows: band, group and name of the added columns after the 187 (GE is column 187)
    expect(cell(3, 187)).not.toBeNull();
    expect(cell(1, 188)).toBe(BAND);
    expect(cell(2, 188)).toBe('Custom');
    expect(cell(3, 189)).toBe(`Studio Field Col ${TAG}`);
    expect(cell(3, 190)).toBe(`Studio Between ${TAG}`);
    let row = 0;
    ws.eachRow((r, n) => {
      if (n > 3 && String(r.getCell(2).value ?? '') === siteCode) row = n;
    });
    expect(row).toBeGreaterThan(3);
    expect(cell(row, 188)).toBe('PR-001');
    expect(cell(row, 189)).toBe('from-field');
    expect(cell(row, 190)).toBeNull();
    expect(ws.columnCount).toBe(190);
  });
});

describe('deactivate, reactivate and delete', () => {
  it('deactivates a column: it leaves the menus and the grid, its values and letter stay; again is 409 invalid_transition', async () => {
    const res = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/deactivate`,
      { reason: REASON },
      ifMatch(first.version),
    );
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
    first.version = res.body.version;
    const rows = await admin.api.call(
      'get',
      `/site360/master/rows?site_code=${siteCode}`,
    );
    expect(
      rows.body.menu.columns.map((c: { ord: number }) => c.ord),
    ).not.toContain(first.ord);
    expect(
      (
        await admin.api.call('get', '/site360/columns?include_inactive=false')
      ).body.items.map((c: { ord: number }) => c.ord),
    ).not.toContain(first.ord);
    expect(
      (await admin.api.call('get', '/site360/columns')).body.items.map(
        (c: { ord: number }) => c.ord,
      ),
    ).toContain(first.ord);
    const again = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/deactivate`,
      { reason: REASON },
      ifMatch(first.version),
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
    expect(
      (
        await q(
          db,
          `SELECT 1 FROM audit_log WHERE action = 'site360.column_deactivated' AND entity_id = 'GF'`,
        )
      ).length,
    ).toBe(1);
  });

  it('reactivates it at the same place with the same letter', async () => {
    const res = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/reactivate`,
      { reason: REASON },
      ifMatch(first.version),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ is_active: true, letter: 'GF', ord: 188 });
    first.version = res.body.version;
    const again = await admin.api.call(
      'post',
      `/site360/columns/${first.ord}/reactivate`,
      { reason: REASON },
      ifMatch(first.version),
    );
    expect(again.status).toBe(409);
  });

  it('deletes an added column that never held a value, with its task input, and refuses a stale ETag first', async () => {
    const col = (await admin.api.call('get', '/site360/columns/190')).body;
    expect(col).toMatchObject({ value_count: 0, delete_mode: 'hard' });
    const stale = await admin.api.call(
      'delete',
      `/site360/columns/190?reason=${encodeURIComponent(REASON)}`,
      undefined,
      ifMatch(col.version + 5),
    );
    expect(stale.status).toBe(412);
    const short = await admin.api.call(
      'delete',
      '/site360/columns/190?reason=ab',
      undefined,
      ifMatch(col.version),
    );
    expect(short.status).toBe(422);
    const del = await admin.api.call(
      'delete',
      `/site360/columns/190?reason=${encodeURIComponent(REASON)}`,
      undefined,
      ifMatch(col.version),
    );
    expect(del.status).toBe(200);
    expect(del.body).toEqual({
      ord: 190,
      letter: 'GH',
      deleted: true,
      removed_input: true,
    });
    expect((await admin.api.call('get', '/site360/columns/190')).status).toBe(
      404,
    );
    expect(
      (
        await q(
          db,
          `SELECT 1 FROM template_task_fields WHERE master_col = 'GH' OR field_key = $1`,
          [`v:between_${TAG}`],
        )
      ).length,
    ).toBe(0);
    const au = await q<{ before: { ord: number }; after: unknown }>(
      db,
      `SELECT before, after FROM audit_log WHERE action = 'site360.column_deleted' AND entity_id = 'GH'`,
    );
    expect(au).toHaveLength(1);
    expect(au[0]!.before.ord).toBe(190);
    expect(au[0]!.after).toBeNull();
  });

  it('never deletes an original column (409 system_field); a deleted last column frees its letter and order', async () => {
    const col = (await admin.api.call('get', '/site360/columns/150')).body;
    const del = await admin.api.call(
      'delete',
      `/site360/columns/150?reason=${encodeURIComponent(REASON)}`,
      undefined,
      ifMatch(col.version),
    );
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('system_field');
    // the letters stay: the next added column takes the free order after the highest one that exists (189 is the last now)
    const next = await admin.api.call(
      'post',
      '/site360/columns',
      body({
        name_en: `Studio Next ${TAG}`,
        after_ord: 189,
        source: {
          kind: 'task_input',
          task_code: taskCode,
          field_key: `v:next_${TAG}`,
        },
      }),
    );
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ ord: 190, letter: 'GH' });
  });

  it('checks the permission before the existence of the column', async () => {
    expect((await plain.api.call('get', '/site360/columns/999')).status).toBe(
      403,
    );
    expect((await admin.api.call('get', '/site360/columns/999')).status).toBe(
      404,
    );
  });
});
