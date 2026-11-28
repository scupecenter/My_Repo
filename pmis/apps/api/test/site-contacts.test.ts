import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { G, Team, createRec, recPath, team } from './reg-helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.373 (migration 0551): the Site Contacts register (C6). */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;
let partyId: string;
const TAG = `sc${Date.now().toString(36)}`;

const OK = { contact_name: 'Test Landlord', contact_role: 'Landlord', phone: '+218 91 123 4567', email: 'landlord@example.test' };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, 'site_contacts', 'site_contacts', 5);
  partyId = (await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'cw_contractor') RETURNING id`, [`Contacts Co ${TAG}`])).rows[0].id;
});
afterAll(async () => {
  await db.end();
});

describe('site contacts register', () => {
  it('is listed with two levels, its role list, the template and the links declaration', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const res = await api.call('get', '/registers');
    expect(res.status).toBe(200);
    const def = (res.body.items as { register_key: string; approval_levels: number; site_scoped: boolean; fields: { code: string }[] }[]).find((r) => r.register_key === 'site_contacts');
    expect(def?.approval_levels).toBe(2);
    expect(def?.site_scoped).toBe(true);
    expect(def?.fields.map((f) => f.code)).toEqual(expect.arrayContaining(['contact_name', 'contact_role', 'party_id', 'organization', 'phone', 'email', 'also_site_ids', 'acquisition_record_id', 'permit_record_id', 'gecol_record_id', 'hlc_record_id']));
    const lists = await db.query(`SELECT count(*)::int AS n FROM list_values WHERE catalogue_code = 'ContactRole'`);
    expect(lists.rows[0].n).toBe(8);
    const tpl = await db.query(`SELECT 1 FROM template_definitions WHERE template_id = 'TPL-SITE-CONTACTS' AND register_key = 'site_contacts'`);
    expect(tpl.rowCount).toBe(1);
    const part = await db.query(`SELECT 1 FROM data_reset_parts() p WHERE p.code = 'site_contacts'`);
    expect(part.rowCount).toBe(1);
  });

  it('seeds no matrix holder (assignment stays with the matrix)', async () => {
    const holders = await db.query(`SELECT count(*)::int AS n FROM matrix_cells WHERE register_key = 'site_contacts' AND region_id IS NULL`);
    expect(holders.rows[0].n).toBe(0);
  });

  it('fills the organization from the company, stores the e-mail in lower case, and refuses bad values on entry', async () => {
    const rec = await createRec(t, { ...OK, email: ' Landlord@Example.TEST ', party_id: partyId });
    expect(rec.data.organization).toBe(`Contacts Co ${TAG}`);
    expect(rec.data.email).toBe('landlord@example.test');
    const bad = async (data: Record<string, unknown>) => (await t.entry.api.call('post', recPath(t.key), { site_id: t.site.id, data: { ...OK, ...data } })).status;
    expect(await bad({ email: 'not-an-address' })).toBe(422);
    expect(await bad({ phone: 'call me' })).toBe(422);
    expect(await bad({ party_id: '00000000-0000-4000-8000-000000000000' })).toBe(422);
    expect(await bad({ permit_record_id: 'abc' })).toBe(422);
  });

  it('refuses a caller without the site_contacts module grant', async () => {
    const a = await actor(app, db, { grants: G('sites', 'view'), regions: [5], modules: null });
    expect((await a.api.call('get', recPath('site_contacts'))).status).toBe(403);
  });
});
