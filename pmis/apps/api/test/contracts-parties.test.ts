import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { addContract, partyWithContract, teamOf } from './p4b-helpers';
import { G, GECOL, PROC, approveAll, createRec, patch, post, recPath, regCell, team } from './reg-helpers';
import type { Team } from './reg-helpers';
import { actor, addAssignment, makeSite, plainAdmin } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * Work package P4b (migration 0061): owner answers Q110 and Q142 to Q147 of 2026-11-04 and the owner decision D145b.
 * The match table, the Contractors cells and the Procurement / GECOL cells of region 3 are shared with the other register suites: every test holds
 * the register lock (770101). The match table and the contractor rules are changed only inside this file and always put back.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
const R = 3;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
});
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

const getMatch = (who: Actor = admin) => who.api.call('get', '/settings/team-scope-match');
const putMatch = (who: Actor, version: number, body: unknown) => who.api.call('put', '/settings/team-scope-match', body, { 'If-Match': `"${version}"` });
type Match = { specializations: string[]; scopes: { scope: string; exempt: boolean; allowed: string[]; allowed_groups: string[] }[]; catalogue: { code: string; label_en: string; label_ar: string | null; aliases: string[]; group: string | null }[]; version: number };
const bodyOf = (m: Match) => ({ specializations: m.specializations, scopes: m.scopes.map((s) => ({ scope: s.scope, exempt: s.exempt, allowed: s.allowed, allowed_groups: s.allowed_groups })) });

/** Runs fn and puts the match table back as it was (with a step-up, since the restore may change eligibility). */
async function withMatch(fn: (m: Match) => Promise<void>): Promise<void> {
  const before = (await getMatch()).body as Match;
  try {
    await fn(before);
  } finally {
    await admin.api.stepUp(admin.user.password);
    const cur = (await getMatch()).body as Match;
    const r = await putMatch(admin, cur.version, { reason: 'test: back as it was', ...bodyOf(before),
      catalogue: before.catalogue.filter((c) => before.specializations.includes(c.code)).map((c) => ({ code: c.code, label_en: c.label_en, label_ar: c.label_ar, group: c.group, aliases: c.aliases })) });
    expect(r.status).toBe(200);
  }
}

/** The global cells of the Contractors register row (it has no region), and its three holders. */
async function contractorsTeam(): Promise<Team> {
  const entry = await actor(app, db, { level: 'entry', grants: G('contractors', 'view', 'create', 'edit'), regions: [R], modules: null });
  const review = await actor(app, db, { level: 'review', grants: G('contractors', 'view'), regions: [R], modules: null });
  const approve = await actor(app, db, { level: 'approve', grants: G('contractors', 'view', 'approve'), regions: [R], modules: null });
  for (const [kind, u] of [[1, entry], [2, review], [3, approve]] as const) {
    await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id IS NULL', ['contractors', kind]);
    const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('contractors', $1, 'any_one'::"MatrixRule", NULL, true, now()) RETURNING id`, [kind]);
    await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user'::"AssigneeKind", $2)`, [c.rows[0].id, u.user.id]);
  }
  return { entry, review, approve, site: undefined as never, region: R, key: 'contractors' };
}

/** Submits and approves, following the record's level count. */
async function approveFlex(t: Team, id: string, version: number): Promise<{ status: number; body: Record<string, any> }> {
  let res = await post(t.entry.api, t.key, id, 'submit', version);
  for (let i = 0; i < 4 && res.status === 200 && res.body.state !== 'approved'; i++) {
    if (res.body.state === 'in_review') res = await post(t.review.api, t.key, id, 'review', res.body.version);
    else {
      await t.approve.api.stepUp(t.approve.user.password);
      res = await post(t.approve.api, t.key, id, 'approve', res.body.version);
    }
  }
  return { status: res.status, body: res.body };
}

const codes = (rows: { code: string }[]) => rows.map((r) => r.code);

