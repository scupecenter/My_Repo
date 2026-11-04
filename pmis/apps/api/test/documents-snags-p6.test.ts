import type { NestExpressApplication } from '@nestjs/platform-express';
import { unzipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipService } from '../src/documents/zip.service';
import { PDF, PNG, jpegWithExif } from './doc-helpers';
import { Api, adminApi, sleep, startApp } from './helpers';
import { G, post, recPath, regCell } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Work package P6 of the owner answers of 2026-11-04 (migration 0056, contract 0.12.4): Q195, Q199 (storage, see also storage-protection.test.ts), Q226
 * (see documents-registers-snags.test.ts), Q227 one requirement per purpose, Q228 slots on global records, Q229 new versions and documents, Q230 the
 * finder / fixer / approver and the Quality - TE row, D230b no self-approval of a snag, Q231 all-members L2, Q232 the EXIF tolerance setting and
 * pending evidence, Q233 severities and blocking rules, Q234 the Quality snag record and the QC snag.
 * Runs on the logs database (TEST_DATABASE_URL_LOGS): this suite changes the documents and QC settings, which no other suite of that database reads.
 * Region 7. Dates are relative to the database clock; nothing depends on the weekday or on a collation.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Api;
const R = 7;
const U = randomBytes(3).toString('hex').toUpperCase();
const DL: [string, string] = ['sites.documents', 'download_documents'];

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_LOGS as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_LOGS });
  await db.connect();
  admin = (await adminApi(app, db)).api;
});
afterAll(async () => {
  await app.get(ZipService).idle();
  await db.end();
  await app.close();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
const exifText = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');
const ifm = (v: number) => ({ 'If-Match': `"${v}"` });

async function libDoc(code: string, placements: Record<string, unknown>[], over: Record<string, unknown> = {}): Promise<string> {
  const c = await admin.call('post', '/document-library', { code, kind: 'scanned_document', name_en: `Doc ${code}`, placements, formats: ['pdf', 'png'], max_size_mb: 5, min_files: 1, max_files: 1, reason: 'p6 test', ...over });
  expect(c.status).toBe(201);
  const p = await admin.call('post', `/document-library/${c.body.id}/publish`, { reason: 'p6 test', effective_from: '2026-01-01', apply_to: 'new_only' }, { 'If-Match': String(c.headers.etag) });
  expect(p.status).toBe(200);
  return c.body.id as string;
}

async function settings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cur = await admin.call('get', '/settings/documents-qc');
  const r = await admin.call('put', '/settings/documents-qc', { ...patch, reason: 'p6 test' }, { 'If-Match': String(cur.headers.etag) });
  expect(r.status).toBe(200);
  return r.body as Record<string, unknown>;
}

/** A global cell of a register row (no region), with these holders. */
async function globalCell(key: string, level: 1 | 3, users: string[]): Promise<void> {
  await db.query(`DELETE FROM matrix_cell_assignees WHERE cell_id IN (SELECT id FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id IS NULL AND task_def_id IS NULL)`, [key, level]);
  let c = (await q<{ id: string }>(`SELECT id FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id IS NULL AND task_def_id IS NULL ORDER BY id LIMIT 1`, [key, level]))[0];
  if (!c) c = (await q<{ id: string }>(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ($1, $2, 'any_one', NULL, true, now()) RETURNING id`, [key, level]))[0];
  for (const u of users) await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c!.id, u]);
}

// --------------------------------------------------------------------------------------------------------------------------------- snags
interface SnagDto {
  id: string; state: string; version: number; raised_at: string; allowed_actions: string[]; severity: string | null; severity_missing: boolean; blocks_acceptance: boolean;
  photos: { id: string; status: string }[]; photos_missing: { code: string }[]; register_record: { entity_id: string; record_code: string } | null;
  ball_in_court?: { rule: string; votes_needed?: number; votes_done?: number; matrix_row: string }; found_by?: { id: string }; approved_by?: { id: string }; approval_blocked: string | null;
}
const snag = async (who: Actor, id: string): Promise<SnagDto> => (await who.api.call('get', `/snags/${id}`)).body as SnagDto;
const act = (who: Actor, id: string, verb: string, version: number, body: unknown = {}) => who.api.call('post', `/snags/${id}/${verb}`, body, ifm(version));
const photo = (who: Actor, id: string, buf: Buffer) => who.api.call('post', `/snags/${id}/photos`).attach('file', buf, { filename: 'fix.jpg', contentType: 'image/jpeg' });
let generalType = '';

async function team(): Promise<{ e: Actor; a: Actor; i: Actor; site: { id: string; code: string; region: number } }> {
  const e = await actor(app, db, { level: 'entry', regions: [R], grants: [...G('quality', 'view', 'create', 'edit'), ['sites', 'view'], ['sites', 'edit'], DL] });
  const a = await actor(app, db, { level: 'approve', regions: [R], grants: [...G('quality', 'view', 'approve'), DL] });
  const i = await actor(app, db, { level: 'entry', regions: [R], grants: G('quality', 'view', 'create') });
  await regCell(db, 'quality', R, 'entry', { user: [e.user.id] });
  await regCell(db, 'quality', R, 'approve', { user: [a.user.id] });
  if (!generalType) generalType = (await admin.call('get', '/snag-types')).body.items.find((t: { code: string }) => t.code === 'QC_GENERAL').id as string;
  return { e, a, i, site: await makeSite(db, R, { prefix: 'P6' }) };
}

describe('Q233: severities and the blocking rule of a snag type', () => {
  it('a snag needs a known severity; QC_GENERAL keeps blocking; a by-severity type blocks the PAC only for a blocking severity; a legacy snag without one blocks', async () => {
    const { i, site } = await team();
    const raise = (body: Record<string, unknown>) => i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Missing bolt', ...body });
    const none = await raise({});
    expect(none.status).toBe(422);
    expect((await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Missing bolt', severity: 'HUGE' })).body.errors).toEqual([expect.objectContaining({ path: '/severity', code: 'unknown_severity' })]);
    // the default type stays the conservative default: it always blocks, whatever the severity (Q233)
    const types = (await admin.call('get', '/snag-types')).body.items as { code: string; blocking_rule: string; stream: string | null }[];
    expect(types.find((t) => t.code === 'QC_GENERAL')).toMatchObject({ blocking_rule: 'always', stream: null });
    const pac = await makeTask(db, site, 'B13', 'entry', { actualDate: '2026-01-05' });
    const minorGeneral = await raise({ severity: 'minor' });
    expect(minorGeneral.status).toBe(201);
    expect(minorGeneral.body).toMatchObject({ severity: 'MINOR', blocks_acceptance: true });
    expect((await admin.call('get', `/tasks/${pac}`)).body.lock_reasons).toEqual([expect.objectContaining({ kind: 'open_snags', count: 1 })]);

    // a type that blocks by severity (the admin edits the catalogue), and is for the CW stream only
    const t = await admin.call('post', '/snag-types', { code: `TSEV${U}`, name_en: 'Paint', photo_rules: { min_count: 1 }, stream: 'CW', blocking_rule: 'by_severity', reason: 'p6 test' });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ stream: 'CW', blocking_rule: 'by_severity', blocks_preliminary_acceptance: true });
    const site2 = await makeSite(db, R, { prefix: 'P6' });
    const pac2 = await makeTask(db, site2, 'B13', 'entry', { actualDate: '2026-01-05' });
    const r2 = (body: Record<string, unknown>) => i.api.call('post', `/sites/${site2.id}/snags`, { snag_type_id: t.body.id, title: 'Paint chip', ...body });
    expect((await r2({ scope: 'TE', severity: 'MAJOR' })).body.errors).toEqual([expect.objectContaining({ path: '/snag_type_id', code: 'wrong_stream' })]);
    const minor = await r2({ scope: 'CW', severity: 'MINOR' });
    expect(minor.body).toMatchObject({ blocks_acceptance: false, severity_missing: false });
    expect((await admin.call('get', `/tasks/${pac2}`)).body.lock_reasons).toEqual([]);
    const major = await r2({ scope: 'CW', severity: 'MAJOR' });
    expect(major.body.blocks_acceptance).toBe(true);
    expect((await admin.call('get', `/tasks/${pac2}`)).body.lock_reasons).toEqual([expect.objectContaining({ kind: 'open_snags', count: 1 })]);
    // legacy data: a snag without a severity blocks conservatively and says so (Q109)
    await db.query(`UPDATE snags SET severity = NULL WHERE id = $1`, [minor.body.id]);
    expect(await snag(i, minor.body.id)).toMatchObject({ severity: null, severity_missing: true, blocks_acceptance: true });
    expect((await admin.call('get', `/tasks/${pac2}`)).body.lock_reasons[0].count).toBe(2);
  });

  it('the severity catalogue is edited as a whole list (reason, If-Match, audited); a code is deactivated, never removed; only the admin path writes', async () => {
    const cur = await admin.call('get', '/snag-severities');
    expect(cur.status).toBe(200);
    expect(cur.body.items.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['CRITICAL', 'MAJOR', 'MINOR']));
    const items = (cur.body.items as { code: string; name_en: string; name_ar: string | null; blocks: boolean; is_active: boolean }[]).map(({ code, name_en, name_ar, blocks, is_active }) => ({ code, name_en, name_ar, blocks, is_active }));
    const removed = await admin.call('put', '/snag-severities', { reason: 'p6 test', items: items.filter((x) => x.code !== 'MAJOR') }, { 'If-Match': String(cur.headers.etag) });
    expect(removed.status).toBe(422);
    expect(removed.body.errors).toEqual([expect.objectContaining({ code: 'cannot_remove' })]);
    const ok = await admin.call('put', '/snag-severities', { reason: 'p6 test', items: [...items, { code: `COSM${U}`, name_en: 'Cosmetic', name_ar: 'تجميلية', blocks: false }] }, { 'If-Match': String(cur.headers.etag) });
    expect(ok.status).toBe(200);
    expect(ok.body.items.find((x: { code: string }) => x.code === `COSM${U}`)).toMatchObject({ blocks: false, is_active: true });
    expect((await admin.call('put', '/snag-severities', { reason: 'stale copy', items: (ok.body.items as Record<string, unknown>[]).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'in_use'))) }, { 'If-Match': String(cur.headers.etag) })).status).toBe(412);
    expect((await admin.call('put', '/snag-severities', { reason: 'p6 test', items, extra: 1 }, { 'If-Match': String(ok.headers.etag) })).status).toBe(422);
    const plain = await actor(app, db, { level: 'entry', regions: [R], grants: G('quality', 'view') });
    expect((await plain.api.call('put', '/snag-severities', { reason: 'nope', items }, { 'If-Match': String(ok.headers.etag) })).status).toBe(403);
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'snag_severities.set'`)).toHaveLength(1);
  });
});

