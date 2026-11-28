import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docFlow, type DocFlow } from './doc-helpers';
import { startApp, superDbDocs } from './helpers';
import { type Actor, plainAdmin } from './wf-helpers';

/**
 * The CW warehouse forms through the Library (spec docs/plans/spec-cw-warehouse-forms.md, migration 0712, contract 0.15.583): the CW sections of the
 * form context (contractor, warehouse, movement lines, snags, BoQ, PAC reference, signatories), the guards of lib_check_generate (DN/RN need a
 * movement with printable lines, PAC is refused while a CW snag is open, FAC needs an issued PAC and waits for its DLP expiry unless a System Admin
 * overrides), the {REGION} numbering with the site's region code, the movement link, the audit extras and the seeds (E3_CWRN_GEN, the settings).
 * The template seed itself is skipped on an empty database (a fresh installation creates its first user after the migrations), so the suites upload
 * the templates through the API, the same path an admin uses.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let flow: DocFlow;
const R = 3; // WM: the other documents suites use regions 4 to 7
const TAG = `CW${Date.now() % 100000}`;
const DN_HTML = readFileSync(join(__dirname, '..', '..', '..', 'design', 'forms', 'templates', 'GSDN_CW_DN.tpl.html'), 'utf8');
const RN_HTML = '<html><body><h1>RN {{doc.ref_no}}</h1><p>{{warehouse.name}}</p>{{#each lines}}{{no}} {{description}} {{qty}};{{/each}}'
  + '<p>{{rn.reason_other}}</p><p>{{signatories.applicant.name}}</p></body></html>';
const PAC_HTML = '<html><body><h1>PAC {{doc.ref_no}}</h1><p>{{pac.dlp_start}} {{pac.dlp_expiry}} {{pac.dlp_duration}}</p>'
  + '{{#each snags}}{{no}} {{status}};{{/each}}{{#each boq}}{{item_code}}={{qty}};{{/each}}</body></html>';
const FAC_HTML = '<html><body><h1>FAC {{doc.ref_no}}</h1><p>{{pac.ref_no}} {{pac.date}}</p><p>{{contractor.name}}</p></body></html>';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  admin = await plainAdmin(app, db);
  flow = await docFlow(app, db, 'A2', { region: R });
  // the contractor of the site: the party of its latest CW procurement row (design/forms/bindings.md)
  const party = (await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'cw_contractor') RETURNING id`, [`Contractor ${TAG}`])).rows[0];
  await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, party_id, po_wo_no, po_wo_date) VALUES ($1, $2, 'CW', $3, $4, '2026-02-01')`,
    [flow.site.id, R, party.id, `PO-${TAG}`]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

/** POST /library/form-templates is multipart (see w5-library.test.ts). */
const saveTpl = (who: Actor, body: Record<string, unknown>) => {
  const t = who.api.call('post', '/library/form-templates');
  for (const [k, v] of Object.entries(body)) {
    if (k === 'html' || v === undefined) continue;
    t.field(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return t.attach('file', Buffer.from(String(body.html ?? ''), 'utf8'), { filename: 'form.html', contentType: 'text/html' });
};
const makeTpl = async (code: string, doc: string, pattern: string, html: string) => {
  const c = await saveTpl(admin, { code, name_en: `${code} form`, doc_code: doc, trigger_task_code: 'A2', numbering_pattern: pattern, html, reason: 'CW forms test' });
  expect(c.status, JSON.stringify(c.body.errors ?? '')).toBe(201);
  const ap = await admin.api.call('post', `/library/form-templates/${c.body.id}/approve`, { reason: 'Approved for the test' });
  expect(ap.status).toBe(200);
  return c.body.id as string;
};
/** A posted warehouse movement of the site with one printable line, as wh_create_movement leaves it. */
const makeMovement = async (type: 'cw_dn' | 'cw_rn', qty: number) => {
  const ent = (await db.query(
    `INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, levels_required, data, custom, created_by, level_opened_at)
     VALUES (gen_random_uuid(), 'warehouse', $1, $2, $3, 1, $4::jsonb, '{}'::jsonb, $5, now()) RETURNING id, entity_id`,
    [type, flow.site.id, R, JSON.stringify({ doc_date: '2026-02-10', reason: type === 'cw_rn' ? 'Faulty or Damaged' : undefined }), admin.user.id])).rows[0];
  const mv = (await db.query(
    `INSERT INTO wh_movements (entity_id, record_id, record_type, kind, status, site_id, region_id, created_by, posted_at)
     VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, now()) RETURNING id`,
    [ent.entity_id, ent.id, type, type === 'cw_dn' ? 'issue' : 'return', flow.site.id, R, admin.user.id])).rows[0];
  const item = (await db.query(`INSERT INTO warehouse_items (item_code, item_group, name, unit) VALUES ($1, 'CW', $2, 'pcs') RETURNING id`,
    [`IT-${TAG}-${type === 'cw_dn' ? 'DN' : 'RN'}`, `Outdoor cabinet ${TAG} ${type}`])).rows[0];
  await db.query(`INSERT INTO wh_movement_lines (movement_id, item_id, qty, qty_approved, condition, sort_order) VALUES ($1, $2, $3, $3, 'Good', 0)`,
    [mv.id, item.id, qty]);
  return mv.id as string;
};
const auditAfter = async (id: string) =>
  (await db.query(`SELECT after FROM audit_log WHERE action = 'library_document_generate' AND entity_id = $1`, [id])).rows[0]?.after;
/** The draft document types the CW forms belong to are published by the product owner later; the suites activate them as publishing would. */
const activateDocTypes = () =>
  db.query(`UPDATE document_types SET is_active = true, updated_at = now() WHERE code IN ('B7_DN', 'E3_CWRN_GEN', 'B13_PAC', 'B15_FAC')`);

describe('CW forms: the seeds of migration 0712', () => {
  it('the generated RN of E3 is a draft document type; the blank rows and the central store are settings', async () => {
    const dt = (await db.query(`SELECT is_active, lib_managed, needs_review FROM document_types WHERE code = 'E3_CWRN_GEN'`)).rows[0];
    expect(dt).toEqual({ is_active: false, lib_managed: true, needs_review: true });
    const draft = (await db.query(`SELECT d.spec ->> 'form_kind' AS fk, d.spec -> 'placements' AS pl FROM document_type_drafts d JOIN document_types t ON t.id = d.doc_type_id WHERE t.code = 'E3_CWRN_GEN'`)).rows[0];
    expect(draft.fk).toBe('rn');
    expect(draft.pl).toEqual([{ target: 'task', ref: 'E3' }]);
    const st = (await db.query(`SELECT key, value #>> '{}' AS v FROM settings WHERE key IN ('forms.blank_rows.DN', 'forms.blank_rows.RN', 'forms.blank_rows.PAC', 'warehouse.central_name') ORDER BY key`)).rows;
    expect(st).toEqual([
      { key: 'forms.blank_rows.DN', v: '3' }, { key: 'forms.blank_rows.PAC', v: '3' }, { key: 'forms.blank_rows.RN', v: '3' },
      { key: 'warehouse.central_name', v: 'Central Warehouse' },
    ]);
  });

  it('a numbering pattern with {REGION} is accepted (the region code of the document site fills it)', async () => {
    const c = await saveTpl(admin, { code: `${TAG}-REG`, name_en: 'Region token', doc_code: 'A2', trigger_task_code: 'A2', numbering_pattern: 'X-CW-{REGION}-{YYYY}-{SEQ:4}', html: '<html><body><p>region token form</p></body></html>', reason: 'CW forms test' });
    expect(c.status, JSON.stringify(c.body.errors ?? '')).toBe(201);
  });
});

describe('CW forms: DN and RN print their warehouse movement', () => {
  let DN: string; let RN: string;
  beforeAll(async () => {
    await activateDocTypes();
    DN = await makeTpl(`${TAG}-DN`, 'B7_DN', 'DN-CW-{REGION}-{YYYY}-{SEQ:4}', DN_HTML);
    RN = await makeTpl(`${TAG}-RN`, 'E3_CWRN_GEN', 'RN-CW-{REGION}-{YYYY}-{SEQ:4}', RN_HTML);
  });

  it('without a movement the DN is refused; with one it takes the region number, prints the data and links the movement', async () => {
    const no = await flow.e.api.call('post', `/library/forms/${DN}/generate`, { site_id: flow.site.id });
    expect(no.status).toBe(409);
    expect(no.body.code).toBe('invalid_transition');
    const mv = await makeMovement('cw_dn', 5);
    const p = await flow.e.api.call('post', `/library/forms/${DN}/preview`, { site_id: flow.site.id });
    expect(p.status).toBe(200);
    expect(p.body.html).toContain('Central Warehouse');
    expect(p.body.html).toContain(`Contractor ${TAG}`);
    expect(p.body.html).toContain(`PO-${TAG}`);
    expect(p.body.html).toContain(`Outdoor cabinet ${TAG} cw_dn`);
    const g = await flow.e.api.call('post', `/library/forms/${DN}/generate`, { site_id: flow.site.id });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const year = new Date().getFullYear();
    expect(g.body.number).toMatch(new RegExp(`^DN-CW-WM-${year}-\\d{4}$`));
    const after = await auditAfter(g.body.id);
    expect(after).toMatchObject({ form_kind: 'dn', movement_id: mv, dlp_override: false });
    expect((await db.query('SELECT form_id FROM wh_movements WHERE id = $1', [mv])).rows[0].form_id).toBe(g.body.id);
    const g2 = await flow.e.api.call('post', `/library/forms/${DN}/generate`, { site_id: flow.site.id });
    expect(Number(g2.body.number.slice(-4))).toBe(Number(g.body.number.slice(-4)) + 1);
  });

  it('the RN prints its lines and the L1 signatory of the trigger task', async () => {
    await makeMovement('cw_rn', 2);
    const p = await flow.e.api.call('post', `/library/forms/${RN}/preview`, { site_id: flow.site.id });
    expect(p.status).toBe(200);
    expect(p.body.html).toContain(`1 Outdoor cabinet ${TAG} cw_rn 2;`);
    expect(p.body.html).toContain(flow.e.user.name ?? '');
    const g = await flow.e.api.call('post', `/library/forms/${RN}/generate`, { site_id: flow.site.id });
    expect(g.status).toBe(201);
    expect(g.body.number).toMatch(new RegExp(`^RN-CW-WM-${new Date().getFullYear()}-\\d{4}$`));
  });
});

describe('CW forms: the PAC and the FAC guards', () => {
  let PAC: string; let FAC: string;
  beforeAll(async () => {
    await activateDocTypes();
    PAC = await makeTpl(`${TAG}-PAC`, 'B13_PAC', 'PAC-CW-{REGION}-{YYYY}-{SEQ:4}', PAC_HTML);
    FAC = await makeTpl(`${TAG}-FAC`, 'B15_FAC', 'FAC-CW-{REGION}-{YYYY}-{SEQ:4}', FAC_HTML);
  });

  it('the PAC is refused 422 open_snags while a CW snag of the site is open, and computes its DLP once they are closed', async () => {
    const st = (await db.query(`SELECT id FROM snag_types LIMIT 1`)).rows[0];
    const snag = (await db.query(
      `INSERT INTO snags (site_id, region_id, snag_type_id, scope, description, status, raised_by) VALUES ($1, $2, $3, 'CW', 'Cracked plinth', 'open', $4) RETURNING id`,
      [flow.site.id, R, st.id, admin.user.id])).rows[0];
    const r = await flow.e.api.call('post', `/library/forms/${PAC}/generate`, { site_id: flow.site.id });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('open_snags');
    expect(r.body).toMatchObject({ count: 1, scope: 'CW' });
    await db.query(`UPDATE snags SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1`, [snag.id, admin.user.id]);
    const g = await flow.e.api.call('post', `/library/forms/${PAC}/generate`, { site_id: flow.site.id });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body.number).toMatch(new RegExp(`^PAC-CW-WM-${new Date().getFullYear()}-\\d{4}$`));
    const data = (await db.query('SELECT data FROM library_generated_docs WHERE id = $1', [g.body.id])).rows[0].data;
    expect(data.pac.dlp_duration).toBe('3 months');
    expect(data.pac.dlp_start <= data.pac.dlp_expiry).toBe(true);
    expect(data.snags[0]).toMatchObject({ no: 'S01', description: 'Cracked plinth', status: 'Closed' });
  });

  it('the FAC needs the issued PAC and waits for its DLP expiry; a System Admin may override, audited', async () => {
    const early = await flow.e.api.call('post', `/library/forms/${FAC}/generate`, { site_id: flow.site.id });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('invalid_transition');
    const over = await admin.api.call('post', `/library/forms/${FAC}/generate`, { site_id: flow.site.id });
    expect(over.status, JSON.stringify(over.body)).toBe(201);
    const after = await auditAfter(over.body.id);
    expect(after).toMatchObject({ form_kind: 'fac', dlp_override: true });
    const data = (await db.query('SELECT data FROM library_generated_docs WHERE id = $1', [over.body.id])).rows[0].data;
    expect(data.pac.ref_no).toMatch(/^PAC-CW-WM-/);
    expect(data.fac.recommendation_is).toEqual({ recommended: false, not_recommended: true });
  });
});
