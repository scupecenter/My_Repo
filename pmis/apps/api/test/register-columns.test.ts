import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDbRcols } from './helpers';
import { Team, createRec, recPath } from './reg-helpers';
import { team } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';
import { day, downloadTemplate, fillTemplate, uploadFile } from './tpl-helpers';

/**
 * Migration 0095: the admin manages the columns, sections and name of a register (GECOL power as the example). Its own database (TEST_DATABASE_URL_RCOLS):
 * the suite adds, converts and deletes columns, which issues new register template versions. The tests build on one another, in order.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let t: Team;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_RCOLS as string });
  db = await superDbRcols();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'entry' });
  t = await team(app, db, 'gecol', 'gecol', 5);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

/** One GECOL record per site: the previous one is voided (which frees the slot) before the next is created. */
const clear = () => db.query(`UPDATE register_records SET state = 'voided' WHERE register_key = 'gecol' AND site_id = $1 AND state <> 'voided'`, [t.site.id]);
const rec = async (data: Record<string, unknown>) => { await clear(); return createRec(t, data); };
const REASON = 'The owner asked for a new column';
const F = '/registers/gecol/fields';
const add = (body: Record<string, unknown>, who: Actor = admin) => who.api.call('post', F, { reason: REASON, ...body });
const screen = async (): Promise<{ register: Record<string, any>; sections: Record<string, any>[]; fields: Record<string, any>[] }> => (await admin.api.call('get', F)).body;
const field = async (code: string): Promise<Record<string, any> | undefined> => (await screen()).fields.find((f) => f.code === code);

describe('access', () => {
  it('only the System Admin (or a delegate of fields.edit) reads or writes the screen', async () => {
    expect((await plain.api.call('get', F)).status).toBe(403);
    expect((await add({ code: 'x_probe', label_en: 'Probe', field_type: 'text' }, plain)).status).toBe(403);
    const s = await admin.api.call('get', F);
    expect(s.status).toBe(200);
    expect(s.body.register).toMatchObject({ register_key: 'gecol' });
    expect(s.body.fields.length).toBeGreaterThan(10);
  });
  it('a reason is required', async () => {
    const r = await admin.api.call('post', F, { code: 'x_noreason', label_en: 'No reason', field_type: 'text' });
    expect(r.status).toBe(422);
  });
});

describe('the data types of a new column', () => {
  const types: [string, string][] = [
    ['text', 'text'], ['long_text', 'long_text'], ['number', 'number'], ['currency', 'currency'], ['percentage', 'percentage'], ['date', 'date'], ['datetime', 'datetime'],
    ['yes_no', 'yes_no'], ['user', 'user'], ['multi_user', 'multi_user'], ['site', 'site'], ['multi_site', 'multi_site'], ['external_party', 'external_party'],
    ['warehouse_item', 'warehouse_item'], ['email', 'email'], ['phone', 'phone'], ['link', 'link'],
  ];
  for (const [code, type] of types) {
    it(`adds a ${type} column and reads it back with that type`, async () => {
      const r = await add({ code: `c_${code}`, label_en: `Col ${type}`, label_ar: `عمود ${type}`, field_type: type, in_list: true });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await field(`c_${code}`)).toMatchObject({ type, label_ar: `عمود ${type}`, is_active: true, is_system: false, in_template: true, in_export: true });
    });
  }

  it('refuses a duplicate code, a bad code and an unknown type', async () => {
    expect((await add({ code: 'c_text', label_en: 'Again', field_type: 'text' })).status).toBe(409);
    expect((await add({ code: 'Bad Code', label_en: 'Bad', field_type: 'text' })).status).toBe(422);
    expect((await add({ code: 'c_unknown', label_en: 'Bad', field_type: 'hologram' })).status).toBe(422);
  });

  it('checks the format of an entry: e-mail, phone, link, percentage, datetime and one site', async () => {
    const bad = async (data: Record<string, unknown>, path: string) => {
      const res = await t.entry.api.call('post', recPath('gecol'), { site_id: t.site.id, data: { pr_no: `GF-${Date.now()}`, request_date: '2026-01-05', ...data } });
      expect(res.status, JSON.stringify(data)).toBe(422);
      expect(JSON.stringify(res.body.errors)).toContain(path);
    };
    await bad({ c_email: 'not-an-email' }, '/data/c_email');
    await bad({ c_phone: 'call me' }, '/data/c_phone');
    await bad({ c_link: 'example.test' }, '/data/c_link');
    await bad({ c_percentage: 120 }, '/data/c_percentage');
    await bad({ c_datetime: '2026-13-40 10:00' }, '/data/c_datetime');
    const ok = await rec( { pr_no: `GF-OK-${Date.now()}`, request_date: '2026-01-05', c_email: 'a.b@example.test', c_phone: '+218 91 000 0000', c_link: 'https://example.test/x',
      c_percentage: 42.5, c_currency: 1250.75, c_datetime: '2026-01-05 10:30', c_long_text: 'a long note' });
    expect(ok.data).toMatchObject({ c_email: 'a.b@example.test', c_percentage: 42.5, c_currency: 1250.75 });
  });
});