describe('Q230 / D230b / Q231: the people of a snag', () => {
  it('records the finder, the fixer and the approver; the finder named at the raise cannot approve; all members of an all-members L2 vote, except the fixer', async () => {
    const { e, a, i, site } = await team();
    const a2 = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve') });
    // e is L1 and also on the L2 cell; a, a2 and e must all approve (all members), but e fixed it and is left out (D230b)
    await regCell(db, 'quality', R, 'approve', { user: [a.user.id, a2.user.id, e.user.id] }, 'all_members');
    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Rust on bracket', severity: 'MAJOR', found_by: a2.user.id });
    expect(r.status).toBe(201);
    expect(r.body.found_by.id).toBe(a2.user.id);
    expect(r.body.raised_by.id).toBe(i.user.id);
    expect((await photo(e, r.body.id, jpegWithExif(null))).status).toBe(201);
    const s = await snag(e, r.body.id);
    const sub = await act(e, r.body.id, 'submit', s.version);
    expect(sub.status).toBe(200);
    // the finder a2 is left out too: only a votes
    expect(sub.body.ball_in_court).toMatchObject({ rule: 'all_members', votes_needed: 1, votes_done: 0 });
    expect((await act(a2, r.body.id, 'approve', sub.body.version)).body.code).toBe('self_approval_forbidden');
    expect((await act(e, r.body.id, 'approve', sub.body.version)).body.code).toBe('self_approval_forbidden');
    const done = await act(a, r.body.id, 'approve', sub.body.version);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'closed' });
    expect(done.body.approved_by.id).toBe(a.user.id);
  });

  it('all members: a voter taken off the L2 cell after the submission can no longer vote, and the snag closes without them', async () => {
    const { e, a, i, site } = await team();
    const a2 = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve') });
    await regCell(db, 'quality', R, 'approve', { user: [a.user.id, a2.user.id] }, 'all_members');
    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Loose cable tray', severity: 'MAJOR' });
    await photo(e, r.body.id, jpegWithExif(null));
    const sub = await act(e, r.body.id, 'submit', (await snag(e, r.body.id)).version);
    expect(sub.body.ball_in_court).toMatchObject({ votes_needed: 2, votes_done: 0 });
    await regCell(db, 'quality', R, 'approve', { user: [a.user.id] }, 'all_members');      // a2 leaves the cell
    expect((await act(a2, r.body.id, 'approve', sub.body.version)).status).toBe(403);
    expect((await act(a2, r.body.id, 'reject', sub.body.version, { note: 'no' })).status).toBe(403);
    const done = await act(a, r.body.id, 'approve', sub.body.version);
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('closed');
  });

  it('a severity change that lifts the block needs an L2 holder who did not raise, find or fix the snag; raising the severity does not', async () => {
    const { e, i, site } = await team();
    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Missing earthing', severity: 'MAJOR' });
    await photo(e, r.body.id, jpegWithExif(null));                                     // e is now the fixer
    let s = await snag(e, r.body.id);
    const low = await e.api.call('patch', `/snags/${r.body.id}`, { severity: 'MINOR' }, ifm(s.version));
    expect(low.status).toBe(403);
    expect(low.body.code).toBe('self_approval_forbidden');
    expect((await snag(e, r.body.id)).severity).toBe('MAJOR');
    s = await snag(e, r.body.id);
    expect((await e.api.call('patch', `/snags/${r.body.id}`, { severity: 'CRITICAL' }, ifm(s.version))).status).toBe(200);
  });

  it('all members: the snag closes with the last vote; a voter cannot vote twice; the votes are audited', async () => {
    const { e, a, i, site } = await team();
    const a2 = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve') });
    await regCell(db, 'quality', R, 'approve', { user: [a.user.id, a2.user.id] }, 'all_members');
    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Crack in plinth', severity: 'CRITICAL' });
    await photo(e, r.body.id, jpegWithExif(null));
    const sub = await act(e, r.body.id, 'submit', (await snag(e, r.body.id)).version);
    expect(sub.body.ball_in_court).toMatchObject({ votes_needed: 2, votes_done: 0 });
    const v1 = await act(a, r.body.id, 'approve', sub.body.version);
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ state: 'in_review' });
    expect(v1.body.ball_in_court).toMatchObject({ votes_needed: 2, votes_done: 1 });
    expect(v1.body.allowed_actions).not.toContain('approve');
    expect((await act(a, r.body.id, 'approve', v1.body.version)).status).toBe(403);
    const v2 = await act(a2, r.body.id, 'approve', v1.body.version);
    expect(v2.body.state).toBe('closed');
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'snag_vote' AND entity_id = $1`, [r.body.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'snag_close' AND entity_id = $1`, [r.body.id])).toHaveLength(1);
  });

  it('a TE snag takes its holders from the Quality - TE row when that row has a cell for the region (Q230)', async () => {
    const { e, a, i, site } = await team();
    const te1 = await actor(app, db, { level: 'entry', regions: [R], grants: G('quality', 'view', 'edit') });
    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'TE', title: 'Loose feeder', severity: 'MAJOR' });
    // no Quality - TE cell in the region: the Quality region cell decides (a set-up made before 0056 keeps working)
    expect(r.body.ball_in_court.matrix_row).toBe('quality');
    expect((await snag(e, r.body.id)).allowed_actions).toContain('upload');
    await regCell(db, 'quality_te', R, 'entry', { user: [te1.user.id] });
    await regCell(db, 'quality_te', R, 'approve', { user: [a.user.id] });
    expect((await snag(e, r.body.id)).ball_in_court?.matrix_row).toBe('quality_te');
    expect((await snag(e, r.body.id)).allowed_actions).toEqual([]);
    expect((await snag(te1, r.body.id)).allowed_actions).toContain('upload');
    await db.query(`DELETE FROM matrix_cells WHERE register_key = 'quality_te' AND region_id = $1`, [R]);
  });
});

