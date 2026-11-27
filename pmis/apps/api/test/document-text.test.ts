import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from '../src/documents/text-extract';
import { zip } from './doc-helpers';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/** Item 12 (migration 0255, contract 0.15.104): extraction of PDF and DOCX text, and global search over file contents with permissions. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let withDocs: Actor;
let namesOnly: Actor;
const R = 5;
const U = randomUUID().slice(0, 8);
const WORD = `zzgrounding${U}`;

const PDF_TEXT = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 10 50 Td (Grounding resistance report) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF
`);
const DOCX = zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Tower foundation inspection</w:t></w:r></w:p></w:body></w:document>',
});

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  withDocs = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('sites.documents', 'view')], regions: [R], modules: null });
  namesOnly = await actor(app, db, { level: 'view', grants: G('dashboard', 'view'), regions: [R], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('extractText', () => {
  it('reads a PDF and a DOCX, and reports the rest as a status, never a throw', async () => {
    const pdf = await extractText(PDF_TEXT, 'a.pdf', 'application/pdf');
    expect(pdf.status).toBe('done');
    expect(pdf.text).toBe('Grounding resistance report');
    const docx = await extractText(DOCX, 'b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(docx).toEqual({ status: 'done', text: 'Tower foundation inspection' });
    expect((await extractText(Buffer.from('x'), 'c.png', 'image/png')).status).toBe('unsupported');
    expect((await extractText(Buffer.from('not a pdf'), 'd.pdf', 'application/pdf')).status).toBe('failed');
  });
});

describe('search inside file contents', () => {
  it('matches the text, shows a snippet, and only with the documents view right; the index status is System Admin only', async () => {
    const site = await makeSite(db, R);
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Report', now()) RETURNING id`, [`DCS${U}`]);
    const slot = await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id, status) VALUES ($1, $2, $3, 'uploaded') RETURNING id`, [site.id, R, dt.rows[0].id]);
    const file = await db.query(`INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
      VALUES ($1, gen_random_uuid(), 'plain-name.pdf', 'plain-name.pdf', $2, 'application/pdf', 10, 'x', $3) RETURNING id`, [slot.rows[0].id, `dcs/${U}`, admin.user.id]);
    await db.query(`SELECT document_text_put($1::uuid, 'done', $2::text)`, [file.rows[0].id, `The ${WORD} test passed at the tower`]);
    const find = async (a: Actor) => {
      const r = await a.api.call('get', `/search?q=${WORD}&types=documents`);
      expect(r.status).toBe(200);
      return (r.body.groups as { type: string; items: { id: string; snippet: string | null }[] }[]).find((g) => g.type === 'documents')?.items ?? [];
    };
    const hit = (await find(withDocs)).find((i) => i.id === file.rows[0].id);
    expect(hit?.snippet).toContain(WORD);
    expect((await find(admin)).some((i) => i.id === file.rows[0].id)).toBe(true);
    expect((await find(namesOnly)).some((i) => i.id === file.rows[0].id)).toBe(false);    // no Sites right at all (the documents view right comes with the Sites grant, as for the Documents list): the content is not searched
    expect((await namesOnly.api.call('get', '/admin/document-search-index')).status).toBe(403);
    const st = await admin.api.call('get', '/admin/document-search-index');
    expect(st.status).toBe(200);
    expect(st.body.indexed).toBeGreaterThanOrEqual(1);
    // the app role can read but never write the text table directly
    const write = await db.query(`SELECT has_table_privilege('pmis_app', 'document_texts', 'INSERT') AS w`);
    expect(write.rows[0].w).toBe(false);
  });
});