// ------------------------------------------------------------------------------------------------------------------- Q143 / Q147
describe('Q143 and Q147: the specialization catalogue and the match table', () => {
  it('holds the 8 agreed codes, the CW / TE groups and the converted rows (CW keeps its meaning as the group CW, HLC needs a Fiber team)', async () => {
    const res = await getMatch();
    expect(res.status).toBe(200);
    expect(res.body.can_edit).toBe(true);
    expect(res.body.groups).toEqual(['CW', 'TE']);
    expect(res.body.catalogue.slice(0, 8).map((c: { label_en: string }) => c.label_en)).toEqual(['Tower RT', 'Tower GF', 'Adaption', 'TE', 'Dismantle', 'GECOL', 'Fiber', 'Survey']);
    const row = (s: string) => res.body.scopes.find((x: { scope: string }) => x.scope === s);
    expect(row('CW')).toMatchObject({ allowed: [], allowed_groups: ['CW'] });
    expect(row('TE Installation')).toMatchObject({ allowed: ['TE'] });
    expect(row('HLC')).toMatchObject({ exempt: true, allowed: ['FIBER'] });
    expect(row('GECOL').allowed).toContain('GECOL');
    expect(row('TE Dismantle')).toMatchObject({ allowed: expect.arrayContaining(['TE', 'DISMANTLE']), allowed_groups: ['CW'] });
    // the Contractors team field offers the catalogue labels
    const f = await q<{ options: string[] }>(db, `SELECT options FROM register_fields WHERE register_key = 'contractors' AND code = 'specialization'`);
    expect(f[0]!.options).toEqual(['Tower RT', 'Tower GF', 'Adaption', 'TE', 'Dismantle', 'GECOL', 'Fiber', 'Survey']);
  });

  it('Q147: Procurement and Contractors read the table read-only; others are refused; only admin.settings edit for all regions saves', async () => {
    const proc = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    const read = await getMatch(proc);
    expect(read.status).toBe(200);
    expect(read.body.can_edit).toBe(false);
    expect((await getMatch(await actor(app, db, { grants: G('contractors', 'view'), regions: [R], modules: null }))).status).toBe(200);
    const other = await getMatch(await actor(app, db, { grants: G('gecol', 'view'), regions: [R], modules: null }));
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('module_forbidden');
    const w = await putMatch(proc, read.body.version, { reason: 'Procurement may not change it', ...bodyOf(read.body) });
    expect(w.status).toBe(403);
  });

  it('Q147: a change that affects eligibility needs a fresh step-up; a label change does not; the save is audited through log_audit_write', async () => {
    await withMatch(async (m) => {
      const noStep = await plainAdmin(app, db, false);
      const narrower = { ...bodyOf(m), scopes: bodyOf(m).scopes.map((s) => (s.scope === 'Tower Erection' ? { ...s, allowed: ['TOWER_RT', 'TOWER_GF'], allowed_groups: [] } : s)) };
      const refused = await putMatch(noStep, m.version, { reason: 'Tower orders for tower teams only', ...narrower });
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('step_up_required');
      expect((await getMatch()).body.version).toBe(m.version);   // nothing was written
      // a label (Arabic) only: no step-up
      const label = await putMatch(noStep, m.version, { reason: 'Arabic label', ...bodyOf(m), catalogue: [{ code: 'SURVEY', label_en: 'Survey', label_ar: 'مسح الموقع' }] });
      expect(label.status).toBe(200);
      expect(label.body.catalogue.find((c: { code: string }) => c.code === 'SURVEY').label_ar).toBe('مسح الموقع');
      await noStep.api.stepUp(noStep.user.password);
      const ok = await putMatch(noStep, label.body.version, { reason: 'Tower orders for tower teams only', ...narrower });
      expect(ok.status).toBe(200);
      expect(ok.body.scopes.find((s: { scope: string }) => s.scope === 'Tower Erection')).toMatchObject({ allowed: ['TOWER_RT', 'TOWER_GF'], allowed_groups: [] });
      const au = await q<{ actor_id: string; reason: string; before: Match; after: Match }>(db,
        `SELECT actor_id, reason, before, after FROM audit_log WHERE action = 'team_scope_match_update' ORDER BY id DESC LIMIT 1`);
      expect(au[0]).toMatchObject({ actor_id: noStep.user.id, reason: 'Tower orders for tower teams only' });
      expect(au[0]!.before.scopes.find((s) => s.scope === 'Tower Erection')!.allowed_groups).toEqual(['CW']);
    });
  });

  it('Q143: a group is not a column, a name belongs to one code, and an alias maps an old name to its code (no text compare)', async () => {
    await withMatch(async (m) => {
      await admin.api.stepUp(admin.user.password);
      const grp = await putMatch(admin, m.version, { reason: 'CW as a column', ...bodyOf(m), specializations: [...m.specializations, 'CW'] });
      expect(grp.status).toBe(422);
      expect(grp.body.errors[0]).toMatchObject({ code: 'is_a_group' });
      const clash = await putMatch(admin, m.version, { reason: 'clash', ...bodyOf(m), catalogue: [{ code: 'TOWER_RT', label_en: 'Tower RT', aliases: ['Tower GF'] }] });
      expect(clash.status).toBe(422);
      expect(clash.body.errors.map((e: { code: string }) => e.code)).toContain('name_clash');
      // an alias: an old team whose text is "Rooftop Tower" is a Tower RT team
      const party = await partyWithContract(db);
      const old = await teamOf(db, party, { legacy: 'Rooftop Tower' });
      expect((await q<{ p: { message: string } }>(db, `SELECT team_scope_problem('Tower Erection', $1) AS p`, [old]))[0]!.p.message).toMatch(/no specialization of the catalogue/);
      const ok = await putMatch(admin, m.version, { reason: 'old name of the rooftop teams', ...bodyOf(m), catalogue: [{ code: 'TOWER_RT', label_en: 'Tower RT', aliases: ['Rooftop Tower'] }] });
      expect(ok.status).toBe(200);
      expect((await q<{ c: string[] }>(db, 'SELECT team_spec_codes($1) AS c', [old]))[0]!.c).toEqual(['TOWER_RT']);
      expect((await q<{ p: unknown }>(db, `SELECT team_scope_problem('Tower Erection', $1) AS p`, [old]))[0]!.p).toBeNull();
      // a team may hold several specializations: one of them is enough
      const multi = await teamOf(db, party, { codes: ['SURVEY', 'TE'] });
      expect((await q<{ p: unknown }>(db, `SELECT team_scope_problem('TE Installation', $1) AS p`, [multi]))[0]!.p).toBeNull();
      expect((await q<{ p: { message: string } }>(db, `SELECT team_scope_problem('CW', $1) AS p`, [multi]))[0]!.p.message).toMatch(/TE, Survey team/);
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------- Q142 / Q110
describe('Q142 and Q110: teams, companies and contracts in the Contractors register', () => {
  let t: Team;
  beforeEach(async () => {
    t ??= await contractorsTeam();
  });
  const create = (body: Record<string, unknown>) => t.entry.api.call('post', recPath('contractors'), body);

  async function company(name: string, companyType: string): Promise<string> {
    const co = await create({ record_type: 'company', data: { contractor_name: name, company_type: companyType } });
    expect(co.status).toBe(201);
    const done = await approveFlex(t, co.body.id, co.body.version);
    expect(done.status).toBe(200);
    return done.body.entity_id as string;
  }

  it('Q142: a team is saved as a draft without a specialization; submit needs one unless the team is inactive', async () => {
    const party = await company(`Spec Co ${Date.now()}`, 'CW Contractor');
    const draft = await create({ record_type: 'team', data: { team_name: 'No spec', contractor: (await q<{ name: string }>(db, 'SELECT name FROM external_parties WHERE id = $1', [party]))[0]!.name } });
    expect(draft.status).toBe(201);
    expect(draft.body.external_party?.id).toBe(party);   // Q110: linked by id at once (the name is unique)
    const sub = await post(t.entry.api, 'contractors', draft.body.id, 'submit', draft.body.version);
    expect(sub.status).toBe(422);
    expect(sub.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/data/specialization', code: 'specialization_required' })]));
    const inactive = await create({ record_type: 'team', external_party_id: party, data: { team_name: 'Old inactive', team_status: 'Inactive' } });
    expect(inactive.status).toBe(201);
    expect(inactive.body.data.contractor).toBeTruthy();   // the name follows the id
    expect((await post(t.entry.api, 'contractors', inactive.body.id, 'submit', inactive.body.version)).status).toBe(200);
  });

  it('Q143: several specializations by name or alias, normalised; an unknown one is refused; approval writes the codes, certificate and lead', async () => {
    const name = `Multi Co ${Date.now()}`;
    const party = await company(name, 'CW Contractor');
    const bad = await create({ record_type: 'team', external_party_id: party, data: { team_name: 'Bad', specialization: 'Tower RT', more_specializations: 'Fiber, Painting' } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: '/data/more_specializations', code: 'unknown_specialization' });
    const lead = await actor(app, db, { grants: G('contractors', 'view'), regions: [R], modules: null });
    const ok = await create({ record_type: 'team', external_party_id: party,
      data: { team_name: 'Multi', specialization: 'Tower RT', more_specializations: 'fiber ; SURVEY, tower rt', safety_cert_expiry: '2027-03-01', team_lead_user: lead.user.id } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.more_specializations).toBe('Fiber, Survey');
    const done = await approveFlex(t, ok.body.id, ok.body.version);
    expect(done.status).toBe(200);
    const et = await q<{ party_id: string; specialization: string; safety_cert_expiry: string; lead_user_id: string }>(db,
      `SELECT party_id, specialization, safety_cert_expiry::text, lead_user_id FROM external_teams WHERE id = $1`, [done.body.entity_id]);
    expect(et[0]).toMatchObject({ party_id: party, specialization: 'Tower RT, Fiber, Survey', safety_cert_expiry: '2027-03-01', lead_user_id: lead.user.id });
    expect(codes(await q(db, 'SELECT code FROM external_team_specializations WHERE team_id = $1 ORDER BY code', [done.body.entity_id]))).toEqual(['FIBER', 'SURVEY', 'TOWER_RT']);
    // the old group text CW is not a specialization (the field offers the catalogue labels only)
    // (since 0057 CW is an inactive value of the TeamSpecialization list: a draft keeps it, the submit refuses it with this reason)
    const grp = await create({ record_type: 'team', external_party_id: party, data: { team_name: 'Group', specialization: 'CW' } });
    expect(grp.status).toBe(201);
    const grpSub = await post(t.entry.api, 'contractors', grp.body.id, 'submit', grp.body.version);
    expect(grpSub.status).toBe(422);
    expect(grpSub.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/data/specialization', code: 'unknown_specialization' })]));
  });

  it('Q110: an explicit type mapping; an unknown type becomes other with a review alert to the System Admins', async () => {
    const known = await company(`Mapped Co ${Date.now()}`, 'cw-contractor');
    expect((await q<{ type: string; type_review: boolean }>(db, 'SELECT type::text, type_review FROM external_parties WHERE id = $1', [known]))[0]).toEqual({ type: 'cw_contractor', type_review: false });
    const unknown = await company(`Odd Co ${Date.now()}`, 'Civil Works House');
    const p = await q<{ type: string; type_review: boolean; company_type: string }>(db, 'SELECT type::text, type_review, company_type FROM external_parties WHERE id = $1', [unknown]);
    expect(p[0]).toEqual({ type: 'other', type_review: true, company_type: 'Civil Works House' });   // the original value is kept
    const n = await q(db, `SELECT 1 FROM notifications WHERE kind = 'party_type_review' AND body LIKE $1`, [`%Civil Works House%`]);
    expect(n.length).toBeGreaterThan(0);
  });

  it('Q110: a team links by party id; an ambiguous name is never linked', async () => {
    const stem = `Twin Co ${Date.now()}`;
    const a = await partyWithContract(db, { name: stem });
    await partyWithContract(db, { name: stem.toUpperCase() });
    const amb = await create({ record_type: 'team', data: { team_name: 'Twin team', contractor: stem.toLowerCase(), specialization: 'TE' } });
    expect(amb.status).toBe(201);
    expect(amb.body.external_party).toBeUndefined();
    const sub = await post(t.entry.api, 'contractors', amb.body.id, 'submit', amb.body.version);
    expect(sub.status).toBe(422);
    expect(sub.body.errors.map((e: { code: string }) => e.code)).toContain('ambiguous_contractor');
    // the id decides; a name that is not the chosen company's is refused
    const byId = await patch(t.entry.api, 'contractors', amb.body.id, amb.body.version, { external_party_id: a, data: { contractor: stem } });
    expect(byId.status).toBe(200);
    expect(byId.body.external_party?.id).toBe(a);
    const third = await partyWithContract(db, { name: `Third Co ${Date.now()}` });
    const wrong = await patch(t.entry.api, 'contractors', amb.body.id, byId.body.version, { external_party_id: third, data: { contractor: stem } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors[0]).toMatchObject({ code: 'contractor_mismatch' });
    const done = await approveFlex(t, amb.body.id, byId.body.version);
    expect(done.status).toBe(200);
    expect((await q<{ party_id: string }>(db, 'SELECT party_id FROM external_teams WHERE id = $1', [done.body.entity_id]))[0]!.party_id).toBe(a);
  });

  it('Q110: a contract is its own record (scopes from the match table, dates, status) and is projected on approval', async () => {
    const name = `Contract Co ${Date.now()}`;
    const party = await company(name, 'CW Contractor');
    const unknownScope = await create({ record_type: 'contract', data: { contractor: name, contract_ref: 'K-1', contract_start: '2026-01-01', contract_scopes: 'CW, Painting' } });
    expect(unknownScope.status).toBe(422);
    expect(unknownScope.body.errors[0]).toMatchObject({ path: '/data/contract_scopes', code: 'unknown_scope' });
    const noRef = await create({ record_type: 'contract', data: { contractor: name, contract_scopes: 'cw' } });
    expect(noRef.status).toBe(201);
    const s1 = await post(t.entry.api, 'contractors', noRef.body.id, 'submit', noRef.body.version);
    expect(s1.body.errors.map((e: { path: string; code: string }) => `${e.path}:${e.code}`)).toEqual(expect.arrayContaining(['/data/contract_ref:required', '/data/contract_start:required']));
    const teamField = await create({ record_type: 'contract', data: { contractor: name, contract_ref: 'K-0', contract_start: '2026-01-01', contract_scopes: 'CW', team_name: 'x' } });
    const s2 = await post(t.entry.api, 'contractors', teamField.body.id, 'submit', teamField.body.version);
    expect(s2.body.errors[0]).toMatchObject({ path: '/data/team_name', code: 'not_applicable' });
    const ok = await create({ record_type: 'contract', data: { contractor: name, contract_ref: 'K-2', contract_start: '2026-01-01', contract_end: '2027-12-31', contract_scopes: 'cw ; tower erection', contract_status: 'Active' } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.contract_scopes).toBe('CW, Tower Erection');
    expect(ok.body.external_party?.id).toBe(party);
    const done = await approveFlex(t, ok.body.id, ok.body.version);
    expect(done.status).toBe(200);
    const c = await q<{ party_id: string; scopes: string[]; end_date: string; status: string; origin: string }>(db,
      'SELECT party_id, scopes, end_date::text, status, origin FROM external_party_contracts WHERE id = $1', [done.body.entity_id]);
    expect(c[0]).toEqual({ party_id: party, scopes: ['CW', 'Tower Erection'], end_date: '2027-12-31', status: 'active', origin: 'contract' });
    // a second contract with the same reference for the same company is refused at submit
    const dup = await create({ record_type: 'contract', data: { contractor: name, contract_ref: 'k-2', contract_start: '2026-02-01', contract_scopes: 'CW' } });
    expect((await post(t.entry.api, 'contractors', dup.body.id, 'submit', dup.body.version)).body.errors[0]).toMatchObject({ code: 'duplicate' });
  });

  it('Q142 and Q110: the completeness report lists teams without a (known) specialization, parties to review and contracts without scope', async () => {
    const party = await partyWithContract(db, { scopes: null });
    await db.query('UPDATE external_parties SET type_review = true WHERE id = $1', [party]);
    const none = await teamOf(db, party, {});
    const legacy = await teamOf(db, party, { legacy: 'CW' });
    const fine = await teamOf(db, party, { codes: ['TE'] });
    const viewer = await actor(app, db, { grants: G('contractors', 'view'), regions: [R], modules: null });
    const res = await viewer.api.call('get', '/reports/contractors-completeness');
    expect(res.status).toBe(200);
    const issues = (id: string) => res.body.teams.find((x: { team_id: string }) => x.team_id === id)?.issues;
    expect(issues(none)).toEqual(['no_specialization']);
    expect(issues(legacy)).toEqual(['unknown_specialization']);
    expect(issues(fine)).toBeUndefined();
    expect(res.body.parties.find((x: { party_id: string }) => x.party_id === party).issues).toEqual(['type_review']);
    expect(res.body.contracts.find((x: { party: { id: string } }) => x.party.id === party).issues).toEqual(['scope_not_specified']);
    expect((await (await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null })).api.call('get', '/reports/contractors-completeness')).status).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------------------------- Procurement
describe('Q110, Q144, Q147 and D145b: Procurement checks the contract, the delivery model and never the certificate', () => {
  let t: Team;
  beforeEach(async () => {
    t ??= await team(app, db, 'procurement', 'procurement', R);
  });
  const submitErr = async (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const rec = await createRec(t, data, extra);
    const res = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    return { res, rec };
  };

  it('Q110: the team\'s company needs an active contract covering the scope on the order date; another active contract keeps it eligible', async () => {
    const party = await partyWithContract(db, { scopes: ['TE Installation'] });
    const tower = await teamOf(db, party, { codes: ['TOWER_RT'] });
    const { res } = await submitErr({ ...PROC, team_id: tower }, { external_party_id: party });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ path: '/data/team_id', code: 'no_active_contract' })]);
    // an expired contract for CW does not help; a second, active one does (the party stays active either way)
    await addContract(db, party, { scopes: ['CW'], start: '2024-01-01', end: '2025-06-30' });
    expect((await submitErr({ ...PROC, team_id: tower }, { external_party_id: party })).res.status).toBe(422);
    await addContract(db, party, { scopes: ['CW'], start: '2025-07-01', end: null });
    const ok = await submitErr({ ...PROC, team_id: tower }, { external_party_id: party });
    expect(ok.res.status).toBe(200);
    const chk = await q<{ match_version: number; specializations: string[]; contract_id: string | null }>(db, 'SELECT match_version, specializations, contract_id FROM team_scope_checks WHERE record_id = $1', [ok.rec.id]);
    expect(chk[0]).toMatchObject({ specializations: ['TOWER_RT'] });
    expect(chk[0]!.contract_id).not.toBeNull();
    expect(chk[0]!.match_version).toBe((await getMatch()).body.version);   // Q145: the version the order was checked under
  });

  it('Q144: HLC needs no team, but a named team must be a Fiber team with a contract for HLC', async () => {
    // the HLC request is entered by the holders of the procurement_hlc row (0042)
    await regCell(db, 'procurement_hlc', R, 'entry', { user: [t.entry.user.id] });
    await regCell(db, 'procurement_hlc', R, 'approve', { user: [t.approve.user.id] });
    const hlcPr = { scope: 'HLC', delivery: 'Outsourced', pr_no: 'HPR-9', pr_date: '2026-01-05', hlc_approval_date: '2026-01-12', order_status: 'Open' };
    expect((await submitErr(hlcPr)).res.status).toBe(200);
    const party = await partyWithContract(db, { scopes: ['CW'] });
    const tower = await teamOf(db, party, { codes: ['TOWER_RT'] });
    const r1 = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, external_party_id: party, data: { ...hlcPr, team_id: tower } });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('team_scope_mismatch');
    const fiber = await teamOf(db, party, { codes: ['FIBER'] });
    const noContract = await submitErr({ ...hlcPr, team_id: fiber }, { external_party_id: party });
    expect(noContract.res.body.errors[0]).toMatchObject({ code: 'no_active_contract' });
    await addContract(db, party, { scopes: ['HLC'] });
    expect((await submitErr({ ...hlcPr, team_id: fiber }, { external_party_id: party })).res.status).toBe(200);
    // a scope missing from the table accepts no team
    expect((await q<{ p: { message: string } }>(db, `SELECT team_scope_problem('Painting', $1) AS p`, [fiber]))[0]!.p.message).toMatch(/not in the team \/ scope match table/);
  });

  it('Q147: CW Delivery Model: Outsourced with its PO / WO needs party and contract; In-House needs a qualified internal team', async () => {
    const order = { ...PROC, po_wo_no: 'PO-P4B', po_wo_date: '2026-01-10' };
    const a = await submitErr(order);
    expect(a.res.body.errors).toEqual([expect.objectContaining({ path: '/external_party_id', code: 'party_required' })]);
    const noC = await partyWithContract(db, { noContract: true });
    expect((await submitErr(order, { external_party_id: noC })).res.body.errors[0]).toMatchObject({ code: 'no_active_contract' });
    const withC = await partyWithContract(db, { scopes: ['CW'] });
    expect((await submitErr(order, { external_party_id: withC })).res.status).toBe(200);
    // a PR without its order yet does not need the party (the party is chosen with the PO / WO)
    expect((await submitErr(PROC)).res.status).toBe(200);
    // In-House
    const inHouse = { scope: 'CW', delivery: 'In-House', po_wo_no: 'WO-P4B', po_wo_date: '2026-01-10', order_status: 'Open' };
    expect((await submitErr(inHouse)).res.body.errors[0]).toMatchObject({ path: '/data/team_id', code: 'internal_team_required' });
    const aljeel = await partyWithContract(db, { noContract: true, type: 'other' });
    const vendorTeam = await teamOf(db, aljeel, { codes: ['ADAPTION'], teamType: 'Subcontractor' });
    expect((await submitErr({ ...inHouse, team_id: vendorTeam })).res.body.errors[0]).toMatchObject({ code: 'not_internal_team' });
    const internal = await teamOf(db, aljeel, { codes: ['ADAPTION'], teamType: 'Internal' });
    expect((await submitErr({ ...inHouse, team_id: internal })).res.status).toBe(200);   // no contract asked for in-house work
    const unqualified = await teamOf(db, aljeel, { codes: ['SURVEY'], teamType: 'Internal' });
    const r = await t.entry.api.call('post', recPath('procurement'), { site_id: t.site.id, data: { ...inHouse, team_id: unqualified } });
    expect(r.body.code).toBe('team_scope_mismatch');
  });

  it('D145b: an expired safety certificate never blocks an order: create, submit and approve go through', async () => {
    const party = await partyWithContract(db, { scopes: ['CW'] });
    const expired = await teamOf(db, party, { codes: ['TOWER_GF'], certExpiry: '2025-01-31' });
    const rec = await createRec(t, { ...PROC, team_id: expired }, { external_party_id: party });
    const done = await approveAll(t, rec.id, rec.version);
    expect(done.state).toBe('approved');
  });
});

// ------------------------------------------------------------------------------------------------------------------- Q146
describe('Q146: a GECOL record is approved only with its party, an active contract and the scope GECOL', () => {
  let g: Team;
  beforeEach(async () => {
    g ??= await team(app, db, 'gecol', 'gecol', R);
  });
  const newSite = async () => {
    const s = await makeSite(db, R, { prefix: 'P4BG' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s.id]);
    return s;
  };
  async function toApproval(data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const s = await newSite();
    const res = await g.entry.api.call('post', recPath('gecol'), { site_id: s.id, data, ...extra });
    expect(res.status).toBe(201);
    const sub = await post(g.entry.api, 'gecol', res.body.id, 'submit', res.body.version);
    expect(sub.status).toBe(200);   // submit is not refused: the check is at approval
    await g.approve.api.stepUp(g.approve.user.password);
    return { id: res.body.id as string, approve: await post(g.approve.api, 'gecol', res.body.id, 'approve', sub.body.version) };
  }

  it('refuses the approval without a party, and with a party that has no contract for GECOL; accepts with one, found by its unique name', async () => {
    const a = await toApproval(GECOL);
    expect(a.approve.status).toBe(422);
    expect(a.approve.body.errors[0]).toMatchObject({ path: '/external_party_id', code: 'gecol_party_required' });
    expect((await q<{ state: string }>(db, 'SELECT state FROM register_records WHERE id = $1', [a.id]))[0]!.state).not.toBe('approved');
    const cwOnly = await partyWithContract(db, { type: 'gecol', scopes: ['CW'] });
    expect((await toApproval(GECOL, { external_party_id: cwOnly })).approve.body.errors[0]).toMatchObject({ code: 'no_active_contract' });
    const name = `GECOL Unit ${Date.now()}`;
    const gp = await partyWithContract(db, { name, type: 'gecol', scopes: ['GECOL'] });
    const ok = await toApproval({ ...GECOL, contractor: name });
    expect(ok.approve.status).toBe(200);
    expect(ok.approve.body.state).toBe('approved');
    expect((await q<{ p: string }>(db, 'SELECT external_party_id AS p FROM register_records WHERE id = $1', [ok.id]))[0]!.p).toBe(gp);   // linked by id from now on
  });
});

// ------------------------------------------------------------------------------------------------------------------- Q145 / D145b
describe('Q145 and D145b: the mismatch report and the daily alerts', () => {
  let t: Team;
  let role: { id: string; code: string };
  let rulesBefore: Record<string, unknown>;
  beforeAll(async () => {
    const r = await q<{ id: string; code: string }>(db, `INSERT INTO roles (code, name_en, can_hold_matrix_levels) VALUES ('P4B_PROC_' || substr(md5(random()::text), 1, 6), 'P4B Procurement', false) RETURNING id, code`);
    role = r[0]!;
  });
  beforeEach(async () => {
    t ??= await team(app, db, 'procurement', 'procurement', R);
  });
  const getRules = () => admin.api.call('get', '/settings/contractor-rules');
  const putRules = (who: Actor, version: number, body: unknown) => who.api.call('put', '/settings/contractor-rules', body, { 'If-Match': `"${version}"` });
  async function withRules(over: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
    const cur = (await getRules()).body;
    const { version, updated_at: _a, updated_by: _b, ...rest } = cur;
    void _a; void _b;
    rulesBefore = rest;
    await admin.api.stepUp(admin.user.password);
    const set = await putRules(admin, version, { reason: 'test rules', ...rest, ...over });
    expect(set.status).toBe(200);
    try {
      await fn();
    } finally {
      await admin.api.stepUp(admin.user.password);
      const now = (await getRules()).body;
      expect((await putRules(admin, now.version, { reason: 'test: back', ...rulesBefore })).status).toBe(200);
    }
  }

  it('the rules: validated field by field; the CW Delivery Model scopes need a step-up, the lead days do not', async () => {
    const cur = (await getRules()).body;
    expect(cur).toMatchObject({ safety_cert_lead_days: 30, recipient_roles: ['PROC_TEAM'], cw_delivery_scopes: ['CW', 'Tower Erection', 'Site Adaption', 'CW Dismantle'] });
    const { version, updated_at: _a, updated_by: _b, ...rest } = cur;
    void _a; void _b;
    const noStep = await plainAdmin(app, db, false);
    expect((await putRules(noStep, version, { reason: 'x', ...rest, colour: 'red' })).status).toBe(422);
    const badRole = await putRules(noStep, version, { reason: 'bad role', ...rest, recipient_roles: ['NO_SUCH_ROLE'] });    expect(badRole.body.errors[0]).toMatchObject({ path: '/recipient_roles', code: 'unknown_role' });
    expect((await putRules(noStep, version, { reason: 'narrow', ...rest, cw_delivery_scopes: ['CW'] })).body.code).toBe('step_up_required');
    const lead = await putRules(noStep, version, { reason: 'longer notice', ...rest, safety_cert_lead_days: 45 });
    expect(lead.status).toBe(200);
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'contractor_rules_update' AND actor_id = $1`, [noStep.user.id])).length).toBe(1);
    expect((await putRules(noStep, lead.body.version, { reason: 'back', ...rest })).status).toBe(200);
    expect((await (await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null })).api.call('get', '/settings/contractor-rules')).status).toBe(403);
  });

  it('Q145: a running order whose team no longer matches, or whose site is under Stop Work, is listed for Procurement of its region and alerted once', async () => {
    const party = await partyWithContract(db, { scopes: ['CW'] });
    const tm = await teamOf(db, party, { codes: ['ADAPTION'] });
    const rec = await createRec(t, { ...PROC, team_id: tm }, { external_party_id: party });
    const done = await approveAll(t, rec.id, rec.version);
    expect(done.state).toBe('approved');
    // the qualification changes after the approval: the approved order is kept as it is, and listed
    await db.query(`DELETE FROM external_team_specializations WHERE team_id = $1`, [tm]);
    await db.query(`INSERT INTO external_team_specializations (team_id, code) VALUES ($1, 'SURVEY')`, [tm]);
    const ptw = (await q<{ code: string }>(db, `SELECT code FROM permit_types WHERE kind = 'ptw' AND is_active ORDER BY code LIMIT 1`))[0]!.code;
    await db.query(`INSERT INTO permit_records (site_id, region_id, permit_type, status, valid_from, valid_to, stop_work) VALUES ($1, $2, $3, 'Approved', '2025-12-01', '2034-12-31', true)`, [t.site.id, R, ptw]);
    const viewer = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    const rep = await viewer.api.call('get', '/reports/team-scope-mismatch');
    expect(rep.status).toBe(200);
    const row = rep.body.items.find((x: { entity_id: string }) => x.entity_id === done.entity_id);
    expect(row.problems.map((p: { code: string }) => p.code)).toEqual(['specialization_mismatch', 'stop_work']);
    expect(row).toMatchObject({ scope: 'CW', team: { id: tm }, party: { id: party } });
    expect(row.checked_match_version).toBeGreaterThan(0);
    expect((await q<{ state: string }>(db, 'SELECT state FROM register_records WHERE id = $1', [done.id]))[0]!.state).toBe('approved');   // never changed
    // another region's Procurement does not see it
    const away = await actor(app, db, { grants: G('procurement', 'view'), regions: [R + 1], modules: null });
    expect((await away.api.call('get', '/reports/team-scope-mismatch')).body.items.some((x: { entity_id: string }) => x.entity_id === done.entity_id)).toBe(false);
    expect((await (await actor(app, db, { grants: G('gecol', 'view'), regions: [R], modules: null })).api.call('get', '/reports/team-scope-mismatch')).status).toBe(403);

    // the daily alert: once per order and problem, to the holders of the recipient roles in the order's region
    const proc = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    await addAssignment(db, proc.user.id, { roleId: role.id, regions: [R], grants: G('procurement', 'view') });
    const far = await actor(app, db, { grants: G('procurement', 'view'), regions: [R + 1], modules: null });
    await addAssignment(db, far.user.id, { roleId: role.id, regions: [R + 1], grants: G('procurement', 'view') });
    await withRules({ recipient_roles: [role.code] }, async () => {
      await q(db, 'SELECT contractors_daily_alerts()');
      const mine = await q<{ body: string; link: string }>(db, `SELECT body, link FROM notifications WHERE user_id = $1 AND kind = 'order_team_mismatch' AND link = $2`, [proc.user.id, `/registers/procurement/records/${done.id}`]);
      expect(mine.length).toBe(2);
      expect((await q(db, `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'order_team_mismatch' AND link = $2`, [far.user.id, `/registers/procurement/records/${done.id}`])).length).toBe(0);
      await q(db, 'SELECT contractors_daily_alerts()');
      expect((await q(db, `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'order_team_mismatch' AND link = $2`, [proc.user.id, `/registers/procurement/records/${done.id}`])).length).toBe(2);
    });
  });

  it('D145b: the certificate alert goes to the team lead and Procurement within the lead days and again once expired, as information', async () => {
    const lead = await actor(app, db, { grants: G('contractors', 'view'), regions: [R], modules: null });
    const proc = await actor(app, db, { grants: G('procurement', 'view'), regions: [R], modules: null });
    await addAssignment(db, proc.user.id, { roleId: role.id, regions: [R], grants: G('procurement', 'view') });
    const party = await partyWithContract(db, { scopes: ['CW'] });
    const today = (await q<{ d: string }>(db, 'SELECT cal_today()::text AS d'))[0]!.d;
    const add = (n: number) => (await_d(today, n));
    const soon = await teamOf(db, party, { codes: ['TE'], certExpiry: add(10), lead: lead.user.id });
    const later = await teamOf(db, party, { codes: ['TE'], certExpiry: add(40), lead: lead.user.id });
    const gone = await teamOf(db, party, { codes: ['TE'], certExpiry: add(-2), lead: lead.user.id });
    const certFor = async (u: string, teamName: string) => q<{ title: string; body: string }>(db,
      `SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'team_safety_cert' AND body LIKE $2`, [u, `${teamName}%`]);
    const name = async (id: string) => (await q<{ name: string }>(db, 'SELECT name FROM external_teams WHERE id = $1', [id]))[0]!.name;
    await withRules({ recipient_roles: [role.code], safety_cert_lead_days: 30 }, async () => {
      await q(db, 'SELECT contractors_daily_alerts()');
      expect((await certFor(lead.user.id, await name(soon)))[0]!.title).toBe('A team safety certificate expires soon');
      expect((await certFor(proc.user.id, await name(soon))).length).toBe(1);
      expect((await certFor(lead.user.id, await name(gone)))[0]!.title).toBe('A team safety certificate has expired');
      expect((await certFor(lead.user.id, await name(later))).length).toBe(0);   // beyond the lead time
      expect((await certFor(lead.user.id, await name(soon)))[0]!.body).toMatch(/Information only/);
      await q(db, 'SELECT contractors_daily_alerts()');   // idempotent
      expect((await certFor(lead.user.id, await name(soon))).length).toBe(1);
    });
    // a longer lead time (the setting) reaches the later one
    await withRules({ recipient_roles: [role.code], safety_cert_lead_days: 60 }, async () => {
      await q(db, 'SELECT contractors_daily_alerts()');
      expect((await certFor(lead.user.id, await name(later))).length).toBe(1);
    });
    // and the team can still take an order
    expect((await q<{ p: unknown }>(db, `SELECT team_scope_problem('TE Installation', $1) AS p`, [gone]))[0]!.p).toBeNull();
  });
});

function await_d(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