describe('Q232: the EXIF tolerance setting and pending evidence', () => {
  it('the setting is validated and audited; a future EXIF date beyond it is kept as pending evidence that only L2 (not the fixer) accepts', async () => {
    const { e, a, i, site } = await team();
    const g = await admin.call('get', '/settings/documents-qc');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ new_version_inherit: false, exif_tolerance_hours: 24, exif_time_zone: 'Africa/Tripoli', scan: { generated_exports: false, zip_leaves_out_unscanned: true } });
    expect((await admin.call('put', '/settings/documents-qc', { reason: 'p6 test', exif_tolerance_hours: 500 }, { 'If-Match': String(g.headers.etag) })).status).toBe(422);
    expect((await admin.call('put', '/settings/documents-qc', { reason: 'p6 test', nope: true }, { 'If-Match': String(g.headers.etag) })).status).toBe(422);
    expect((await e.api.call('put', '/settings/documents-qc', { reason: 'p6 test', exif_tolerance_hours: 48 }, { 'If-Match': String(g.headers.etag) })).status).toBe(403);
    const s48 = await settings({ exif_tolerance_hours: 48 });
    expect(s48).toMatchObject({ exif_tolerance_hours: 48, version: (g.body.version as number) + 1 });
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'settings.documents_qc_set'`)).not.toHaveLength(0);

    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Earth bar loose', severity: 'MAJOR' });
    const raised = new Date(r.body.raised_at as string);
    // 30 hours before the raise is inside the 48-hour tolerance now
    expect((await photo(e, r.body.id, jpegWithExif(exifText(new Date(raised.getTime() - 30 * 3600000))))).status).toBe(201);
    await settings({ exif_tolerance_hours: 24 });
    expect((await photo(e, r.body.id, jpegWithExif(exifText(new Date(raised.getTime() - 30 * 3600000))))).body.reason).toBe('before_snag_raised');
    // a fix photo dated five days in the future: kept, but not proof of the fix
    const r2 = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Cable tray cover', severity: 'MAJOR' });
    const fut = await photo(e, r2.body.id, jpegWithExif(exifText(new Date(Date.now() + 5 * 86400000))));
    expect(fut.status).toBe(201);
    expect(fut.body.status).toBe('pending_evidence');
    let s = await snag(e, r2.body.id);
    expect(s.state).toBe('open');
    expect(s.photos_missing.map((x) => x.code)).toEqual(['min_count']);
    expect((await act(e, r2.body.id, 'submit', s.version)).status).toBe(422);
    expect((await snag(a, r2.body.id)).allowed_actions).toContain('decide_evidence');
    // the fixer may not accept their own evidence; a note is required
    expect((await e.api.call('post', `/snags/${r2.body.id}/photos/${fut.body.id}/evidence`, { decision: 'accept', note: 'camera clock wrong' })).body.code).toBe('self_approval_forbidden');
    expect((await a.api.call('post', `/snags/${r2.body.id}/photos/${fut.body.id}/evidence`, { decision: 'accept' })).status).toBe(422);
    const acc = await a.api.call('post', `/snags/${r2.body.id}/photos/${fut.body.id}/evidence`, { decision: 'accept', note: 'camera clock was wrong, checked on site' });
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({ state: 'fix_submitted' });
    expect(acc.body.photos[0]).toMatchObject({ status: 'accepted', evidence_note: 'camera clock was wrong, checked on site' });
    s = await snag(e, r2.body.id);
    expect((await act(e, r2.body.id, 'submit', s.version)).status).toBe(200);
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'snag_evidence_accept' AND entity_id = $1`, [r2.body.id])).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------------------------------------------------------------- Q234
describe('Q234 / Q103: the Quality snag record and the QC snag are one work item', () => {
  const newRec = async (who: Actor, siteId: string, data: Record<string, unknown>) => {
    const r = await who.api.call('post', recPath('quality'), { site_id: siteId, record_type: 'snag', data: { record_code: `SN-${U}-${randomBytes(2).toString('hex')}`, description: 'Grout missing at base', severity: 'Major', ...data } });
    expect(r.status).toBe(201);
    return r.body as { id: string; entity_id: string; version: number };
  };

  it('the final approval of the record creates its QC snag once; a new version updates it; only the QC photo flow closes it; voiding the record cancels it', async () => {
    const { e, a, site } = await team();
    const noStage = await newRec(e, site.id, {});
    const refused = await post(e.api, 'quality', noStage.id, 'submit', noStage.version);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: '/data/stage', code: 'stream_required' })]);

    const rec = await newRec(e, site.id, { stage: 'TE QC' });
    const sub = await post(e.api, 'quality', rec.id, 'submit', rec.version);
    expect(sub.status).toBe(200);
    expect(sub.body.qc_snag).toMatchObject({ id: null, link: 'on_approval' });
    const ok = await post(a.api, 'quality', rec.id, 'approve', sub.body.version);
    expect(ok.status).toBe(200);
    expect(ok.body.qc_snag).toMatchObject({ link: 'linked', state: 'open', scope: 'TE' });
    const list = (await e.api.call('get', `/sites/${site.id}/snags`)).body.items as SnagDto[];
    const linked = list.filter((x) => x.register_record?.entity_id === rec.entity_id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ state: 'open', severity: 'MAJOR' });
    // the snag of a record is changed through the record
    expect((await e.api.call('patch', `/snags/${linked[0]!.id}`, { title: 'Other' }, ifm(linked[0]!.version))).status).toBe(409);
    // a new version of the record updates the same snag (idempotent link, never a second snag)
    const nv = await e.api.call('post', recPath('quality', rec.id, '/versions'), {}, ifm(ok.body.version));
    expect(nv.status).toBe(201);
    const ed = await e.api.call('patch', recPath('quality', nv.body.id), { data: { ...nv.body.data, description: 'Grout missing at the north base', severity: 'Critical' } }, ifm(nv.body.version));
    expect(ed.status).toBe(200);
    const sub2 = await post(e.api, 'quality', nv.body.id, 'submit', ed.body.version);
    const ok2 = await post(a.api, 'quality', nv.body.id, 'approve', sub2.body.version);
    expect(ok2.status).toBe(200);
    const after = (await e.api.call('get', `/sites/${site.id}/snags`)).body.items.filter((x: SnagDto) => x.register_record?.entity_id === rec.entity_id) as (SnagDto & { title: string })[];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: linked[0]!.id, severity: 'CRITICAL', state: 'open' });
    expect(after[0]!.title).toContain('north base');
    expect(await q(`SELECT 1 FROM snags WHERE register_entity_id = $1`, [rec.entity_id])).toHaveLength(1);
    // the record is no longer in force (an admin voids it in the database here): its open snag is cancelled and no longer blocks
    await db.query(`UPDATE register_records SET state = 'voided', is_current = false, void_reason = 'entered twice' WHERE entity_id = $1 AND state = 'approved'`, [rec.entity_id]);
    expect((await snag(e, linked[0]!.id)).state).toBe('cancelled');
  });

  it('qc_link_backfill links the records approved before 0056: an unlinked QC snag of the same site, stream and title is linked, not duplicated', async () => {
    const { i, site } = await team();
    const code = `OLD-${U}`;
    const raised = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: code, severity: 'MAJOR' });
    const ins = (data: Record<string, unknown>) => q<{ entity_id: string }>(`INSERT INTO register_records (entity_id, version_no, is_current, register_key, record_type, site_id, region_id, state, current_level, levels_required, data, approved_at, created_by)
      SELECT gen_random_uuid(), 1, true, 'quality', 'snag', s.id, s.region_id, 'approved', 2, 2, $2::jsonb, now(), $3::uuid FROM sites s WHERE s.id = $1 RETURNING entity_id::text`, [site.id, JSON.stringify(data), i.user.id]);
    const matched = (await ins({ record_code: code, stage: 'CW QC', severity: 'Major', description: 'old' }))[0]!;
    const fresh = (await ins({ record_code: `${code}-2`, stage: 'CW PAC', severity: 'Minor', description: 'old two' }))[0]!;
    const noStream = (await ins({ record_code: `${code}-3`, severity: 'Minor' }))[0]!;
    const res = (await q<{ r: { linked: number; created: number; needs_review: { reason: string }[] } }>(`SELECT qc_link_backfill() AS r`))[0]!.r;
    expect(res.linked).toBeGreaterThanOrEqual(1);
    expect(res.created).toBeGreaterThanOrEqual(1);
    expect(res.needs_review.map((x) => x.reason)).toContain('no_stream');
    expect((await q<{ id: string }>(`SELECT id::text FROM snags WHERE register_entity_id = $1`, [matched.entity_id]))[0]!.id).toBe(raised.body.id);
    expect(await q(`SELECT 1 FROM snags WHERE register_entity_id = $1 AND scope = 'CW' AND severity = 'MINOR'`, [fresh.entity_id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM snags WHERE register_entity_id = $1`, [noStream.entity_id])).toHaveLength(0);
    // a second run links nothing more
    const again = (await q<{ r: { linked: number; created: number } }>(`SELECT qc_link_backfill() AS r`))[0]!.r;
    expect(again).toMatchObject({ linked: 0, created: 0 });
  });
});

// --------------------------------------------------------------------------------------------------------------------------------- Q227, Q228, Q229, Q195
describe('documents: one requirement per purpose, global records, new versions, quarantine', () => {
  it('Q227: a document placed on B2 and on the Procurement register is one requirement: a file on either slot fills both', async () => {
    const code = `TWIN${U}`;
    await libDoc(code, [{ target: 'task', ref: 'B2' }, { target: 'register', ref: 'procurement' }]);
    const e = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites', 'edit'], ...G('procurement', 'view', 'create', 'edit')] });
    await regCell(db, 'procurement', R, 'entry', { user: [e.user.id] });
    const site = await makeSite(db, R, { prefix: 'P6T' });
    const task = await makeTask(db, site, 'B2', 'entry');
    await setCell(db, 'B2', R, 'entry', { user: [e.user.id] });
    const rec = await e.api.call('post', recPath('procurement'), { site_id: site.id, data: { scope: 'CW', delivery: 'In-House', po_wo_no: 'WO-7', po_wo_date: '2026-01-05', order_status: 'Open' } });
    expect(rec.status).toBe(201);
    const rs = (await e.api.call('get', recPath('procurement', rec.body.id, '/slots'))).body;
    const rSlot = rs.items.find((x: { doc_code: string }) => x.doc_code === code);
    expect(rSlot.shared_with).toMatchObject({ owner: 'task', task_code: 'B2', has_file: false });
    expect(rs.missing_for_submit).toContain(code);
    expect((await e.api.call('get', `/tasks/${task}`)).body.missing_for_submit).toContain(code);
    const up = await e.api.call('post', recPath('procurement', rec.body.id, `/slots/${rSlot.id}/files`)).attach('file', PDF, { filename: 'wo.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    // the task slot stays missing, but the requirement is filled by the record's file: Submit is no longer blocked by it
    const tSlot = (await e.api.call('get', `/tasks/${task}/slots`)).body.items.find((x: { doc_code: string }) => x.doc_code === code);
    expect(tSlot).toMatchObject({ status: 'missing' });
    expect(tSlot.shared_with).toMatchObject({ owner: 'register_record', register_key: 'procurement', status: 'uploaded', has_file: true });
    expect((await e.api.call('get', `/tasks/${task}`)).body.missing_for_submit).not.toContain(code);
    expect((await e.api.call('get', recPath('procurement', rec.body.id, '/slots'))).body.missing_for_submit).not.toContain(code);
  });

  it('Q228: a global record (Contractors, no site) has document slots; its files follow the register module, not a region', async () => {
    const code = `GLOB${U}`;
    await libDoc(code, [{ target: 'register', ref: 'contractors', record_type: 'company' }]);
    const e = await actor(app, db, { level: 'entry', regions: [R], grants: [...G('contractors', 'view', 'create', 'edit'), ['sites.documents', 'view'], DL] });
    await globalCell('contractors', 1, [e.user.id]);
    const rec = await e.api.call('post', recPath('contractors'), { record_type: 'company', data: { contractor_name: `Contractor ${U}` } });
    expect(rec.status).toBe(201);
    const s = (await e.api.call('get', recPath('contractors', rec.body.id, '/slots'))).body;
    const slot = s.items.find((x: { doc_code: string }) => x.doc_code === code);
    expect(slot).toMatchObject({ status: 'missing', can_upload: true });
    expect(s.missing_for_submit).toEqual([code]);
    expect((await post(e.api, 'contractors', rec.body.id, 'submit', rec.body.version)).body.code).toBe('mandatory_slots_missing');
    const up = await e.api.call('post', recPath('contractors', rec.body.id, `/slots/${slot.id}/files`)).attach('file', PDF, { filename: 'contract.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.download_name).toMatch(new RegExp(`^GLOBAL_CONTRACTORS_${code}_DRAFT-\\d{8}\\.pdf$`));
    expect((await q<{ is_global: boolean; site_id: string | null }>(`SELECT is_global, site_id::text FROM document_slots WHERE id = $1`, [slot.id]))[0]).toEqual({ is_global: true, site_id: null });
    expect((await e.api.call('get', `/files/${up.body.id}/download`)).status).toBe(200);
    // without the Contractors module the file is neither listed nor downloadable, whatever the Documents grant
    const docsOnly = await actor(app, db, { level: 'entry', regions: [R], grants: [['sites', 'view'], ['sites.documents', 'view'], DL] });
    expect((await docsOnly.api.call('get', `/files/${up.body.id}/download`)).status).toBe(404);
    expect((await docsOnly.api.call('get', `/documents?q=${code}`)).body.items).toEqual([]);
    expect((await e.api.call('get', `/documents?q=${code}`)).body.items).toEqual([expect.objectContaining({ register_key: 'contractors', site_code: 'GLOBAL' })]);
    expect((await post(e.api, 'contractors', rec.body.id, 'submit', (await e.api.call('get', recPath('contractors', rec.body.id))).body.version)).status).toBe(200);
  });

  it('Q229: with documents.new_version_inherit the unchanged slots keep their approval; a replacement goes back to L2; voiding the draft restores the approved file', async () => {
    const code = `INH${U}`;
    await libDoc(code, [{ target: 'register', ref: 'quality', record_type: 'itp' }]);
    const { e, a, site } = await team();
    const eDel = await actor(app, db, { level: 'entry', regions: [R], grants: [...G('quality', 'view', 'create', 'edit', 'delete'), DL] });
    await regCell(db, 'quality', R, 'entry', { user: [e.user.id, eDel.user.id] });
    const rec = await e.api.call('post', recPath('quality'), { site_id: site.id, record_type: 'itp', data: { record_code: `ITP-${U}` } });
    const slotId = (await e.api.call('get', recPath('quality', rec.body.id, '/slots'))).body.items[0].id as string;
    const f1 = await e.api.call('post', recPath('quality', rec.body.id, `/slots/${slotId}/files`)).attach('file', PDF, { filename: 'itp.pdf', contentType: 'application/pdf' });
    const sub = await post(e.api, 'quality', rec.body.id, 'submit', (await e.api.call('get', recPath('quality', rec.body.id))).body.version);
    const ok = await post(a.api, 'quality', rec.body.id, 'approve', sub.body.version);
    expect(ok.body.state).toBe('approved');

    await settings({ new_version_inherit: true });
    try {
      const nv = await e.api.call('post', recPath('quality', rec.body.id, '/versions'), {}, ifm(ok.body.version));
      expect(nv.status).toBe(201);
      let s = (await e.api.call('get', recPath('quality', nv.body.id, '/slots'))).body.items[0];
      expect(s).toMatchObject({ status: 'approved', inherited_approval: true, can_upload: true });
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'document_slot_approval_inherited' AND entity_id = $1`, [nv.body.id])).toHaveLength(1);
      // a replaced file goes back to L2
      const f2 = await e.api.call('post', recPath('quality', nv.body.id, `/slots/${slotId}/files`)).field('replaces_file_group_id', f1.body.file_group_id)
        .attach('file', PNG, { filename: 'itp-v2.png', contentType: 'image/png' });
      expect(f2.status).toBe(201);
      s = (await e.api.call('get', recPath('quality', nv.body.id, '/slots'))).body.items[0];
      expect(s).toMatchObject({ status: 'uploaded', inherited_approval: false });
      // the draft is voided: the approved file is current again, the slot approved, and the draft's file is kept on record
      const cur = (await eDel.api.call('get', recPath('quality', nv.body.id))).body;
      const v = await post(eDel.api, 'quality', nv.body.id, 'void', cur.version, { reason: 'correction not needed' });
      expect(v.status).toBe(200);
      const files = await q<{ id: string; is_current: boolean }>(`SELECT id::text, is_current FROM document_files WHERE slot_id = $1 ORDER BY version`, [slotId]);
      expect(files).toEqual([{ id: f1.body.id, is_current: true }, { id: f2.body.id, is_current: false }]);
      expect((await q<{ status: string }>(`SELECT status::text FROM document_slots WHERE id = $1`, [slotId]))[0]!.status).toBe('approved');
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'document_files_restored_on_void' AND entity_id = $1`, [nv.body.id])).toHaveLength(1);
    } finally {
      await settings({ new_version_inherit: false });
    }
  });

  it('Q195: a file stored without a scan (pending rescan) is not downloadable and is left out of a zip, listed in its manifest', async () => {
    const code = `QZ${U}`;
    await libDoc(code, [{ target: 'register', ref: 'quality', record_type: 'qc' }], { max_files: 2 });
    const { e, site } = await team();
    const rec = await e.api.call('post', recPath('quality'), { site_id: site.id, record_type: 'qc', data: { record_code: `QZ-${U}` } });
    const slotId = (await e.api.call('get', recPath('quality', rec.body.id, '/slots'))).body.items[0].id as string;
    const clean = await e.api.call('post', recPath('quality', rec.body.id, `/slots/${slotId}/files`)).attach('file', PDF, { filename: 'clean.pdf', contentType: 'application/pdf' });
    const held = await e.api.call('post', recPath('quality', rec.body.id, `/slots/${slotId}/files`)).attach('file', PNG, { filename: 'held.png', contentType: 'image/png' });
    expect(held.status).toBe(201);
    await db.query(`UPDATE stored_object_meta SET scan_status = 'pending_rescan' WHERE storage_key = (SELECT storage_key FROM document_files WHERE id = $1)`, [held.body.id]);
    const dl = await e.api.call('get', `/files/${held.body.id}/download`);
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe('file_pending_scan');
    const start = await e.api.call('post', '/exports/zip', { site_id: site.id });
    expect(start.status).toBe(202);
    let job: { status: string; result?: { file_count: number } } = { status: 'queued' };
    for (let k = 0; k < 100 && job.status !== 'done' && job.status !== 'failed'; k++) {
      await sleep(100);
      job = (await e.api.call('get', `/jobs/${start.body.id}`)).body;
    }
    expect(job).toMatchObject({ status: 'done', result: { file_count: 1 } });
    const zipRes = await e.api.call('get', `/exports/zip/${start.body.id}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const files = unzipSync(new Uint8Array(zipRes.body as Buffer));
    expect(Object.keys(files).filter((n) => n !== 'manifest.csv')).toHaveLength(1);
    const manifest = Buffer.from(files['manifest.csv']!).toString('utf8');
    expect(manifest).toContain('clean.pdf');
    expect(manifest).toContain('held.png');
    expect(manifest).toContain('waits for the virus scan');
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'document_zip_skipped_unscanned' AND entity_id = $1`, [start.body.id])).toHaveLength(1);
    void clean;
  });
});

// --------------------------------------------------------------------------------------------------------------------------------- follow-up group C (migration 0068, contract 0.13.2)
describe('Q260: the Quality register Severity list mirrors the snag severities', () => {
  it('reads CRITICAL, MAJOR and MINOR (and every severity the admin adds); the list is not written directly; a typed name becomes the code', async () => {
    const cat = await admin.call('get', '/list-catalogues/Severity');
    expect(cat.status).toBe(200);
    const active = (cat.body.values as { code: string; label_en: string; label_ar: string | null; is_active: boolean }[]).filter((v) => v.is_active);
    expect(active.slice(0, 3).map((v) => v.code)).toEqual(['CRITICAL', 'MAJOR', 'MINOR']);
    expect(active.slice(0, 3).map((v) => v.label_en)).toEqual(['Critical', 'Major', 'Minor']);
    expect(active[0]!.label_ar).toBe('حرجة');
    expect(cat.body).toMatchObject({ critical: true, used_by: [{ register_key: 'quality', field_code: 'severity' }] });
    // the severity added by the catalogue test above (COSM...) is on the register list too, with its name
    expect(active.find((v) => v.code === `COSM${U}`)).toMatchObject({ label_en: 'Cosmetic' });
    // the field of the register reads the same codes
    const quality = (await admin.call('get', '/registers')).body.items.find((d: { register_key: string }) => d.register_key === 'quality');
    const sev = quality.fields.find((f: { code: string }) => f.code === 'severity');
    expect(sev).toMatchObject({ type: 'list', list: { code: 'Severity' } });
    const opts = (sev.options as ({ value: string } | string)[]).map((o) => (typeof o === 'string' ? o : o.value));
    expect(opts).toEqual(expect.arrayContaining(['CRITICAL', 'MAJOR', 'MINOR', `COSM${U}`]));
    expect(opts).not.toContain('Critical');

    // a direct write to a value of the list is refused (even by the System Admin): change the snag severities instead
    const add = await admin.call('post', '/list-catalogues/Severity/values', { code: 'HUGE', label_en: 'Huge', reason: 'q260 test' });
    expect(add.status).toBe(422);
    expect(add.body.errors).toEqual([expect.objectContaining({ code: 'mirrored_list' })]);
    const value = (cat.body.values as { id: string; version: number }[])[0]!;
    const patch = await admin.call('patch', `/list-catalogues/Severity/values/${value.id}`, { label_en: 'Worse', reason: 'q260 test' }, ifm(value.version));
    expect(patch.status).toBe(422);
    expect(patch.body.errors).toEqual([expect.objectContaining({ code: 'mirrored_list' })]);
    expect(await q(`SELECT 1 FROM list_values WHERE catalogue_code = 'Severity' AND code = 'HUGE'`)).toHaveLength(0);

    // a record typed with a name or in lower case is stored as the code; an unknown text is refused
    const { e, site } = await team();
    const mk = (severity: string) => e.api.call('post', recPath('quality'), { site_id: site.id, record_type: 'snag', data: { record_code: `SV-${U}-${randomBytes(2).toString('hex')}`, description: 'Loose cover', severity, stage: 'CW QC' } });
    const typed = await mk('critical');
    expect(typed.status).toBe(201);
    expect(typed.body.data.severity).toBe('CRITICAL');
    expect((await mk('Minor')).body.data.severity).toBe('MINOR');
    expect((await mk('HUGE')).status).toBe(422);
  });

  it('a severity the admin deactivates leaves the register list at once; an old text that names no code stays readable', async () => {
    const cur = await admin.call('get', '/snag-severities');
    const items = (cur.body.items as { code: string; name_en: string; name_ar: string | null; blocks: boolean; is_active: boolean }[])
      .map(({ code, name_en, name_ar, blocks, is_active }) => ({ code, name_en, name_ar, blocks, is_active: code === `COSM${U}` ? false : is_active }));
    const off = await admin.call('put', '/snag-severities', { reason: 'q260 test', items }, { 'If-Match': String(cur.headers.etag) });
    expect(off.status).toBe(200);
    const cat = await admin.call('get', '/list-catalogues/Severity');
    expect((cat.body.values as { code: string; is_active: boolean }[]).find((v) => v.code === `COSM${U}`)).toMatchObject({ is_active: false });
    const { e, site } = await team();
    // a draft can still be saved with it, but it cannot be submitted with a deactivated value
    const draft = await e.api.call('post', recPath('quality'), { site_id: site.id, record_type: 'snag', data: { record_code: `SV2-${U}`, description: 'x', severity: `COSM${U}`, stage: 'CW QC' } });
    expect(draft.status).toBe(201);
    const refused = await post(e.api, 'quality', draft.body.id, 'submit', draft.body.version);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/data/severity' })]));
    // an old record whose text is not a code (it could not be mapped) is still read as it was written
    const old = (await q<{ id: string }>(`INSERT INTO register_records (entity_id, version_no, is_current, register_key, record_type, site_id, region_id, state, current_level, levels_required, data, approved_at, created_by)
      SELECT gen_random_uuid(), 1, true, 'quality', 'snag', s.id, s.region_id, 'approved', 2, 2, $2::jsonb, now(), $3::uuid FROM sites s WHERE s.id = $1 RETURNING id::text`,
      [site.id, JSON.stringify({ record_code: `OLD-${U}-HI`, stage: 'CW QC', severity: 'High', description: 'old' }), e.user.id]))[0]!;
    const read = await admin.call('get', recPath('quality', old.id));
    expect(read.status).toBe(200);
    expect(read.body.data.severity).toBe('High');
    // restore the snag severity for the tests that follow
    const back = await admin.call('put', '/snag-severities', { reason: 'q260 test', items: items.map((x) => (x.code === `COSM${U}` ? { ...x, is_active: true } : x)) }, { 'If-Match': String(off.headers.etag) });
    expect(back.status).toBe(200);
  });
});

describe('Q265: accepting pending evidence needs step-up, rejecting does not', () => {
  it('an L2 without a fresh step-up cannot accept (401) but can reject; after the step-up the acceptance works and is audited with it', async () => {
    const { e, a, i, site } = await team();
    const a2 = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve'), stepUp: false });
    await regCell(db, 'quality', R, 'approve', { user: [a.user.id, a2.user.id] });
    const r = await i.api.call('post', `/sites/${site.id}/snags`, { snag_type_id: generalType, scope: 'CW', title: 'Cable tray cover', severity: 'MAJOR' });
    const f1 = await photo(e, r.body.id, jpegWithExif(exifText(new Date(Date.now() + 5 * 86400000))));
    const f2 = await photo(e, r.body.id, jpegWithExif(exifText(new Date(Date.now() + 6 * 86400000))));
    expect([f1.body.status, f2.body.status]).toEqual(['pending_evidence', 'pending_evidence']);
    const ev = (who: Actor, photoId: string, decision: string) => who.api.call('post', `/snags/${r.body.id}/photos/${photoId}/evidence`, { decision, note: 'checked on site' });
    // no step-up: the acceptance is refused, nothing changed
    const noStep = await ev(a2, f1.body.id, 'accept');
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await snag(a, r.body.id)).photos.find((p) => p.id === f1.body.id)!.status).toBe('pending_evidence');
    // rejecting needs none
    const rej = await ev(a2, f2.body.id, 'reject');
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.photos.find((p: { id: string }) => p.id === f2.body.id)).toMatchObject({ status: 'rejected' });
    // someone who is not L2 of the snag is refused (403), step-up or not
    const stranger = await actor(app, db, { level: 'approve', regions: [R], grants: G('quality', 'view', 'approve') });
    expect((await ev(stranger, f1.body.id, 'accept')).status).toBe(403);
    expect((await ev(e, f1.body.id, 'accept')).body.code).toBe('self_approval_forbidden');
    // after the step-up the acceptance works
    expect((await a2.api.stepUp(a2.user.password)).status).toBe(200);
    const ok = await ev(a2, f1.body.id, 'accept');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.photos.find((p: { id: string }) => p.id === f1.body.id)).toMatchObject({ status: 'accepted' });
    const audit = await q<{ after: { stepup_verified?: boolean } }>(`SELECT after FROM audit_log WHERE action = 'snag_evidence_accept' AND entity_id = $1`, [r.body.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after.stepup_verified).toBe(true);
    // the old four-argument function is gone: one function is left, and a call without the flag defaults to "no step-up"
    expect(await q<{ pronargs: number; has_default: boolean }>(`SELECT pronargs, pronargdefaults > 0 AS has_default FROM pg_proc WHERE proname = 'qc_decide_evidence'`)).toEqual([{ pronargs: 5, has_default: true }]);
  });
});

describe('Q267: a System Admin cancels an approved Quality snag record entered by mistake', () => {
  const newRec = async (who: Actor, siteId: string, data: Record<string, unknown> = {}) => {
    const r = await who.api.call('post', recPath('quality'), { site_id: siteId, record_type: 'snag', data: { record_code: `CX-${U}-${randomBytes(2).toString('hex')}`, description: 'Entered by mistake', severity: 'MAJOR', stage: 'CW QC', ...data } });
    expect(r.status).toBe(201);
    return r.body as { id: string; entity_id: string; version: number };
  };
  const approved = async (e: Actor, a: Actor, siteId: string) => {
    const rec = await newRec(e, siteId);
    const sub = await post(e.api, 'quality', rec.id, 'submit', rec.version);
    expect(sub.status).toBe(200);
    const ok = await post(a.api, 'quality', rec.id, 'approve', sub.body.version);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    return { ...rec, version: ok.body.version as number, snagId: ok.body.qc_snag.id as string };
  };
  const cancel = (who: Actor, id: string, version: number | null, body: unknown = { reason: 'entered by mistake' }) =>
    who.api.call('post', recPath('quality', id, '/cancel-snag'), body, version === null ? {} : ifm(version));

  it('is refused to everyone but a System Admin (403), needs step-up (401), a reason (422) and the current version (412, 428)', async () => {
    const { e, a, site } = await team();
    const rec = await approved(e, a, site.id);
    // the people of the register cannot do it, the approver included
    expect((await cancel(e, rec.id, rec.version)).status).toBe(403);
    const denied = await cancel(a, rec.id, rec.version);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    expect((await e.api.call('get', recPath('quality', rec.id))).body.allowed_actions).not.toContain('cancel_snag');
    // an admin without a fresh step-up
    const soft = await plainAdmin(app, db, false);
    expect((await soft.api.call('get', recPath('quality', rec.id))).body.allowed_actions).toContain('cancel_snag');
    const noStep = await cancel(soft, rec.id, rec.version);
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await soft.api.stepUp(soft.user.password)).status).toBe(200);
    expect((await cancel(soft, rec.id, rec.version, {})).status).toBe(422);
    expect((await cancel(soft, rec.id, rec.version, { reason: 'x' })).status).toBe(422);
    expect((await cancel(soft, rec.id, rec.version, { reason: 'entered by mistake', extra: 1 })).status).toBe(422);
    expect((await cancel(soft, rec.id, rec.version + 5)).status).toBe(412);
    expect((await cancel(soft, rec.id, null)).status).toBe(428);
    // nothing happened
    expect((await snag(e, rec.snagId)).state).toBe('open');
    expect((await admin.call('get', recPath('quality', rec.id))).body.state).toBe('approved');
  });

  it('voids the record and cancels its QC snag with it: audited with before and after, the PAC is released, and it cannot be done twice', async () => {
    const { e, a, site } = await team();
    const boss = await plainAdmin(app, db, true);
    const pac = await makeTask(db, site, 'B13', 'entry', { actualDate: '2026-01-05' });
    const rec = await approved(e, a, site.id);
    expect((await admin.call('get', `/tasks/${pac}`)).body.lock_reasons).toEqual([expect.objectContaining({ kind: 'open_snags', count: 1 })]);
    const res = await cancel(boss, rec.id, rec.version, { reason: 'Duplicate of another snag, entered by mistake' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: 'voided', is_current: false, qc_snag: { id: rec.snagId, state: 'cancelled' } });
    expect(res.body.allowed_actions).not.toContain('cancel_snag');
    // the QC snag is cancelled with the reason, and no longer blocks the PAC
    const s = (await e.api.call('get', `/snags/${rec.snagId}`)).body;
    expect(s).toMatchObject({ state: 'cancelled', cancel_reason: 'Duplicate of another snag, entered by mistake' });
    expect((await admin.call('get', `/tasks/${pac}`)).body.lock_reasons).toEqual([]);
    // audited with before and after, the actor and the reason; the history of the record shows the step
    const au = await q<{ before: { state: string }; after: { state: string; qc_snag_id: string; stepup_verified: boolean }; reason: string; actor_id: string }>(
      `SELECT before, after, reason, actor_id::text FROM audit_log WHERE action = 'register_record_cancel_snag' AND entity_id = $1`, [rec.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ before: { state: 'approved' }, after: { state: 'voided', qc_snag_id: rec.snagId, stepup_verified: true }, reason: 'Duplicate of another snag, entered by mistake', actor_id: boss.user.id });
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'snag_cancel' AND entity_id = $1`, [rec.snagId])).toHaveLength(1);
    const hist = (await boss.api.call('get', recPath('quality', rec.id, '/history'))).body.items as { action: string; note: string; stepup_verified: boolean }[];
    expect(hist.at(-1)).toMatchObject({ action: 'void', note: 'Duplicate of another snag, entered by mistake', stepup_verified: true });
    // twice is refused
    expect((await cancel(boss, rec.id, res.body.version)).status).toBe(409);
  });

  it('is refused for a draft, for a record with an open newer version and for a record whose QC snag is closed already', async () => {
    const { e, a, site } = await team();
    const boss = await plainAdmin(app, db, true);
    // a draft is voided the normal way
    const draft = await newRec(e, site.id);
    const d = await cancel(boss, draft.id, draft.version);
    expect(d.status).toBe(409);
    expect(d.body.code).toBe('invalid_transition');
    // an open newer version: void it first
    const withNew = await approved(e, a, site.id);
    const nv = await e.api.call('post', recPath('quality', withNew.id, '/versions'), {}, ifm(withNew.version));
    expect(nv.status).toBe(201);
    const o = await cancel(boss, withNew.id, withNew.version);
    expect(o.status).toBe(409);
    expect(o.body.detail).toMatch(/newer version/);
    // a closed QC snag is history: the record stays
    const closed = await approved(e, a, site.id);
    expect((await photo(e, closed.snagId, jpegWithExif(null))).status).toBe(201);
    const s = await snag(e, closed.snagId);
    const sub = await act(e, closed.snagId, 'submit', s.version);
    expect(sub.status).toBe(200);
    expect((await act(a, closed.snagId, 'approve', sub.body.version)).body.state).toBe('closed');
    expect((await boss.api.call('get', recPath('quality', closed.id))).body.allowed_actions).not.toContain('cancel_snag');
    const c = await cancel(boss, closed.id, closed.version);
    expect(c.status).toBe(409);
    expect(c.body.detail).toMatch(/closed already/);
    expect((await boss.api.call('get', recPath('quality', closed.id))).body.state).toBe('approved');
  });
});

