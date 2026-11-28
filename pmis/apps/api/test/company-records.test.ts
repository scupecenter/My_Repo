import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.625 (migration 0745, Companies K3): company contacts, documents with expiry, compliance, document types. Every test makes its own company. */
let app: NestExpressApplication;
let db: PgClient;
beforeAll(async () => { app = await startApp(); db = await superDb(); });
afterAll(async () => { await db.end(); });

const party = async (type = 'cw_contractor') => (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, $2::"ExternalPartyType", true) RETURNING id`, [`K3 ${Date.now()}${Math.random()}`, type])).rows[0].id as string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('company contacts', () => {
  it('one primary at a time, hide not delete, If-Match, audit', async () => {
    const id = await party();
    const api = await loggedIn(app, await makeAdmin(db));
    const a = await api.call('post', `/companies/${id}/contacts`, { name: 'Sara', is_primary: true });
    expect(a.status).toBe(201);
    const b = await api.call('post', `/companies/${id}/contacts`, { name: 'Omar', email: 'omar@example.com', is_primary: true });
    expect(b.status).toBe(201);
    const list = (await api.call('get', `/companies/${id}/contacts`)).body.items as { name: string; is_primary: boolean }[];
    expect(list.filter((c) => c.is_primary).map((c) => c.name)).toEqual(['Omar']);
    expect((await api.call('patch', `/companies/${id}/contacts/${a.body.id}`, { is_active: false })).status).toBe(428);
    expect((await api.call('patch', `/companies/${id}/contacts/${a.body.id}`, { is_active: false }, { 'If-Match': '"99"' })).status).toBe(412);
    const h = await api.call('patch', `/companies/${id}/contacts/${a.body.id}`, { is_active: false }, { 'If-Match': `"${a.body.version}"` });
    expect(h.status).toBe(200);
    expect(h.body.is_active).toBe(false);
    expect((await api.call('get', `/companies/${id}/contacts`)).body.items).toHaveLength(2);
    expect((await api.call('post', `/companies/${id}/contacts`, { name: 'X', email: 'not-an-email' })).status).toBe(422);
    const au = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'company_contact_save' AND entity_id = $1`, [a.body.id]);
    expect(au.rows[0].n).toBe(2);
  });

  it('a user without a Contractors or Procurement right is refused', async () => {
    const id = await party();
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await a.api.call('get', `/companies/${id}/contacts`)).status).toBe(403);
    expect((await a.api.call('post', `/companies/${id}/contacts`, { name: 'Sara' })).status).toBe(403);
  });
});

describe('company documents and compliance', () => {
  it('judges expired, expiring and valid by the lead days of the type, and a hidden document drops out', async () => {
    const id = await party();
    const api = await loggedIn(app, await makeAdmin(db));
    const exp = await api.call('post', `/companies/${id}/documents`, { type_code: 'insurance', expires_on: day(-3) });
    expect(exp.status).toBe(201);
    expect(exp.body.status).toBe('expired');
    expect((await api.call('post', `/companies/${id}/documents`, { type_code: 'tax', expires_on: day(5) })).body.status).toBe('expiring');
    expect((await api.call('post', `/companies/${id}/documents`, { type_code: 'iso', expires_on: day(300) })).body.status).toBe('valid');
    const c = (await api.call('get', `/companies/${id}/compliance`)).body;
    expect(c).toMatchObject({ status: 'expired', expired: 1, expiring: 1, valid: 1 });
    const hide = await api.call('patch', `/companies/${id}/documents/${exp.body.id}`, { is_active: false }, { 'If-Match': `"${exp.body.version}"` });
    expect(hide.status).toBe(200);
    expect((await api.call('get', `/companies/${id}/compliance`)).body.status).toBe('expiring');
    expect((await api.call('get', `/companies/${id}/documents`)).body.items).toHaveLength(3);
  });

  it('refuses an unknown type and an expiry before the issue date', async () => {
    const id = await party();
    const api = await loggedIn(app, await makeAdmin(db));
    const r1 = await api.call('post', `/companies/${id}/documents`, { type_code: 'nope' });
    expect(r1.status).toBe(422);
    const r2 = await api.call('post', `/companies/${id}/documents`, { type_code: 'tax', issued_on: day(0), expires_on: day(-10) });
    expect(r2.status).toBe(422);
  });

  it('the daily alert writes once per document and stage, and a second run adds nothing', async () => {
    const id = await party();
    const api = await loggedIn(app, await makeAdmin(db));
    const d = await api.call('post', `/companies/${id}/documents`, { type_code: 'safety', expires_on: day(-1) });
    expect(d.status).toBe(201);
    await db.query(`SELECT set_config('app.region_ids', '*', false)`);
    await db.query(`SELECT company_documents_daily_alerts()`);
    const first = await db.query(`SELECT count(*)::int AS n FROM contractor_alerts_sent WHERE kind = 'company_doc_expired' AND ref_id = $1`, [d.body.id]);
    expect(first.rows[0].n).toBe(1);
    const second = await db.query(`SELECT company_documents_daily_alerts() AS n`);
    const again = await db.query(`SELECT count(*)::int AS n FROM contractor_alerts_sent WHERE kind = 'company_doc_expired' AND ref_id = $1`, [d.body.id]);
    expect(again.rows[0].n).toBe(1);
    expect(typeof second.rows[0].n).toBe('number');
  });
});

describe('company document types', () => {
  it('an admin sets a type required for a company type with a reason; a stale version is refused; nothing is deleted', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const g = await api.call('get', '/settings/company-document-types');
    expect(g.status).toBe(200);
    expect(g.body.types.length).toBeGreaterThanOrEqual(7);
    const code = `t${Date.now() % 1e9}`;
    const bad = await api.call('put', '/settings/company-document-types', { reason: 'add a type', types: [{ code, label_en: 'Extra', required_for: ['nope'] }] }, { 'If-Match': `"${g.body.version}"` });
    expect(bad.status).toBe(422);
    const ok = await api.call('put', '/settings/company-document-types', { reason: 'add a type', types: [{ code, label_en: 'Extra', label_ar: 'إضافي', required_for: ['te_vendor'], lead_days: 10 }] }, { 'If-Match': `"${g.body.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.types.find((t: { code: string }) => t.code === code)).toMatchObject({ required_for: ['te_vendor'], lead_days: 10, is_active: true });
    expect(ok.body.types.length).toBe(g.body.types.length + 1);
    const stale = await api.call('put', '/settings/company-document-types', { reason: 'again', types: [{ code, label_en: 'Extra', is_active: false }] }, { 'If-Match': `"${g.body.version}"` });
    expect(stale.status).toBe(412);
    const hide = await api.call('put', '/settings/company-document-types', { reason: 'hide it', types: [{ code, label_en: 'Extra', is_active: false }] }, { 'If-Match': `"${ok.body.version}"` });
    expect(hide.body.types.find((t: { code: string }) => t.code === code).is_active).toBe(false);
    await db.query(`UPDATE company_document_types SET is_active = false WHERE code = $1`, [code]);
  });
});
