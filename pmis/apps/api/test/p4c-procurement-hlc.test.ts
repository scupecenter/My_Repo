import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allLocked, open, q, taskId, taskRow } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G, GECOL, HLC_PR, PROC, Team, createRec, otherSite, patch, post, recPath, regCell, team } from './reg-helpers';
import { Actor, actor, plainAdmin, setCell } from './wf-helpers';
import { partyWithContract } from './p4b-helpers';

/**
 * Migration 0063 (work package P4c of the owner answers 2026-11-04): Q150 several HLC purchase requests and C3, Q148 execution needs the approved request(s),
 * Q139 the legacy HLC requests into Procurement drafts, Q114 the Dismantle contractor from the Procurement order, Q151 configurable GECOL order warnings.
 * Region 7 and the register-cell lock of the other register suites (770101).
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
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

const R = 7;
/** An HLC execution record with no date (a survey / status only), so no ordering warning of 0042 shows. */
const HLC = { fiber_status: 'Exchange' };
const codesOf = (body: { errors?: { code: string }[] }): string[] => (body.errors ?? []).map((e) => e.code).sort();
// list_other (P5, 0057) flags free-text list values such as the order status; it is not a P4c warning
const warnOf = (body: { warnings?: { code: string }[] }): string[] => (body.warnings ?? []).map((e) => e.code).filter((c) => c !== 'list_other').sort();

interface HlcTeam { proc: Team; hlc: Team; fiber: Team }

async function hlcTeam(fiberGrants: string[] = ['view', 'create', 'edit']): Promise<HlcTeam> {
  const proc = await team(app, db, 'procurement', 'procurement', R);
  const entry = await actor(app, db, { level: 'entry', grants: G('procurement', 'view', 'create', 'edit'), regions: [R], modules: null });
  const approve = await actor(app, db, { level: 'approve', grants: G('procurement', 'view', 'approve'), regions: [R], modules: null });
  await regCell(db, 'procurement_hlc', R, 'entry', { user: [entry.user.id] });
  await regCell(db, 'procurement_hlc', R, 'approve', { user: [approve.user.id] });
  const fiberEntry = await actor(app, db, { level: 'entry', grants: G('hlc', ...fiberGrants), regions: [R], modules: null });
  const fiberApprove = await actor(app, db, { level: 'approve', grants: G('hlc', 'view', 'approve'), regions: [R], modules: null });
  await regCell(db, 'hlc', R, 'entry', { user: [fiberEntry.user.id] });
  await regCell(db, 'hlc', R, 'approve', { user: [fiberApprove.user.id] });
  return {
    proc,
    hlc: { ...proc, entry, review: approve, approve },
    fiber: { key: 'hlc', site: proc.site, region: R, entry: fiberEntry, review: fiberApprove, approve: fiberApprove },
  };
}