describe('Q296: the task fields of the stream templates read the CompletionStatus catalogue', () => {
  const columnOf = async (field: string): Promise<{ options: string[] }> => {
    const cols = (await q<{ columns: { field?: string; options?: string[] }[] }>(
      `SELECT v.columns FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current`))[0]!.columns;
    return cols.find((c) => c.field === field) as { options: string[] };
  };
  const version = async (): Promise<number> => (await q<{ v: number }>(`SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v;

  it('links the Done / Pending / N/A fields to the catalogue and leaves the other lists alone; the mapping screen says so', async () => {
    const rows = await q<{ field_key: string; list_catalogue: string | null; options: string[] }>(`SELECT field_key, list_catalogue, options FROM template_task_fields WHERE field_type = 'list' ORDER BY task_code, field_key`);
    const linked = rows.filter((r) => r.list_catalogue === 'CompletionStatus');
    expect(linked.length).toBeGreaterThanOrEqual(12);
    expect(linked.map((r) => r.field_key)).toEqual(expect.arrayContaining(['v:tower_foundation', 'v:site_gnd', 'v:mts_cabinet', 'v:dc_of_cable']));
    expect(linked.every((r) => JSON.stringify(r.options) === JSON.stringify(['Done', 'Pending', 'N/A']))).toBe(true);
    const others = rows.filter((r) => r.list_catalogue === null);
    expect(others.map((r) => r.field_key)).toEqual(expect.arrayContaining(['v:analysis_type', 'v:cutover_result']));
    const map = await admin.call('get', '/template-mapping');
    expect(map.status).toBe(200);
    expect(map.body.fields.find((f: { field_key: string; list_catalogue: string | null }) => f.field_key === 'v:tower_foundation')).toMatchObject({ list_catalogue: 'CompletionStatus', options: ['Done', 'Pending', 'N/A'] });
    expect(map.body.fields.find((f: { field_key: string; list_catalogue: string | null }) => f.field_key === 'v:analysis_type')).toMatchObject({ list_catalogue: null });
  });

  it('a value added to or deactivated in the catalogue moves the options of those fields and issues the next template version; the options cannot be set apart from the catalogue', async () => {
    const v0 = await version();
    expect((await columnOf('v:tower_foundation')).options).toEqual(['Done', 'Pending', 'N/A']);
    const add = await admin.call('post', '/list-catalogues/CompletionStatus/values', { code: `Blocked${U}`, label_en: 'Blocked', reason: 'q296 test' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await q<{ options: string[] }>(`SELECT options FROM template_task_fields WHERE field_key = 'v:tower_foundation'`))[0]!.options).toEqual(['Done', 'Pending', 'N/A', `Blocked${U}`]);
    expect((await columnOf('v:tower_foundation')).options).toEqual(['Done', 'Pending', 'N/A', `Blocked${U}`]);
    expect(await version()).toBeGreaterThan(v0);
    // a field that does not read the catalogue is untouched
    expect((await q<{ options: string[] }>(`SELECT options FROM template_task_fields WHERE field_key = 'v:analysis_type'`))[0]!.options).toEqual(['STA', 'ST', 'N/A']);
    // the options of a linked field cannot be set apart from the list
    await db.query('BEGIN');
    try {
      await db.query(`UPDATE template_task_fields SET options = '["X", "Y"]'::jsonb WHERE field_key = 'v:tower_foundation'`);
      expect((await q<{ options: string[] }>(`SELECT DISTINCT options FROM template_task_fields WHERE field_key = 'v:tower_foundation'`))[0]!.options).toEqual(['Done', 'Pending', 'N/A', `Blocked${U}`]);
      // a field that stops being a list leaves the catalogue
      await db.query(`UPDATE template_task_fields SET field_type = 'text', options = NULL WHERE field_key = 'v:site_gnd'`);
      expect((await q<{ list_catalogue: string | null }>(`SELECT list_catalogue FROM template_task_fields WHERE field_key = 'v:site_gnd'`))[0]!.list_catalogue).toBeNull();
    } finally {
      await db.query('ROLLBACK');
    }
    const cat = (await admin.call('get', '/list-catalogues/CompletionStatus')).body;
    const v = cat.values.find((x: { code: string }) => x.code === `Blocked${U}`);
    const off = await admin.call('patch', `/list-catalogues/CompletionStatus/values/${v.id}`, { is_active: false, reason: 'q296 test' }, ifm(v.version));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await columnOf('v:tower_foundation')).options).toEqual(['Done', 'Pending', 'N/A']);
  });
});