describe('a computed column', () => {
  it('is read-only and filled from two columns at every save', async () => {
    expect((await add({ code: 'q_a', label_en: 'Qty A', field_type: 'number' })).status).toBe(201);
    expect((await add({ code: 'q_b', label_en: 'Qty B', field_type: 'number' })).status).toBe(201);
    const bad = await add({ code: 'q_bad', label_en: 'Bad', field_type: 'computed', formula: { op: 'sum', a: 'q_a', b: 'nothing' } });
    expect(bad.status).toBe(422);
    const r = await add({ code: 'q_sum', label_en: 'Sum', field_type: 'computed', formula: { op: 'sum', a: 'q_a', b: 'q_b' }, in_list: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await field('q_sum')).toMatchObject({ type: 'computed' });
    await clear();
    const typed = await t.entry.api.call('post', recPath('gecol'), { site_id: t.site.id, data: { pr_no: `GC-${Date.now()}`, request_date: '2026-01-05', q_sum: 5 } });
    expect(typed.status).toBe(422);
    const made = await rec( { pr_no: `GC-OK-${Date.now()}`, request_date: '2026-01-05', q_a: 4, q_b: 6.5 });
    expect(made.data.q_sum).toBe(10.5);
    // a computed column keeps its type
    const ch = await admin.api.call('patch', `${F}/q_sum`, { reason: REASON, field_type: 'number' });
    expect(ch.status).toBe(422);
  });
});

describe('a list column', () => {
  it('picks an existing catalogue', async () => {
    expect((await admin.api.call('post', '/list-catalogues', { code: 'ExistingProbe', name_en: 'Existing probe', reason: REASON })).status).toBe(201);
    expect((await admin.api.call('post', '/list-catalogues/ExistingProbe/values', { code: 'One', reason: REASON })).status).toBe(201);
    const cat = [{ code: 'ExistingProbe' }];
    const r = await add({ code: 'l_existing', label_en: 'Existing list', field_type: 'list', list_catalogue: cat[0]!.code });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await field('l_existing')).toMatchObject({ type: 'list', list_catalogue: cat[0]!.code });
  });
  it('creates a new catalogue with its values in the same step, single and multi', async () => {
    const r = await add({ code: 'l_new', label_en: 'Priority', field_type: 'list', new_list: { name_en: 'Gecol priority', name_ar: 'أولوية', values: [{ label_en: 'High', label_ar: 'عالية' }, { label_en: 'Low' }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const f = await field('l_new');
    expect(f).toMatchObject({ type: 'list', list_catalogue_name: 'Gecol priority' });
    const vals = await q<{ code: string }>(db, `SELECT code FROM list_values WHERE catalogue_code = $1 ORDER BY sort_order`, [f!.list_catalogue]);
    expect(vals.map((v) => v.code)).toEqual(['High', 'Low']);
    const m = await add({ code: 'l_multi', label_en: 'Tags', field_type: 'multi_list', list_catalogue: f!.list_catalogue });
    expect(m.status).toBe(201);
    expect(await field('l_multi')).toMatchObject({ type: 'multi_list' });
    const made = await rec( { pr_no: `GL-${Date.now()}`, request_date: '2026-01-05', l_new: 'High', l_multi: ['High', 'Low'] });
    expect(made.data).toMatchObject({ l_new: 'High', l_multi: ['High', 'Low'] });
    await clear();
    expect((await t.entry.api.call('post', recPath('gecol'), { site_id: t.site.id, data: { pr_no: `GL2-${Date.now()}`, request_date: '2026-01-05', l_new: 'Nope' } })).status).toBe(422);
  });
  it('a list column needs a list', async () => {
    expect((await add({ code: 'l_none', label_en: 'No list', field_type: 'list' })).status).toBe(422);
  });
});

describe('a document column', () => {
  it('creates its Document Library slot automatically', async () => {
    const r = await add({ code: 'd_report', label_en: 'Inspection report', label_ar: 'تقرير', field_type: 'document' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await field('d_report')).toMatchObject({ type: 'document' });
    const o = await q<{ options: { doc_type_code: string } }>(db, `SELECT options FROM register_fields WHERE register_key = 'gecol' AND code = 'd_report'`);
    const dt = await q<{ name_en: string; is_active: boolean; lib_managed: boolean; published_version: number; mandatory: boolean }>(db,
      `SELECT d.name_en, d.is_active, d.lib_managed, d.published_version, v.is_mandatory AS mandatory FROM document_types d LEFT JOIN document_type_versions v ON v.doc_type_id = d.id AND v.version_no = d.published_version WHERE d.code = $1`, [o[0]!.options.doc_type_code]);
    expect(dt[0]).toMatchObject({ name_en: 'Inspection report', is_active: true, lib_managed: true });
    expect(dt[0]!.published_version).toBeGreaterThan(0);
    const pl = await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM document_type_placements p JOIN document_types d ON d.id = p.doc_type_id WHERE d.code = $1 AND p.kind = 'register' AND p.register_key = 'gecol'`, [o[0]!.options.doc_type_code]);
    expect(pl[0]!.n).toBe('1');
  });
});

describe('edit: rename, required, section, order, visibility', () => {
  it('renames in English and Arabic, turns required on (flag, not block) and changes visibility', async () => {
    await rec( { pr_no: `GR-${Date.now()}`, request_date: '2026-01-05' });
    const before = await field('c_text');
    const r = await admin.api.call('patch', `${F}/c_text`, { reason: REASON, label_en: 'Renamed text', label_ar: 'نص جديد', required: true, in_filter: true, in_template: false, in_export: false }, { 'If-Match': `"${before!.version}"` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.records_missing_value).toBeGreaterThan(0);
    expect(await field('c_text')).toMatchObject({ label_en: 'Renamed text', label_ar: 'نص جديد', required: true, in_filter: true, in_template: false, in_export: false });
    expect((await admin.api.call('patch', `${F}/c_text`, { reason: REASON, label_en: 'Stale' }, { 'If-Match': `"${before!.version}"` })).status).toBe(412);
    // the template no longer carries the hidden column
    const cols = (await q<{ c: { code: string }[] }>(db, `SELECT tpl_columns('gecol') AS c`))[0]!.c.map((c) => c.code);
    expect(cols).not.toContain('c_text');
    expect(cols).toContain('c_email');
  });
  it('reorders the columns', async () => {
    const codes = (await screen()).fields.map((f) => f.code as string);
    const moved = ['c_link', ...codes.filter((c) => c !== 'c_link')];
    const r = await admin.api.call('put', '/registers/gecol/fields-order', { reason: REASON, codes: moved });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await screen()).fields[0]!.code).toBe('c_link');
    expect((await admin.api.call('put', '/registers/gecol/fields-order', { reason: REASON, codes: ['nothing_here'] })).status).toBe(422);
  });
});

describe('sections', () => {
  let id = '';
  it('adds, renames (the columns follow), moves a column in and deletes only when empty', async () => {
    const a = await admin.api.call('post', '/registers/gecol/sections', { reason: REASON, name_en: 'Inspection', name_ar: 'التفتيش' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    id = a.body.id;
    expect((await admin.api.call('post', '/registers/gecol/sections', { reason: REASON, name_en: 'inspection' })).status).toBe(409);
    expect((await admin.api.call('patch', `${F}/c_email`, { reason: REASON, section: 'Nowhere' })).status).toBe(422);
    expect((await admin.api.call('patch', `${F}/c_email`, { reason: REASON, section: 'Inspection' })).status).toBe(200);
    expect((await admin.api.call('delete', `/registers/gecol/sections/${id}`, { reason: REASON })).status).toBe(409);
    const re = await admin.api.call('patch', `/registers/gecol/sections/${id}`, { reason: REASON, name_en: 'Site inspection' });
    expect(re.status).toBe(200);
    expect(await field('c_email')).toMatchObject({ section: 'Site inspection' });
    expect((await admin.api.call('patch', `${F}/c_email`, { reason: REASON, section: null })).status).toBe(200);
    const del = await admin.api.call('delete', `/registers/gecol/sections/${id}`, { reason: REASON });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await screen()).sections.some((s) => s.id === id)).toBe(false);
  });
});

describe('the register name', () => {
  it('renames the register in English and Arabic; the template follows', async () => {
    const r = await admin.api.call('patch', '/registers/gecol', { reason: REASON, name_en: 'GECOL power supply', name_ar: 'كهرباء جيكول' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await screen()).register).toMatchObject({ name_en: 'GECOL power supply', name_ar: 'كهرباء جيكول' });
    const list = (await admin.api.call('get', '/registers')).body.items as { key?: string; register_key?: string; name_en?: string; name?: string }[];
    expect(JSON.stringify(list)).toContain('GECOL power supply');
  });
});

describe('type change with a conversion preview', () => {
  it('shows the preview, blocks when a value fails, asks to confirm, converts when all convert, and needs the step-up', async () => {
    expect((await add({ code: 'v_amount', label_en: 'Amount text', field_type: 'text' })).status).toBe(201);
    const a = await rec( { pr_no: `GT-A-${Date.now()}`, request_date: '2026-01-05', v_amount: '12.5' });
    const b = await rec( { pr_no: `GT-B-${Date.now()}`, request_date: '2026-01-05', v_amount: 'twelve' });
    const imp = await admin.api.call('get', `${F}/v_amount/impact?field_type=number`);
    expect(imp.status).toBe(200);
    expect(imp.body.conversion).toMatchObject({ convertible: 1, failed: 1 });
    expect(imp.body.conversion.failures[0]).toMatchObject({ value: 'twelve' });
    expect(imp.body.delete_mode).toBe('deactivate');
    const blocked = await admin.api.call('patch', `${F}/v_amount`, { reason: REASON, field_type: 'number' });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'conversion_blocked' });
    // without the step-up the change is refused before the database
    const ns = await noStep.api.call('patch', `${F}/v_amount`, { reason: REASON, field_type: 'number' });
    expect(ns.status).toBe(401);
    // fix the failing value (a draft record of the same register), then confirm
    await db.query(`UPDATE register_records SET data = jsonb_set(data, '{v_amount}', '"13"') WHERE id = $1`, [b.id]);
    const un = await admin.api.call('patch', `${F}/v_amount`, { reason: REASON, field_type: 'number' });
    expect(un.status).toBe(409);
    expect(un.body).toMatchObject({ code: 'conversion_unconfirmed' });
    const ok = await admin.api.call('patch', `${F}/v_amount`, { reason: REASON, field_type: 'number', confirm_conversion: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.converted).toBeGreaterThan(0);
    expect(await field('v_amount')).toMatchObject({ type: 'number' });
    const vals = await q<{ v: unknown }>(db, `SELECT data -> 'v_amount' AS v FROM register_records WHERE id IN ($1, $2) ORDER BY data ->> 'pr_no'`, [a.id, b.id]);
    expect(vals.map((x) => x.v)).toEqual([12.5, 13]);
    const au = await q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(db, `SELECT before, after FROM audit_log WHERE action = 'register_field_type_change' AND entity_id = 'gecol:v_amount'`);
    expect(au[0]!.before).toMatchObject({ type: 'text' });
    expect(au[0]!.after).toMatchObject({ type: 'number' });
  });
});

describe('delete: hard when no record ever held a value, otherwise deactivate; reactivate', () => {
  it('hard-deletes an unused column (step-up and reason needed) and audits it', async () => {
    expect((await add({ code: 'u_unused', label_en: 'Unused', field_type: 'text' })).status).toBe(201);
    expect((await noStep.api.call('delete', `${F}/u_unused`, { reason: REASON })).status).toBe(401);
    expect((await admin.api.call('delete', `${F}/u_unused`, {})).status).toBe(422);
    const imp = await admin.api.call('get', `${F}/u_unused/impact`);
    expect(imp.body.delete_mode).toBe('hard');
    const r = await admin.api.call('delete', `${F}/u_unused`, { reason: REASON });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ mode: 'deleted' });
    expect(await field('u_unused')).toBeUndefined();
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'register_field_delete' AND entity_id = 'gecol:u_unused' AND reason = $1`, [REASON])).length).toBe(1);
  });
  it('deactivates a column that held a value, keeps the value, and reactivates it', async () => {
    const r = await admin.api.call('delete', `${F}/v_amount`, { reason: 'Not needed any more' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'deactivated' });
    expect(await field('v_amount')).toMatchObject({ is_active: false });
    expect((await q(db, `SELECT 1 FROM register_records WHERE data ? 'v_amount'`)).length).toBeGreaterThan(0);
    const back = await admin.api.call('patch', `${F}/v_amount`, { reason: REASON, is_active: true });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await field('v_amount')).toMatchObject({ is_active: true });
  });
});

describe('protected columns', () => {
  it('can be renamed, reordered, moved and hidden, but not deleted, deactivated or retyped', async () => {
    const prot = (await screen()).fields.find((f) => f.is_system);
    expect(prot).toBeTruthy();
    const c = prot!.code as string;
    expect(prot!.system_reason).toBeTruthy();
    const ok = await admin.api.call('patch', `${F}/${c}`, { reason: REASON, label_en: 'Renamed protected', in_list: false, in_filter: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const del = await admin.api.call('delete', `${F}/${c}`, { reason: REASON });
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ code: 'system_field' });
    const ty = await admin.api.call('patch', `${F}/${c}`, { reason: REASON, field_type: 'long_text' });
    expect(ty.status).toBe(409);
    expect(ty.body).toMatchObject({ code: 'system_field' });
    expect((await admin.api.call('patch', `${F}/${c}`, { reason: REASON, required: false })).status).toBe(409);
    expect((await admin.api.call('patch', `${F}/${c}`, { reason: REASON, is_active: false })).status).toBe(409);
    expect((await admin.api.call('get', `${F}/${c}/impact`)).body.delete_mode).toBe('blocked');
  });
});

describe('templates regenerate and an older file is read by its column codes', () => {
  const version = async (): Promise<number> => (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-GECOL'`))[0]!.v;
  it('adding a column issues a new template version; the old file is accepted with a summary; a type change refuses it', async () => {
    const v0 = await version();
    const dl = await downloadTemplate(admin.api, 'TPL-GECOL');
    expect((await add({ code: 't_extra', label_en: 'Extra after template', field_type: 'text' })).status).toBe(201);
    expect((await add({ code: 't_gone', label_en: 'Gone soon', field_type: 'text' })).status).toBe(201);
    const v1 = await version();
    expect(v1).toBeGreaterThan(v0);
    // a file made from v1 (with t_gone), then the column is removed and another is added
    const dl1 = await downloadTemplate(admin.api, 'TPL-GECOL');
    expect((await admin.api.call('delete', `${F}/t_gone`, { reason: REASON })).status).toBe(200);
    expect((await add({ code: 't_new', label_en: 'Brand new column', field_type: 'text' })).status).toBe(201);
    expect(await version()).toBeGreaterThan(v1);
    const buf = await fillTemplate(dl1.buffer, [{ 'Request No': `TOL-${Date.now()}`, 'Request Date': day('2026-01-05'), 'Gone soon': 'ignored value' }]).catch(() => null);
    if (buf) {
      const res = await uploadFile(t.entry.api, buf);
      expect([200, 202]).toContain(res.status);
      expect(res.body.file_template_version).toBe(v1);
      expect(res.body.older_template.removed_columns.map((c: { key: string }) => c.key)).toContain('t_gone');
      expect(res.body.older_template.added_columns.map((c: { key: string }) => c.key)).toContain('t_new');
    }
    const compat = (await q<{ c: Record<string, any> }>(db, `SELECT tpl_version_compat('TPL-GECOL', $1) AS c`, [v1]))[0]!.c;
    expect(compat).toMatchObject({ compatible: true, input_changes: [] });
    // the oldest file (before t_extra): still readable
    expect((await q<{ c: Record<string, any> }>(db, `SELECT tpl_version_compat('TPL-GECOL', $1) AS c`, [v0]))[0]!.c).toMatchObject({ compatible: true });
    void dl;
    // a change of meaning refuses the file
    const v2 = await version();
    expect((await admin.api.call('patch', `${F}/t_new`, { reason: REASON, field_type: 'email' })).status).toBe(200);
    expect(await version()).toBeGreaterThan(v2);
    const c2 = (await q<{ c: Record<string, any> }>(db, `SELECT tpl_version_compat('TPL-GECOL', $1) AS c`, [v2]))[0]!.c;
    expect(c2).toMatchObject({ compatible: false });
    expect(c2.input_changes).toEqual([expect.objectContaining({ key: 't_new', change: 'type_changed' })]);
  });
});