async function submit(key: string, l1: Actor, id: string, version: number): Promise<Record<string, any>> {
  const res = await post(l1.api, key, id, 'submit', version);
  if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
async function approveBy(key: string, l2: Actor, id: string, version: number): Promise<Record<string, any>> {
  await l2.api.stepUp(l2.user.password);
  const res = await post(l2.api, key, id, 'approve', version);
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
async function pass(key: string, l1: Actor, l2: Actor, id: string, version: number): Promise<Record<string, any>> {
  const s = await submit(key, l1, id, version);
  return s.state === 'approved' ? s : approveBy(key, l2, id, s.version);
}

/** All tasks locked, Site Release dated, C3 open, and one stage approver on C3 (and C4). */
async function withC3(t: Team, modules: string[] = ['procurement']): Promise<Actor> {
  await allLocked(db, t.site);
  await db.query(`UPDATE task_instances SET state = 'approved', actual_date = DATE '2025-12-01' WHERE id = $1`, [await taskId(db, t.site, 'MS1')]);
  await open(db, await taskId(db, t.site, 'C3'));
  const stage = await actor(app, db, { level: 'approve', grants: modules.flatMap((m) => G(m, 'view', 'approve')), regions: [t.region], modules: null });
  await setCell(db, 'C3', t.region, 'approve', { user: [stage.user.id] });
  await setCell(db, 'C4', t.region, 'approve', { user: [stage.user.id] });
  return stage;
}

const audits = (action: string, id: string) => q(db, `SELECT reason, after FROM audit_log WHERE action = $1 AND entity_id = $2`, [action, id]);

describe('Q150: several HLC purchase requests; C3 closes when every required one is approved by HLC', () => {
  it('waits for the second request, then closes C3 on the latest HLC approval date (never on the first one alone)', async () => {
    const { hlc, fiber } = await hlcTeam();
    const stage = await withC3(hlc);
    const pr1 = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-A', hlc_approval_date: '2026-01-12' });
    const pr2 = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-B', pr_date: '2026-01-06', hlc_approval_date: null });
    // the supplementary request is submitted (no HLC approval yet): it is required
    const s2 = await submit('procurement', hlc.entry, pr2.id, pr2.version);
    const s1 = await submit('procurement', hlc.entry, pr1.id, pr1.version);
    expect(s1.task.task_code).toBe('C3');
    const a1 = await approveBy('procurement', stage, pr1.id, s1.version);
    expect(a1.state).toBe('approved');
    expect((await taskRow(db, hlc.site, 'C3')).state).toBe('open');
    expect((await audits('hlc_c3_waiting', pr1.id)).length).toBe(1);

    // the HLC record sees both: not linked explicitly, and only 1 of 2 approved by HLC
    const rec = await createRec(fiber, HLC);
    expect(warnOf(rec)).toEqual(['hlc_prs_incomplete', 'hlc_prs_not_linked']);
    expect(rec.purchase_requests).toMatchObject({ linked_explicitly: false, complete: false, required: 2, approved_by_hlc: 1 });
    expect(rec.purchase_requests.candidates.map((c: { pr_no: string }) => c.pr_no).sort()).toEqual(['HPR-A', 'HPR-B']);
    expect(rec.data.pr_no).toBe('HPR-A');
    expect(rec.data.hlc_approval_date).toBeUndefined();

    // the second request: approved without its HLC date, then the date in a new version, which is the source of C3 and closes it
    const a2 = await approveBy('procurement', hlc.approve, pr2.id, s2.version);
    expect((await taskRow(db, hlc.site, 'C3')).state).toBe('open');
    const v2 = await post(hlc.entry.api, 'procurement', pr2.id, 'versions', a2.version);
    const v2b = await patch(hlc.entry.api, 'procurement', v2.body.id, v2.body.version, { data: { hlc_approval_date: '2026-01-15' } });
    const s3 = await submit('procurement', hlc.entry, v2.body.id, v2b.body.version);
    expect(s3.task.task_code).toBe('C3');
    await approveBy('procurement', stage, v2.body.id, s3.version);
    expect(await taskRow(db, hlc.site, 'C3')).toMatchObject({ state: 'approved', actual_date: '2026-01-15' });
    const step = await q<{ note: string }>(db, `SELECT note FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [await taskId(db, hlc.site, 'C3')]);
    expect(step[0]!.note).toContain('every HLC purchase request of the scope');

    // the HLC record now links the set: both numbers, the latest approval date, the request that completed it
    const fresh = await patch(fiber.entry.api, 'hlc', rec.id, rec.version, { data: { remark: 'after both' } });
    expect(fresh.body.data).toMatchObject({ pr_no: 'HPR-A, HPR-B', hlc_approval_date: '2026-01-15', procurement_record_id: v2.body.id });
    expect(warnOf(fresh.body)).toEqual(['hlc_prs_not_linked']);
  });

  it('ignores a cancelled request and a draft never submitted; the cancellation completes the scope and closes C3', async () => {
    const { hlc } = await hlcTeam();
    const stage = await withC3(hlc);
    await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-DRAFT' });                          // a draft that was never submitted does not count
    const pr2 = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-X', hlc_approval_date: null });
    const s2 = await submit('procurement', hlc.entry, pr2.id, pr2.version);
    const pr1 = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-Y', hlc_approval_date: '2026-01-10' });
    const s1 = await submit('procurement', hlc.entry, pr1.id, pr1.version);
    await approveBy('procurement', stage, pr1.id, s1.version);
    const a2 = await approveBy('procurement', hlc.approve, pr2.id, s2.version);
    expect((await taskRow(db, hlc.site, 'C3')).state).toBe('open');
    // HPR-X is cancelled in a new version: it leaves the scope, and its approval closes C3 with the date of HPR-Y
    const v2 = await post(hlc.entry.api, 'procurement', pr2.id, 'versions', a2.version);
    const v2b = await patch(hlc.entry.api, 'procurement', v2.body.id, v2.body.version, { data: { order_status: 'Cancelled' } });
    await pass('procurement', hlc.entry, hlc.approve, v2.body.id, v2b.body.version);
    expect(await taskRow(db, hlc.site, 'C3')).toMatchObject({ state: 'approved', actual_date: '2026-01-10' });
  });

  it('lets the HLC record name the requests it covers (only in entry, only HLC requests of the site); its approval closes C3; a new version copies them', async () => {
    const { proc, hlc, fiber } = await hlcTeam();
    const stage = await withC3(hlc, ['procurement', 'hlc']);
    const pr1 = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-1A', hlc_approval_date: '2026-01-11' });
    const s1 = await submit('procurement', hlc.entry, pr1.id, pr1.version);
    const pr2 = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-1B', hlc_approval_date: null });
    await submit('procurement', hlc.entry, pr2.id, pr2.version);                          // waits in approval: required while nothing is named
    await approveBy('procurement', stage, pr1.id, s1.version);
    expect((await taskRow(db, hlc.site, 'C3')).state).toBe('open');

    const rec = await createRec(fiber, HLC);
    const path = recPath('hlc', rec.id, '/purchase-requests');
    const cw = await createRec(proc, PROC);
    const bad = await fiber.entry.api.call('put', path, { procurement_entity_ids: [cw.entity_id] }, { 'If-Match': `"${rec.version}"` });
    expect(bad.status).toBe(422);
    expect(codesOf(bad.body)).toEqual(['not_hlc_pr']);
    expect((await fiber.entry.api.call('put', path, { procurement_entity_ids: [pr1.entity_id] }, { 'If-Match': '"999"' })).status).toBe(412);
    expect((await fiber.approve.api.call('put', path, { procurement_entity_ids: [pr1.entity_id] }, { 'If-Match': `"${rec.version}"` })).status).toBe(403);
    const ok = await fiber.entry.api.call('put', path, { procurement_entity_ids: [pr1.entity_id] }, { 'If-Match': `"${rec.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.purchase_requests).toMatchObject({ linked_explicitly: true, complete: true, required: 1, hlc_approval_date: '2026-01-11' });
    expect(ok.body.data).toMatchObject({ pr_no: 'HPR-1A', hlc_approval_date: '2026-01-11', procurement_record_id: pr1.id });
    expect(warnOf(ok.body)).toEqual([]);
    expect((await audits('hlc_pr_links_set', rec.id)).length).toBe(1);

    const done = await pass('hlc', fiber.entry, fiber.approve, rec.id, ok.body.version);
    expect(done.state).toBe('approved');
    expect(await taskRow(db, hlc.site, 'C3')).toMatchObject({ state: 'approved', actual_date: '2026-01-11' });
    // an approved version keeps its links; a change is a new version, which starts with the same links
    expect((await fiber.entry.api.call('put', path, { procurement_entity_ids: [] }, { 'If-Match': `"${done.version}"` })).status).toBe(409);
    const v2 = await post(fiber.entry.api, 'hlc', rec.id, 'versions', done.version);
    expect(v2.body.purchase_requests.linked_explicitly).toBe(true);
    expect((await q(db, 'SELECT procurement_entity_id FROM hlc_pr_links WHERE hlc_record_id = $1', [v2.body.id])).length).toBe(1);
  });
});

describe('Q148: execution needs the approved HLC purchase request(s); an emergency exception needs the right, a reason and an audited approval', () => {
  it('lets a survey record through without a request, refuses an execution date, and accepts it once the request is approved', async () => {
    const { hlc, fiber } = await hlcTeam();
    const survey = await createRec(fiber, HLC);                                           // no execution date: warning only
    expect(warnOf(survey)).toEqual(['no_approved_hlc_pr']);
    expect((await submit('hlc', fiber.entry, survey.id, survey.version)).state).toBe('in_approval');

    const other = await otherSite(db, fiber);                                             // another site, same holders of the HLC row
    const exec = await fiber.entry.api.call('post', recPath('hlc'), { site_id: other.site.id, data: { ...HLC, installation_date: '2026-01-14' } });
    expect(exec.status).toBe(201);
    const refused = await post(fiber.entry.api, 'hlc', exec.body.id, 'submit', exec.body.version);
    expect(refused.status).toBe(422);
    expect(codesOf(refused.body)).toEqual(['no_approved_hlc_pr']);
    expect(refused.body.errors[0].path).toBe('/data/installation_date');

    // the request of that site is approved by HLC: the execution record goes through
    const pr = await hlc.entry.api.call('post', recPath('procurement'), { site_id: other.site.id, data: HLC_PR });
    await pass('procurement', hlc.entry, hlc.approve, pr.body.id, pr.body.version);
    const done = await pass('hlc', fiber.entry, fiber.approve, exec.body.id, exec.body.version);
    expect(done.state).toBe('approved');
  });

  it('refuses the final approval when a new required request appeared after the submit', async () => {
    const { hlc, fiber } = await hlcTeam();
    await pass('procurement', hlc.entry, hlc.approve, (await createRec(hlc, HLC_PR)).id, 1);
    const rec = await createRec(fiber, { ...HLC, installation_date: '2026-01-14' });
    const s = await submit('hlc', fiber.entry, rec.id, rec.version);
    const more = await createRec(hlc, { ...HLC_PR, pr_no: 'HPR-SUP', hlc_approval_date: null });
    await submit('procurement', hlc.entry, more.id, more.version);
    await fiber.approve.api.stepUp(fiber.approve.user.password);
    const res = await post(fiber.approve.api, 'hlc', rec.id, 'approve', s.version);
    expect(res.status).toBe(422);
    expect(codesOf(res.body)).toEqual(['no_approved_hlc_pr']);
    expect((await q<{ state: string }>(db, 'SELECT state FROM register_records WHERE id = $1', [rec.id]))[0]!.state).toBe('in_approval');
  });

  it('accepts an emergency exception only from a holder of administer on HLC, with a reason; the approval is audited and the reviewer is warned', async () => {
    const plain = await hlcTeam();
    const rec = await createRec(plain.fiber, { ...HLC, installation_date: '2026-01-14', pr_exception: true });
    const noReason = await post(plain.fiber.entry.api, 'hlc', rec.id, 'submit', rec.version);
    expect(codesOf(noReason.body)).toEqual(['pr_exception_forbidden', 'required']);
    const withReason = await patch(plain.fiber.entry.api, 'hlc', rec.id, rec.version, { data: { pr_exception_reason: 'Storm damage: the link must be restored today.' } });
    expect(codesOf((await post(plain.fiber.entry.api, 'hlc', rec.id, 'submit', withReason.body.version)).body)).toEqual(['pr_exception_forbidden']);
    const stray = await createRec(await otherSite(db, plain.fiber), { ...HLC, pr_exception_reason: 'x' });
    expect(codesOf((await post(plain.fiber.entry.api, 'hlc', stray.id, 'submit', stray.version)).body)).toEqual(['not_applicable']);

    const { fiber } = await hlcTeam(['view', 'create', 'edit', 'administer']);
    const ex = await createRec(fiber, { ...HLC, installation_date: '2026-01-14', pr_exception: true, pr_exception_reason: 'Storm damage: the link must be restored today.' });
    expect(warnOf(ex)).toEqual(['no_approved_hlc_pr', 'pr_exception_used']);
    const done = await pass('hlc', fiber.entry, fiber.approve, ex.id, ex.version);
    expect(done.state).toBe('approved');
    const a = await audits('hlc_pr_exception_approved', ex.id);
    expect(a.length).toBe(1);
    expect(a[0]!.reason).toContain('Storm damage');
  });
});

describe('Q139: the legacy HLC requests into Procurement drafts (one-time, previewed, de-duplicated)', () => {
  it('previews, refuses without a reason, a step-up or the right, creates the drafts once and links a duplicate', async () => {
    const { hlc, fiber } = await hlcTeam();
    const legacy = async (t: Team, no: string, date: string) => {
      const r = await pass('hlc', fiber.entry, fiber.approve, (await fiber.entry.api.call('post', recPath('hlc'), { site_id: t.site.id, data: HLC })).body.id, 1);
      await db.query(`UPDATE register_records SET data = data || jsonb_build_object('request_no', $2::text, 'request_date', $3::text) WHERE id = $1`, [r.id, no, date]);
      await db.query(`UPDATE hlc_records SET request_no = $2, request_date = $3::date WHERE id = $1`, [r.entity_id, no, date]);
      return r;
    };
    const aNo = `HR-L1-${Date.now()}`;
    const a = await legacy(hlc, aNo, '2025-12-20');
    const second = await otherSite(db, hlc);
    const dupNo = `HR-L2-${Date.now()}`;
    const b = await legacy(second, dupNo, '2025-12-21');
    await hlc.entry.api.call('post', recPath('procurement'), { site_id: second.site.id, data: { ...HLC_PR, pr_no: ` ${dupNo.toLowerCase()} ` } });   // entered again already

    const admin = await plainAdmin(app, db);
    const mine = (body: { items: { hlc_record_id: string }[] }) => body.items.filter((i) => [a.id, b.id].includes(i.hlc_record_id));
    const before = await q(db, `SELECT count(*)::int AS n FROM register_records WHERE register_key = 'procurement'`);
    const preview = await admin.api.call('post', '/registers/hlc/legacy-migration', { dry_run: true });
    expect(preview.status).toBe(200);
    expect(mine(preview.body).map((i: any) => [i.hlc_record_id === a.id ? 'a' : 'b', i.outcome]).sort()).toEqual([['a', 'create'], ['b', 'duplicate']]);
    expect(await q(db, `SELECT count(*)::int AS n FROM register_records WHERE register_key = 'procurement'`)).toEqual(before);

    expect((await admin.api.call('post', '/registers/hlc/legacy-migration', { dry_run: false })).status).toBe(422);
    expect((await fiber.entry.api.call('post', '/registers/hlc/legacy-migration', { dry_run: true })).status).toBe(403);
    const cold = await plainAdmin(app, db, false);
    expect((await cold.api.call('post', '/registers/hlc/legacy-migration', { dry_run: false, reason: 'Q139 one-time migration' })).status).toBe(401);

    const run = await admin.api.call('post', '/registers/hlc/legacy-migration', { dry_run: false, reason: 'Q139 one-time migration' });
    expect(run.status).toBe(200);
    const created = mine(run.body).find((i: any) => i.hlc_record_id === a.id) as any;
    expect(created.outcome).toBe('create');
    const draft = await q<{ state: string; data: any; approved_by: string | null; created_by: string }>(db,
      `SELECT state, data, approved_by::text, created_by::text FROM register_records WHERE id = $1`, [created.procurement_record_id]);
    expect(draft[0]).toMatchObject({ state: 'entry', approved_by: null, created_by: admin.user.id });
    expect(draft[0]!.data).toMatchObject({ scope: 'HLC', pr_no: aNo, pr_date: '2025-12-20' });
    expect(draft[0]!.data.hlc_approval_date).toBeUndefined();
    expect((await audits('hlc_legacy_draft_created', created.procurement_record_id)).length).toBe(1);
    // the HLC team completes the draft and sends it through the usual approval
    const d = await hlc.entry.api.call('get', recPath('procurement', created.procurement_record_id));
    expect(d.body.allowed_actions).toEqual(expect.arrayContaining(['edit', 'submit']));
    // the legacy request still counts until its replacement is approved
    expect((await q(db, `SELECT register_key FROM v_purchase_requests WHERE site_id = $1`, [hlc.site.id])).map((r: any) => r.register_key)).toEqual(['hlc']);

    const again = await admin.api.call('post', '/registers/hlc/legacy-migration', { dry_run: false, reason: 'Q139 second run' });
    expect(mine(again.body).map((i: any) => i.outcome).sort()).toEqual(['already_migrated', 'already_migrated']);
    expect((await q(db, `SELECT count(*)::int AS n FROM hlc_legacy_migrations WHERE hlc_entity_id = ANY($1::uuid[])`, [[a.entity_id, b.entity_id]]))[0]).toEqual({ n: 2 });
  });
});

describe('Q114: the Dismantle contractor (FO / FT) comes from the Procurement order', () => {
  async function dismantleTeam() {
    const proc = await team(app, db, 'procurement', 'procurement', R);
    const dis = await team(app, db, 'dismantle', 'dismantle', R);
    // an outsourced order with a PO / WO names a party with an active contract for its scope (P4b, 0061: Q146, Q147)
    const p1 = [{ id: await partyWithContract(db, { name: `Dismantle Co ${Date.now()}` }) }];
    const p2 = [{ id: await partyWithContract(db, { name: `Other Co ${Date.now()}` }) }];
    const order = async (scope: string, party: string, no: string) => {
      const r = await createRec({ ...proc, site: dis.site }, { scope, delivery: 'Outsourced', pr_no: `PR-${no}`, pr_date: '2026-01-05', po_wo_no: `PO-${no}`, po_wo_date: '2026-01-06', order_status: 'Open' }, { external_party_id: party });
      return pass('procurement', proc.entry, proc.approve, r.id, r.version);
    };
    return { proc, dis, party: p1[0]!.id, other: p2[0]!.id, order };
  }

  it('derives the contractor from the only active order, refuses a typed one, and asks for a choice when there are several', async () => {
    const { dis, party, other, order } = await dismantleTeam();
    const o1 = await order('CW Dismantle', party, 'D1');
    await order('TE Dismantle', other, 'D2');                                               // another part: not offered for cw
    const opts = await dis.entry.api.call('get', `/registers/dismantle/order-options?site_id=${dis.site.id}&record_type=cw`);
    expect(opts.status).toBe(200);
    expect(opts.body.items.map((i: any) => [i.entity_id, i.po_wo_no, i.external_party.id])).toEqual([[o1.entity_id, 'PO-D1', party]]);
    expect((await dis.entry.api.call('get', `/registers/dismantle/order-options?site_id=${dis.site.id}&record_type=xx`)).status).toBe(422);

    const cw = await dis.entry.api.call('post', recPath('dismantle'), { site_id: dis.site.id, record_type: 'cw', data: { rfd_date: '2026-02-01', execution_mode: 'Outsourced' } });
    expect(cw.status).toBe(201);
    expect(cw.body.data.procurement_order_id).toBe(o1.entity_id);
    expect(cw.body.external_party.id).toBe(party);
    const typed = await patch(dis.entry.api, 'dismantle', cw.body.id, cw.body.version, { external_party_id: other });
    expect(typed.status).toBe(422);
    expect(codesOf(typed.body)).toEqual(['contractor_from_order']);
    const wrongPart = await patch(dis.entry.api, 'dismantle', cw.body.id, cw.body.version, { data: { procurement_order_id: (await q<{ id: string }>(db,
      `SELECT entity_id::text AS id FROM register_records WHERE register_key = 'procurement' AND site_id = $1 AND data ->> 'scope' = 'TE Dismantle' LIMIT 1`, [dis.site.id]))[0]!.id } });
    expect(codesOf(wrongPart.body)).toEqual(['order_not_active']);

    // a second active CW Dismantle order: the choice is explicit
    const o3 = await order('CW Dismantle', other, 'D3');
    const te = await dis.entry.api.call('post', recPath('dismantle'), { site_id: dis.site.id, record_type: 'te', data: { rfd_date: '2026-02-01', execution_mode: 'Outsourced' } });
    expect(te.body.data.procurement_order_id).toBeDefined();
    const multi = await dis.entry.api.call('post', recPath('dismantle'), { site_id: dis.site.id, record_type: 'cw', data: { rfd_date: '2026-02-01' } });
    expect(multi.status).toBe(409);                                                          // one CW part per site (0021)
    // the existing cw draft: clear the order, the submit asks for the choice among the two
    const cleared = await patch(dis.entry.api, 'dismantle', cw.body.id, cw.body.version, { data: { procurement_order_id: null } });
    expect(cleared.body.data.procurement_order_id).toBeUndefined();
    expect(warnOf(cleared.body)).toEqual(['order_not_chosen']);
    const sub = await post(dis.entry.api, 'dismantle', cw.body.id, 'submit', cleared.body.version);
    expect(codesOf(sub.body)).toEqual(['order_choice_required']);
    const chosen = await patch(dis.entry.api, 'dismantle', cw.body.id, cleared.body.version, { data: { procurement_order_id: o3.entity_id } });
    expect(chosen.body.external_party.id).toBe(other);
    const done = await pass('dismantle', dis.entry, dis.approve, cw.body.id, chosen.body.version);
    expect(done.state).toBe('approved');
    expect((await q(db, 'SELECT external_party_id::text AS p FROM register_records WHERE id = $1', [cw.body.id]))[0]).toEqual({ p: other });
  });

  it('names the internal team for in-house work (no contractor, no order) and keeps the typed contractor of a part without a mode, with a warning', async () => {
    const { dis, party } = await dismantleTeam();
    const ih = await dis.entry.api.call('post', recPath('dismantle'), { site_id: dis.site.id, record_type: 'cw', data: { rfd_date: '2026-02-01', execution_mode: 'In-House' }, external_party_id: party });
    expect(codesOf(ih.body)).toEqual(['in_house_no_contractor']);
    const ok = await dis.entry.api.call('post', recPath('dismantle'), { site_id: dis.site.id, record_type: 'cw', data: { rfd_date: '2026-02-01', execution_mode: 'In-House' } });
    expect(ok.status).toBe(201);
    expect(codesOf((await post(dis.entry.api, 'dismantle', ok.body.id, 'submit', ok.body.version)).body)).toEqual(['required']);
    const team2 = await patch(dis.entry.api, 'dismantle', ok.body.id, ok.body.version, { data: { internal_team: 'Aljeel CW crew 2' } });
    expect((await pass('dismantle', dis.entry, dis.approve, ok.body.id, team2.body.version)).state).toBe('approved');

    const legacy = await dis.entry.api.call('post', recPath('dismantle'), { site_id: dis.site.id, record_type: 'te', data: { rfd_date: '2026-02-01' }, external_party_id: party });
    expect(legacy.status).toBe(201);
    expect(legacy.body.external_party.id).toBe(party);
    expect(warnOf(legacy.body)).toEqual(['execution_mode_missing']);
    expect(codesOf((await patch(dis.entry.api, 'dismantle', legacy.body.id, legacy.body.version, { data: { internal_team: 'x' } })).body)).toEqual(['execution_mode_required']);
    // outsourced without any active order of the part: the submit says so
    const out = await patch(dis.entry.api, 'dismantle', legacy.body.id, legacy.body.version, { data: { execution_mode: 'Outsourced' } });
    expect(codesOf((await post(dis.entry.api, 'dismantle', legacy.body.id, 'submit', out.body.version)).body)).toEqual(['no_active_order']);
  });
});

describe('Q151: configurable GECOL order warnings (off by default)', () => {
  it('warns nothing by default, then follows the chains and the billing event of the setting; the setting is admin-only, validated and versioned', async () => {
    const admin = await plainAdmin(app, db);
    const g = await team(app, db, 'gecol', 'gecol', R);
    const cur = await admin.api.call('get', '/settings/gecol-order-warnings');
    expect(cur.status).toBe(200);
    expect(cur.body.enabled).toBe(false);
    expect(cur.body.chains[0]).toEqual(['request_date', 'survey_date', 'layout_received', 'layout_approved']);
    expect(cur.body.fields.map((f: { code: string }) => f.code)).toContain('power_on_date');
    const etag = cur.headers.etag as string;
    const data = { ...GECOL, survey_date: '2026-01-04', layout_approved: '2026-01-03', installation_finish: '2026-01-20', power_on_date: '2026-01-25', billing_conversion_date: '2026-01-22' };
    const rec = await createRec(g, data);
    expect(warnOf(rec)).toEqual([]);                                                         // the current behaviour stays the default

    expect((await g.entry.api.call('put', '/settings/gecol-order-warnings', { reason: 'try', enabled: true, chains: [], billing_after: null }, { 'If-Match': etag })).status).toBe(403);
    const badField = await admin.api.call('put', '/settings/gecol-order-warnings', { reason: 'GECOL team draft', enabled: true, chains: [['request_date', 'meter_no']], billing_after: 'remark' }, { 'If-Match': etag });
    expect(badField.status).toBe(422);
    expect(codesOf(badField.body)).toEqual(['unknown_field', 'unknown_field']);
    expect((await admin.api.call('put', '/settings/gecol-order-warnings', { reason: 'x1', enabled: true, chains: [], billing_after: null, extra: 1 }, { 'If-Match': etag })).status).toBe(422);
    try {
      const on = await admin.api.call('put', '/settings/gecol-order-warnings',
        { reason: 'GECOL team draft order (Q151)', enabled: true, chains: cur.body.chains, billing_after: 'power_on_date' }, { 'If-Match': etag });
      expect(on.status).toBe(200);
      expect(on.body.version).toBe(cur.body.version + 1);
      expect((await admin.api.call('put', '/settings/gecol-order-warnings', { reason: 'stale', enabled: false, chains: [], billing_after: null }, { 'If-Match': etag })).status).toBe(412);
      const w = (await g.entry.api.call('get', recPath('gecol', rec.id))).body.warnings as { code: string; path: string; related_path?: string }[];
      // survey before the request; layout approved before the survey (layout received has no date: skipped); billing before Power-On
      expect(w.map((x) => [x.code, x.path, x.related_path])).toEqual([
        ['gecol_order', '/data/survey_date', '/data/request_date'],
        ['gecol_order', '/data/layout_approved', '/data/request_date'],
        ['billing_before_event', '/data/billing_conversion_date', '/data/power_on_date'],
      ]);
      // a warning never blocks the submit; C-2 negative (installation finish before the request) still does
      expect((await post(g.entry.api, 'gecol', rec.id, 'submit', rec.version)).status).toBe(200);
      const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'gecol_order_warnings_update' AND entity_id = 'gecol.order_warnings'`);
      expect(au.length).toBeGreaterThan(0);
    } finally {
      const now = await admin.api.call('get', '/settings/gecol-order-warnings');
      await admin.api.call('put', '/settings/gecol-order-warnings', { reason: 'test reset to the default', enabled: false, chains: cur.body.chains, billing_after: null },
        { 'If-Match': now.headers.etag as string });
    }
  });
});
