import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { downloadTemplate, load } from './tpl-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** Contract 0.15.626 (migration 0746, Companies K4): the onboarding checklist, the bulk status change and the three company templates. Every test makes its own companies. */
type J = Record<string, any>;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
beforeAll(async () => { app = await startApp(); db = await superDb(); admin = await plainAdmin(app, db); });
afterAll(async () => { await db.end(); });

let seq = 0;
const party = async (type = 'cw_contractor') => {
  const name = `K4 Co ${Date.now()}${Math.floor(Math.random() * 1e6)}${seq++}`;
  const id = (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, $2::"ExternalPartyType", true) RETURNING id`, [name, type])).rows[0].id as string;
  return { id, name };
};
/** Make one checklist item apply to a company type for the length of a test; the setting goes back afterwards. */
async function withItem<T>(code: string, fn: () => Promise<T>): Promise<T> {
  const before = (await db.query(`SELECT required_for, is_active FROM company_onboarding_items WHERE code = $1`, [code])).rows[0];
  await db.query(`UPDATE company_onboarding_items SET required_for = ARRAY['cw_contractor'], is_active = true WHERE code = $1`, [code]);
  try { return await fn(); } finally { await db.query(`UPDATE company_onboarding_items SET required_for = $2, is_active = $3 WHERE code = $1`, [code, before.required_for, before.is_active]); }
}
const edit = async (buf: Buffer, rows: string[][]): Promise<Buffer> => {
  const wb = await load(buf);
  const data = wb.getWorksheet('Data')!;
  rows.forEach((r, i) => r.forEach((v, c) => { data.getRow(i + 2).getCell(c + 1).value = v; }));
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const upload = (a: Actor, file: Buffer) => a.api.call('post', '/companies/import').attach('file', file, 'companies.xlsx');

describe('onboarding checklist', () => {
  it('seeded items apply to nobody until Settings picks the types; status, approver and audit', async () => {
    const c = await party();
    expect((await admin.api.call('get', `/companies/${c.id}/onboarding`)).body.items).toEqual([]);
    await withItem('safety_induction', async () => {
      const list = (await admin.api.call('get', `/companies/${c.id}/onboarding`)).body.items as J[];
      expect(list.map((i) => i.code)).toEqual(['safety_induction']);
      expect(list[0]!.status).toBe('not_started');
      expect((await admin.api.call('put', `/companies/${c.id}/onboarding/safety_induction`, { status: 'bogus' })).status).toBe(422);
      const a = await admin.api.call('put', `/companies/${c.id}/onboarding/safety_induction`, { status: 'approved', note: 'Done on site' });
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ status: 'approved', changed: true });
      const row = ((await admin.api.call('get', `/companies/${c.id}/onboarding`)).body.items as J[])[0];
      expect(row).toMatchObject({ status: 'approved', approver_id: admin.user.id, note: 'Done on site' });
      expect((await admin.api.call('put', `/companies/${c.id}/onboarding/safety_induction`, { status: 'approved' })).body.changed).toBe(false);
      const back = await admin.api.call('put', `/companies/${c.id}/onboarding/safety_induction`, { status: 'in_progress' });
      expect(back.body.status).toBe('in_progress');
      expect(((await admin.api.call('get', `/companies/${c.id}/onboarding`)).body.items as J[])[0]!.approver_id).toBeNull();
      const au = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'company_onboarding_set' AND entity_id = $1`, [`${c.id}/safety_induction`]);
      expect(au.rows[0].n).toBe(2);
      // an item that does not apply to the type is refused
      const other = await party('te_vendor');
      expect((await admin.api.call('put', `/companies/${other.id}/onboarding/safety_induction`, { status: 'approved' })).status).toBe(422);
    });
  });

  it('a user without a Contractors or Procurement right is refused', async () => {
    const c = await party();
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await a.api.call('get', `/companies/${c.id}/onboarding`)).status).toBe(403);
    expect((await a.api.call('put', `/companies/${c.id}/onboarding/insurance`, { status: 'approved' })).status).toBe(403);
    expect((await a.api.call('post', '/companies/onboarding-bulk', { party_ids: [c.id], item: 'insurance', status: 'approved' })).status).toBe(403);
  });

  it('the bulk change is all or nothing and reports the refused company', async () => {
    const a = await party();
    const b = await party();
    const wrong = await party('te_vendor');
    await withItem('insurance', async () => {
      const bad = await admin.api.call('post', '/companies/onboarding-bulk', { party_ids: [a.id, wrong.id, b.id], item: 'insurance', status: 'approved' });
      expect(bad.status).toBe(422);
      expect(JSON.stringify(bad.body.errors)).toContain('/parties/2');
      expect((await db.query(`SELECT count(*)::int AS n FROM company_onboarding WHERE party_id = ANY($1::uuid[])`, [[a.id, b.id, wrong.id]])).rows[0].n).toBe(0);
      const ok = await admin.api.call('post', '/companies/onboarding-bulk', { party_ids: [a.id, b.id], item: 'insurance', status: 'in_progress' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ companies: 2, changed: 2, unchanged: 0 });
      const ov = (await admin.api.call('get', '/companies/onboarding')).body.items as J[];
      expect(ov.find((o) => o.party_id === a.id)).toMatchObject({ total: 1, in_progress: 1, status: 'in_progress' });
    });
  });
});

