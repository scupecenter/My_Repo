import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newSite, q, taskRow, wd } from './calc-helpers';
import { delegate, startApp, superDb } from './helpers';
import { G, PROC, createRec, patch, post, recPath, team } from './reg-helpers';
import type { Team } from './reg-helpers';
import { actor, makeTask, plainAdmin } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * Migration 0043: the gate-lock exempt list (owner decision 2026-11-02, beside Q81 of 0018) and the team specialization / scope match of
 * Procurement (Q97). Nothing here changes the exempt list setting, so the suite runs on the shared database. The match table is changed only inside
 * this file and always put back. Dates are counted in working days from today (wd), so nothing depends on the weekday (Friday and Saturday off).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
});
// Procurement register cells of region 7 are shared with registers.test.ts and the other register suites (same lock).
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const unlock = async (id: string): Promise<string[]> => (await q<{ ids: string[] }>(db, 'SELECT wf_unlock_successors($1) AS ids', [id]))[0]!.ids;
const hold = async (id: string): Promise<string | null> => (await q<{ gate_code: string | null }>(db, 'SELECT gate_code FROM wf_gate_hold($1)', [id]))[0]!.gate_code;

describe('gate-lock exempt list (owner decision 2026-11-02)', () => {
  it('holds C1 to C4 plus D1, B14, B15, D18, E2 and E3 in calc.gate_lock_exempt_tasks', async () => {
    const v = (await q<{ value: string[] }>(db, `SELECT value FROM settings WHERE key = 'calc.gate_lock_exempt_tasks'`))[0]!.value;
    expect(v).toEqual(['C1', 'C2', 'C3', 'C4', 'D1', 'B14', 'B15', 'D18', 'E2', 'E3']);
  });

  it('opens D1 behind the closed gate G5 (no TE permits), while D2 behind the same gate stays locked', async () => {
    const site = await newSite(db);
    const ms4 = await makeTask(db, site, 'MS4', 'approved', { actualDate: await wd(db, -3) });
    const d1 = await makeTask(db, site, 'D1', 'locked');
    expect((await q<{ status: string }>(db, 'SELECT status FROM gate_eval($1, $2)', [site.id, 'G5']))[0]!.status).not.toBe('open');
    expect(await hold(d1)).toBeNull();
    expect(await unlock(ms4)).toEqual([d1]);
    expect((await taskRow(db, site, 'D1')).state).toBe('open');
    // a task of the same stage that is not in the list is still held by the gate
    const other = await newSite(db);
    await makeTask(db, other, 'MS4', 'approved', { actualDate: await wd(db, -3) });
    const d1b = await makeTask(db, other, 'D1', 'approved', { actualDate: await wd(db, -2) });
    await makeTask(db, other, 'D2', 'locked');
    expect(await unlock(d1b)).toEqual([]);
    const d2 = await taskRow(db, other, 'D2');
    expect(d2.state).toBe('locked');
    expect(d2.lock_reason).toBe('gate_closed:G5');
  });

  it('opens the DLP / FAC tasks (B14, B15, D18) and the dismantle tasks (E2, E3) behind the closed gate G10, while Z1 stays held', async () => {
    const site = await newSite(db);
    const b13 = await makeTask(db, site, 'B13', 'approved', { actualDate: await wd(db, -9) });
    const ms7 = await makeTask(db, site, 'MS7', 'approved', { actualDate: await wd(db, -8) });
    const e1 = await makeTask(db, site, 'E1', 'approved', { actualDate: await wd(db, -7) });
    const b14 = await makeTask(db, site, 'B14', 'locked');
    const d18 = await makeTask(db, site, 'D18', 'locked');
    const e2 = await makeTask(db, site, 'E2', 'locked');
    const z1 = await makeTask(db, site, 'Z1', 'locked');
    // HOTO (MS9) has no date: the gate into Final Closure is not open
    expect((await q<{ status: string }>(db, 'SELECT status FROM gate_eval($1, $2)', [site.id, 'G10']))[0]!.status).not.toBe('open');
    expect(await hold(z1)).toBe('G10');
    for (const id of [b14, d18, e2]) expect(await hold(id)).toBeNull();
    expect(await unlock(b13)).toEqual([b14]);
    expect(await unlock(ms7)).toEqual([d18]);
    expect(await unlock(e1)).toEqual([e2]);
    // the next ones of the chain open the same way once their predecessor is approved
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2 WHERE id = $1`, [b14, await wd(db, -1)]);
    const b15 = await makeTask(db, site, 'B15', 'locked');
    expect(await unlock(b14)).toEqual([b15]);
    await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2 WHERE id = $1`, [e2, await wd(db, -1)]);
    const e3 = await makeTask(db, site, 'E3', 'locked');
    expect(await unlock(e2)).toEqual([e3]);
    for (const c of ['B14', 'B15', 'D18', 'E2', 'E3']) expect((await taskRow(db, site, c)).lock_reason).toBeNull();
    expect((await taskRow(db, site, 'Z1')).state).toBe('locked');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- Q97
const R = 7;
let teamSeq = 0;

/** A contractor and one of its teams, written as the approved projection of the Contractors register would write them. */
async function makeTeam(specialization: string | null): Promise<{ party: string; team: string }> {
  teamSeq += 1;
  const p = await db.query(`INSERT INTO external_parties (name, type) VALUES ($1, 'cw_contractor') RETURNING id`, [`GSM Contractor ${process.pid}-${teamSeq}`]);
  const t = await db.query(`INSERT INTO external_teams (party_id, name, specialization) VALUES ($1, $2, $3) RETURNING id`, [p.rows[0].id, `GSM Team ${teamSeq}`, specialization]);
  return { party: p.rows[0].id as string, team: t.rows[0].id as string };
}

const SEED = {
  specializations: ['CW', 'TE'],
  scopes: [
    { scope: 'CW', exempt: false, allowed: ['CW'] }, { scope: 'Tower Erection', exempt: false, allowed: ['CW'] }, { scope: 'Site Adaption', exempt: false, allowed: ['CW'] },
    { scope: 'TE Installation', exempt: false, allowed: ['TE'] }, { scope: 'CW Dismantle', exempt: false, allowed: ['CW'] }, { scope: 'TE Dismantle', exempt: false, allowed: ['CW', 'TE'] },
    { scope: 'STA', exempt: false, allowed: [] }, { scope: 'ST', exempt: false, allowed: [] }, { scope: 'GECOL', exempt: false, allowed: ['CW'] }, { scope: 'HLC', exempt: true, allowed: [] },
  ],
};

const getMatch = () => admin.api.call('get', '/settings/team-scope-match');
const putMatch = (who: Actor, version: number | string, body: unknown) => who.api.call('put', '/settings/team-scope-match', body, { 'If-Match': `"${version}"` });
/** Puts the seed back (other tests of this file rely on it). */
async function restoreSeed(): Promise<void> {
  const cur = await getMatch();
  const r = await putMatch(admin, cur.body.version, { reason: 'test: back to the seed', ...SEED });
  expect(r.status).toBe(200);
}

describe('Q97: the team / scope match table in Settings', () => {
  it('returns the seed with its version as ETag', async () => {
    const res = await getMatch();
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
    expect(res.body.specializations).toEqual(SEED.specializations);
    expect(res.body.scopes).toEqual(SEED.scopes);
  });

  it('refuses a reader without the Settings screen and a writer without admin.settings edit', async () => {
    const nobody = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    const denied = await nobody.api.call('get', '/settings/team-scope-match');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
    const viewer = await actor(app, db, { grants: G('admin.settings', 'view'), regions: [R], modules: null });
    const read = await viewer.api.call('get', '/settings/team-scope-match');
    expect(read.status).toBe(200);
    const write = await putMatch(viewer, read.body.version, { reason: 'not mine to change', ...SEED });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('action_forbidden');
    // a delegation of admin.settings edit for one region only is not enough: the table applies to every region
    const regional = await actor(app, db, { grants: G('admin.settings', 'view'), regions: [R], modules: null });
    await delegate(db, regional.user.id, G('admin.settings', 'edit'), [R]);
    expect((await putMatch(regional, read.body.version, { reason: 'one region only', ...SEED })).status).toBe(403);
    expect((await getMatch()).body.version).toBe(read.body.version);   // nothing was written
  });

  it('saves with a reason and If-Match, writes an audit row with before and after, and checks the body field by field', async () => {
    const cur = await getMatch();
    expect((await admin.api.call('put', '/settings/team-scope-match', { reason: 'no version', ...SEED })).status).toBe(428);
    expect((await putMatch(admin, cur.body.version + 1, { reason: 'stale', ...SEED })).status).toBe(412);
    const noReason = await putMatch(admin, cur.body.version, { ...SEED });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors.map((e: { path: string }) => e.path)).toContain('/reason');
    const unknownKey = await putMatch(admin, cur.body.version, { reason: 'extra key', ...SEED, colour: 'red' });
    expect(unknownKey.status).toBe(422);
    const badCell = await putMatch(admin, cur.body.version, { reason: 'bad cell', specializations: ['CW'], scopes: [{ scope: 'CW', exempt: false, allowed: ['TE'] }] });
    expect(badCell.status).toBe(422);
    expect(badCell.body.errors[0]).toMatchObject({ path: '/scopes/0/allowed/0', code: 'unknown_specialization' });
    const dup = await putMatch(admin, cur.body.version, { reason: 'twice', specializations: ['CW', 'cw'], scopes: [{ scope: 'CW', allowed: [] }, { scope: 'CW', allowed: [] }] });
    expect(dup.status).toBe(422);
    expect(dup.body.errors.map((e: { code: string }) => e.code)).toEqual(['duplicate', 'duplicate']);

    const changed = { specializations: ['CW', 'TE', 'Civil'], scopes: [...SEED.scopes.slice(0, 1).map((s) => ({ ...s, allowed: ['CW', 'Civil'] })), ...SEED.scopes.slice(1)] };
    try {
      const ok = await putMatch(admin, cur.body.version, { reason: 'Civil teams may take CW orders', ...changed });
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(cur.body.version + 1);
      expect(ok.headers.etag).toBe(`"${cur.body.version + 1}"`);
      expect(ok.body.scopes[0]).toEqual({ scope: 'CW', exempt: false, allowed: ['CW', 'Civil'] });
      expect(ok.body.updated_by).toMatchObject({ id: admin.user.id });
      const au = await q<{ reason: string; actor_id: string; before: { scopes: { allowed: string[] }[] }; after: { specializations: string[] } }>(db,
        `SELECT reason, actor_id, before, after FROM audit_log WHERE action = 'team_scope_match_update' ORDER BY id DESC LIMIT 1`);
      expect(au[0]).toMatchObject({ reason: 'Civil teams may take CW orders', actor_id: admin.user.id });
      expect(au[0]!.before.scopes[0]!.allowed).toEqual(['CW']);
      expect(au[0]!.after.specializations).toEqual(['CW', 'TE', 'Civil']);
      // a delegate of admin.settings edit for all regions may change it too
      const del = await actor(app, db, { grants: G('admin.settings', 'view'), regions: [R], modules: null });
      await delegate(db, del.user.id, G('admin.settings', 'edit'));
      expect((await putMatch(del, ok.body.version, { reason: 'delegate saves', ...changed })).status).toBe(200);
    } finally {
      await restoreSeed();
    }
  });
});

describe('Q97: Procurement refuses a team whose specialization does not match the order scope', () => {
  let t: Team;
  beforeEach(async () => {
    t ??= await team(app, db, 'procurement', 'procurement', R);
  });

  it('refuses a CW team on a TE Installation order at save (422 team_scope_mismatch) and keeps nothing', async () => {
    const cw = await makeTeam('CW');
    const res = await t.entry.api.call('post', recPath('procurement'), {
      site_id: t.site.id, external_party_id: cw.party, data: { scope: 'TE Installation', delivery: 'TE Vendor', order_status: 'Open', team_id: cw.team },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('team_scope_mismatch');
    expect(res.body.detail).toMatch(/CW team .* cannot take a TE Installation order/);
    expect(res.body).toMatchObject({ order_scope: 'TE Installation', team_specialization: 'CW' });
    expect(res.body.errors).toEqual([expect.objectContaining({ path: '/data/team_id', code: 'team_scope_mismatch' })]);
    expect((await q(db, `SELECT 1 FROM register_records WHERE register_key = 'procurement' AND site_id = $1 AND data ->> 'team_id' = $2`, [t.site.id, cw.team])).length).toBe(0);
    // the same refusal when an existing draft is edited to the wrong team
    const draft = await createRec(t, { scope: 'TE Installation', delivery: 'TE Vendor', order_status: 'Open' });
    const edit = await patch(t.entry.api, 'procurement', draft.id, draft.version, { external_party_id: cw.party, data: { team_id: cw.team } });
    expect(edit.status).toBe(422);
    expect(edit.body.code).toBe('team_scope_mismatch');
  });

  it('accepts a matching team (CW on CW, TE on TE Installation, CW or TE on TE Dismantle) and submits it', async () => {
    const cw = await makeTeam('CW');
    const te = await makeTeam(' te ');   // trimmed and case-insensitive
    const ok = await createRec(t, { ...PROC, team_id: cw.team }, { external_party_id: cw.party });
    expect(ok.data.team_id).toBe(cw.team);
    const sub = await post(t.entry.api, 'procurement', ok.id, 'submit', ok.version);
    expect(sub.status).toBe(200);
    expect(sub.body.state).not.toBe('entry');
    await createRec(t, { scope: 'TE Installation', delivery: 'TE Vendor', order_status: 'Open', team_id: te.team }, { external_party_id: te.party });
    await createRec(t, { scope: 'TE Dismantle', delivery: 'Outsourced', order_status: 'Open', team_id: cw.team }, { external_party_id: cw.party });
    await createRec(t, { scope: 'TE Dismantle', delivery: 'Outsourced', order_status: 'Open', team_id: te.team }, { external_party_id: te.party });
    // an order without a team is not checked
    await createRec(t, { scope: 'STA', delivery: 'Outsourced', pr_no: 'PR-STA', pr_date: '2026-01-05', order_status: 'Open' });
  });

  it('refuses a team without a specialization and a team on a scope that accepts none (STA)', async () => {
    const blank = await makeTeam(null);
    const r1 = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, external_party_id: blank.party, data: { ...PROC, team_id: blank.team } });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('team_scope_mismatch');
    expect(r1.body.detail).toMatch(/has no specialization/);
    const cw = await makeTeam('CW');
    const r2 = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, external_party_id: cw.party, data: { scope: 'STA', delivery: 'Outsourced', order_status: 'Open', team_id: cw.team } });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('team_scope_mismatch');
    // HLC is exempt (the HLC request has no contractor team): the check lets any team through
    const p = await q<{ p: unknown }>(db, `SELECT team_scope_problem('HLC', $1) AS p`, [cw.team]);
    expect(p[0]!.p).toBeNull();
    expect((await q<{ p: { message: string } }>(db, `SELECT team_scope_problem('Unknown Scope', $1) AS p`, [cw.team]))[0]!.p.message).toMatch(/not in the team \/ scope match table/);
  });

  it('checks again at submit, so a draft saved before the admin changed the table is refused then', async () => {
    const cw = await makeTeam('CW');
    const draft = await createRec(t, { ...PROC, team_id: cw.team }, { external_party_id: cw.party });
    const cur = await getMatch();
    try {
      const noCw = { specializations: SEED.specializations, scopes: SEED.scopes.map((s) => (s.scope === 'CW' ? { ...s, allowed: ['TE'] } : s)) };
      expect((await putMatch(admin, cur.body.version, { reason: 'CW orders need a TE team for this test', ...noCw })).status).toBe(200);
      const sub = await post(t.entry.api, 'procurement', draft.id, 'submit', draft.version);
      expect(sub.status).toBe(422);
      expect(sub.body.code).toBe('team_scope_mismatch');
      expect((await q<{ state: string }>(db, 'SELECT state FROM register_records WHERE id = $1', [draft.id]))[0]!.state).toBe('entry');   // the draft is kept
    } finally {
      await restoreSeed();
    }
    expect((await post(t.entry.api, 'procurement', draft.id, 'submit', draft.version)).status).toBe(200);
  });
});