describe('company templates', () => {
  it('are in the catalogue and download blank or filled with the companies picked', async () => {
    const c = await party();
    await admin.api.call('post', `/companies/${c.id}/contacts`, { name: 'Sara', phone: '0912345678' });
    const cat = (await admin.api.call('get', '/templates')).body.items as J[];
    for (const id of ['TPL-COMPANY-CONTACTS', 'TPL-COMPANY-DOCUMENTS', 'TPL-COMPANY-ONBOARDING']) expect(cat.find((t) => t.template_id === id)).toMatchObject({ current_version: 1 });
    const blank = await downloadTemplate(admin.api, 'TPL-COMPANY-CONTACTS');
    expect(blank.status).toBe(200);
    const filled = await downloadTemplate(admin.api, 'TPL-COMPANY-CONTACTS', `?party_ids=${c.id}`);
    const ws = (await load(filled.buffer)).getWorksheet('Data')!;
    expect(ws.getRow(2).getCell(1).text).toBe(c.name);
    expect(ws.getRow(2).getCell(2).text).toBe('Sara');
    expect((await downloadTemplate(admin.api, 'TPL-COMPANY-CONTACTS', '?party_ids=not-a-uuid')).status).toBe(422);
    const plain = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await downloadTemplate(plain.api, 'TPL-COMPANY-CONTACTS')).status).toBe(403);
  });

  it('contacts: a file adds and updates, a blank cell changes nothing, a bad row refuses the whole file', async () => {
    const c = await party();
    const base = (await downloadTemplate(admin.api, 'TPL-COMPANY-CONTACTS')).buffer;
    const first = await upload(admin, await edit(base, [[c.name, 'Sara', 'Site manager', '0912345678', 'sara@example.com', 'yes', ''], [c.name, 'Omar', '', '', '', '', '']]));
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ added: 2, updated: 0, unchanged: 0, status: 'applied', template_id: 'TPL-COMPANY-CONTACTS' });
    const list = (await admin.api.call('get', `/companies/${c.id}/contacts`)).body.items as J[];
    expect(list.find((x) => x.name === 'Sara')).toMatchObject({ role: 'Site manager', is_primary: true });
    const again = await upload(admin, await edit(base, [[c.name, 'sara', '', '0912345678', '', '', ''], [c.name, 'Omar', 'Driver', '', '', '', '']]));
    expect(again.body).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(((await admin.api.call('get', `/companies/${c.id}/contacts`)).body.items as J[]).find((x) => x.name === 'Omar')).toMatchObject({ role: 'Driver' });
    const bad = await upload(admin, await edit(base, [[c.name, 'Lina', '', '', '', '', ''], [c.name, 'Zed', '', '', 'not-an-email', '', ''], ['No such company', 'Q', '', '', '', '', '']]));
    expect(bad.status).toBe(422);
    const paths = (bad.body.errors as J[]).map((e) => e.path);
    expect(paths).toContain('/rows/3/email');
    expect(paths).toContain('/rows/4/company');
    expect(((await admin.api.call('get', `/companies/${c.id}/contacts`)).body.items as J[]).find((x) => x.name === 'Lina')).toBeUndefined();
  });

  it('documents: matched by type and number; an unknown type or a bad date is refused per row', async () => {
    const c = await party();
    const base = (await downloadTemplate(admin.api, 'TPL-COMPANY-DOCUMENTS')).buffer;
    const r1 = await upload(admin, await edit(base, [[c.name, 'Insurance', 'Policy', 'P-1', '2026-01-01', '2027-01-01', '', '']]));
    expect(r1.body).toMatchObject({ added: 1 });
    const r2 = await upload(admin, await edit(base, [[c.name, 'insurance', '', 'P-1', '', '2028-01-01', 'renewed', '']]));
    expect(r2.body).toMatchObject({ added: 0, updated: 1 });
    const docs = (await admin.api.call('get', `/companies/${c.id}/documents`)).body.items as J[];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ expires_on: '2028-01-01', notes: 'renewed', doc_number: 'P-1' });
    const bad = await upload(admin, await edit(base, [[c.name, 'Nonsense type', '', '', '', '', '', ''], [c.name, 'Tax certificate', '', '', '01/02/2027', '', '', '']]));
    expect(bad.status).toBe(422);
    expect((bad.body.errors as J[]).map((e) => e.path)).toEqual(expect.arrayContaining(['/rows/2/type', '/rows/3/issued_on']));
  });

  it('onboarding: status words are read, the filled copy round-trips, other templates and old versions are refused', async () => {
    const c = await party();
    await withItem('reference_check', async () => {
      const filled = (await downloadTemplate(admin.api, 'TPL-COMPANY-ONBOARDING', `?party_ids=${c.id}`)).buffer;
      const ws = (await load(filled)).getWorksheet('Data')!;
      expect(ws.getRow(2).getCell(2).text).toBe('Reference check');
      expect(ws.getRow(2).getCell(3).text).toBe('Not started');
      const up = await upload(admin, await edit(filled, [[c.name, 'Reference check', 'In progress', 'Called two referees']]));
      expect(up.body).toMatchObject({ updated: 1, template_id: 'TPL-COMPANY-ONBOARDING' });
      expect(((await admin.api.call('get', `/companies/${c.id}/onboarding`)).body.items as J[])[0]).toMatchObject({ status: 'in_progress', note: 'Called two referees' });
      expect((await upload(admin, await edit(filled, [[c.name, 'Reference check', 'Done', '']]))).status).toBe(422);
      const holidays = (await downloadTemplate(admin.api, 'TPL-HOLIDAYS')).buffer;
      const wrong = await upload(admin, holidays);
      expect(wrong.status).toBe(422);
      const wb = await load(filled);
      const tpl = wb.getWorksheet('_tpl') as ExcelJS.Worksheet;
      tpl.eachRow((row) => { if (row.getCell(1).text === 'version') row.getCell(2).value = '0'; });
      const old = await upload(admin, Buffer.from(await wb.xlsx.writeBuffer()));
      expect(old.status).toBe(422);
    });
  });
});
