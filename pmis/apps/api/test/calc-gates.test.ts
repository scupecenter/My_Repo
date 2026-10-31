import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allLocked, approve, newSite, open, q, taskId, taskRow, wd } from './calc-helpers';
import { makeUser, startApp, superDb } from './helpers';
import { actor, makeTask, plainAdmin, setCell } from './wf-helpers';
import type { Site } from './wf-helpers';

/**
 * Migration 0017, parts 3 to 5: milestone dates calculated from their tasks (E3), the pre-filled Site RFI (Q38), gate conditions with
 * permit validity on the gate date (D36, Q62), permit expiry (Q63, Q63c) and the Suspension/Resumption shift of the gate.
 * Every test builds its own site, so the suites can run in parallel on one database.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const gate = async (site: Site, code: string): Promise<{ status: string; gate_date: string | null; base_date: string | null; shifted: boolean; reasons: { kind: string; ref_code: string | null }[] }> =>
  (await q<{ status: string; gate_date: string | null; base_date: string | null; shifted: boolean; reasons: { kind: string; ref_code: string | null }[] }>(
    db, 'SELECT status, gate_date::text AS gate_date, base_date::text AS base_date, shifted, reasons FROM gate_eval($1, $2)', [site.id, code]))[0]!;

const permit = (site: Site, type: string, o: { status?: string; from?: string | null; to?: string | null; hasExpiry?: boolean | null; naReason?: string | null; naBy?: string | null; stop?: boolean; lifted?: string | null } = {}) =>
  db.query(
    `INSERT INTO permit_records (site_id, region_id, permit_type, status, valid_from, valid_to, has_expiry, na_reason, na_approved_by, stop_work, stop_lifted_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [site.id, site.region, type, o.status ?? 'Approved', o.from ?? null, o.to ?? null, o.hasExpiry ?? null, o.naReason ?? null, o.naBy ?? null, o.stop ?? false, o.lifted ?? null],
  );

/** A site at the gate CW Readiness: PRE-CW done on `gateDay`, the two CW item tasks done on `itemsDay`, CW Completion waiting. */
async function cwSite(gateDay: string, itemsDay: string): Promise<Site> {
  const site = await newSite(db);
  await makeTask(db, site, 'MS2', 'approved', { actualDate: gateDay });
  await makeTask(db, site, 'B10', 'approved', { actualDate: itemsDay });
  await makeTask(db, site, 'B11', 'approved', { actualDate: itemsDay });
  const ms3 = await makeTask(db, site, 'MS3', 'locked');
  await open(db, ms3);
  return site;
}

describe('milestone dates are calculated from their tasks (E3)', () => {
  it('completes Site Release from its tasks with no approval of its own, and starts the next clock from it', async () => {
    const site = await newSite(db);
    await allLocked(db, site);
    await approve(db, site, 'A2', await wd(db, -9));
    await approve(db, site, 'A3', await wd(db, -8));
    await approve(db, site, 'A4', await wd(db, -7));
    expect((await taskRow(db, site, 'MS1')).state).toBe('locked');              // A5 is still open
    const a5 = await wd(db, -6);
    await approve(db, site, 'A5', a5);
    const ms1 = await taskRow(db, site, 'MS1');
    expect(ms1.state).toBe('approved');
    expect(ms1.actual_date).toBe(a5);                                          // the latest of its conditions
    const steps = await q<{ acted_by: string | null; note: string }>(db, `SELECT acted_by, note FROM workflow_steps WHERE task_id = $1`, [await taskId(db, site, 'MS1')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ acted_by: null });
    expect(steps[0]!.note).toMatch(/no approval of its own/);
    const audit = await q<{ after: { actual_date: string } }>(db, `SELECT after FROM audit_log WHERE action = 'milestone_calculated' AND entity_id = $1`, [await taskId(db, site, 'MS1')]);
    expect(audit).toHaveLength(1);
    // the successor unlocks and its SLA starts from the milestone date (B01: Site Release -> CW PR/WO)
    const b1 = await taskRow(db, site, 'B1');
    expect(b1.state).toBe('open');
    expect(b1.sla_start_date).toBe(a5);
    expect(b1.due_date).toBe(await q<{ d: string }>(db, `SELECT cal_add_workdays($1::date, 1)::text AS d`, [a5]).then((r) => r[0]!.d));
    // a calculated milestone has no holder on purpose, so unlocking it raised no "no eligible holder" alert
    const alerts = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM notifications WHERE kind = 'no_eligible_holder' AND task_id = $1`, [await taskId(db, site, 'MS1')]);
    expect(alerts[0]!.n).toBe(0);
  });

  it('follows a moved condition date while the milestone is calculated', async () => {
    const site = await newSite(db);
    await allLocked(db, site);
    for (const [c, off] of [['A2', -9], ['A3', -8], ['A4', -7], ['A5', -6]] as const) await approve(db, site, c, await wd(db, off));
    const later = await wd(db, -3);
    await db.query(`UPDATE task_instances SET actual_date = $2 WHERE id = $1`, [await taskId(db, site, 'A4'), later]);
    await db.query('SELECT calc_refresh_site($1)', [site.id]);
    expect((await taskRow(db, site, 'MS1')).actual_date).toBe(later);
  });
});

describe('gate CW Readiness: permits approved and valid on the gate date (D36, Q62)', () => {
  it('stays closed without the permits and says which one is missing', async () => {
    const site = await cwSite(await wd(db, -6), await wd(db, -2));
    const g = await gate(site, 'G3');
    expect(g.status).toBe('blocked');
    expect(g.gate_date).toBeNull();
    expect(g.reasons.map((r) => r.ref_code).sort()).toEqual(['Access - CW', 'PTW - CW']);
    const ms3 = await taskRow(db, site, 'MS3');
    expect(ms3.state).toBe('open');                                              // not calculated while the gate is closed
    expect(String(ms3.lock_reason)).toMatch(/Access - CW|PTW - CW/);
  });

  it('rejects a permit that was valid before the gate date but had expired on it', async () => {
    const gateDay = await wd(db, -6);
    const site = await cwSite(gateDay, await wd(db, -2));
    await permit(site, 'Access - CW', { from: await wd(db, -12), to: await wd(db, -8) });
    await permit(site, 'PTW - CW', { from: await wd(db, -12), to: await wd(db, 20) });
    const g = await gate(site, 'G3');
    expect(g.status).toBe('blocked');
    expect(g.reasons.map((r) => r.ref_code)).toEqual(['Access - CW']);
    // a renewal valid on the gate date opens it; the gate date is still the previous milestone date
    await permit(site, 'Access - CW', { from: await wd(db, -8), to: await wd(db, 30) });
    const g2 = await gate(site, 'G3');
    expect(g2).toMatchObject({ status: 'open', gate_date: gateDay, base_date: gateDay, shifted: false });
  });

  it('opens on the previous milestone date, completes the milestone, and moves later when a permit starts later', async () => {
    const gateDay = await wd(db, -6);
    const itemsDay = await wd(db, -2);
    const site = await cwSite(gateDay, itemsDay);
    await permit(site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    expect((await taskRow(db, site, 'MS3')).state).toBe('open');                 // PTW - CW still missing
    await permit(site, 'PTW - CW', { status: 'N/A', naReason: 'no work at height on this site' });
    expect((await gate(site, 'G3')).status).toBe('blocked');                     // N/A without an approver does not count (D36)
    await db.query(`UPDATE permit_records SET na_approved_by = 'CW Team Lead' WHERE site_id = $1 AND permit_type = 'PTW - CW'`, [site.id]);
    const g = await gate(site, 'G3');
    expect(g).toMatchObject({ status: 'open', gate_date: gateDay });
    const ms3 = await taskRow(db, site, 'MS3');
    expect(ms3.state).toBe('approved');                                          // calculated, no approval of its own
    expect(ms3.actual_date).toBe(itemsDay);

    // a second site where the permit starts after the previous milestone: the gate date is the permit start (Master AX = MAX of both)
    const gate2 = await wd(db, -8);
    const site2 = await cwSite(gate2, itemsDay);
    const start = await wd(db, -5);
    await permit(site2, 'Access - CW', { from: start, to: await wd(db, 30) });
    await permit(site2, 'PTW - CW', { status: 'N/A', naReason: 'not needed', naBy: 'CW Team Lead' });
    expect(await gate(site2, 'G3')).toMatchObject({ status: 'open', gate_date: start, base_date: gate2 });
    expect((await taskRow(db, site2, 'MS3')).actual_date).toBe(itemsDay);
  });

  it('takes the later of the gate date and its latest condition date when the conditions are earlier (owner answer Q76, differs from the Master BP)', async () => {
    const itemsDay = await wd(db, -6);                                           // items done on the 6th working day back
    const site = await cwSite(await wd(db, -8), itemsDay);
    const permitStart = await wd(db, -4);
    await permit(site, 'Access - CW', { from: permitStart, to: await wd(db, 30) });        // the gate moves to the 4th day back, later than the items
    await permit(site, 'PTW - CW', { status: 'N/A', naReason: 'not needed', naBy: 'CW Team Lead' });
    expect(await gate(site, 'G3')).toMatchObject({ status: 'open', gate_date: permitStart });
    const ms3 = await taskRow(db, site, 'MS3');
    expect(ms3.state).toBe('approved');                                          // not blank: calculated
    expect(ms3.actual_date).toBe(permitStart);                                   // the later of the two dates
    expect(ms3.lock_reason).toBeNull();
    // the setting that used to keep the milestones blank is empty
    expect((await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'calc.milestone_ge_gate'`))[0]!.value).toEqual([]);
  });

  it('gives every other calculated milestone the same rule: MS5 to MS10 take the later of the gate date and their conditions (Q76)', async () => {
    // TE Completion (MS5): gate G5 = the Site RFI date, the TE installation item done before it
    const rfiDay = await wd(db, -3);
    const site = await newSite(db);
    await makeTask(db, site, 'MS4', 'approved', { actualDate: rfiDay });
    await makeTask(db, site, 'D6', 'approved', { actualDate: await wd(db, -7) });
    await permit(site, 'Access - TE', { from: await wd(db, -9), to: await wd(db, 40) });
    await permit(site, 'PTW - TE', { from: await wd(db, -9), to: await wd(db, 40) });
    const ms5 = await makeTask(db, site, 'MS5', 'locked');
    await open(db, ms5);
    const row = await taskRow(db, site, 'MS5');
    expect(row.state).toBe('approved');
    expect(row.actual_date).toBe(rfiDay);                                        // the gate date, later than D6
    // On-Air Readiness (MS6) the same way
    const ms6 = await makeTask(db, site, 'MS6', 'locked');
    for (const c of ['D7', 'D8', 'D9', 'D10']) await makeTask(db, site, c, 'approved', { actualDate: await wd(db, -8) });
    await open(db, ms6);
    expect((await taskRow(db, site, 'MS6')).actual_date).toBe(rfiDay);
  });

  it('is held by an active stop work on the PTW and released by the lift date', async () => {
    const gateDay = await wd(db, -6);
    const site = await cwSite(gateDay, await wd(db, -2));
    await permit(site, 'Access - CW', { from: await wd(db, -7), to: await wd(db, 30) });
    await permit(site, 'PTW - CW', { from: await wd(db, -7), to: await wd(db, 30), stop: true });
    const g = await gate(site, 'G3');
    expect(g.status).toBe('blocked');
    expect(g.reasons.some((r) => r.kind === 'stop_work')).toBe(true);
    const lifted = await wd(db, -3);
    await db.query(`UPDATE permit_records SET stop_lifted_date = $2 WHERE site_id = $1 AND permit_type = 'PTW - CW'`, [site.id, lifted]);
    expect(await gate(site, 'G3')).toMatchObject({ status: 'open', gate_date: lifted });
  });
});

describe('permit expiry (Q63, Q63c)', () => {
  it('takes the default of the choice from the permit type: Yes for access and PTW, No for City Council and Civil Aviation', async () => {
    const t = await q<{ code: string; has_expiry: boolean }>(db, 'SELECT code, has_expiry FROM permit_types ORDER BY sort_order');
    const by = Object.fromEntries(t.map((x) => [x.code, x.has_expiry]));
    expect(t).toHaveLength(12);
    expect(by).toMatchObject({
      'City Council Permit': false, 'Civil Aviation Authority Permit': false, 'Security Clearance': true, 'Other Permit': true, 'Access - Survey': true,
      'Access - CW': true, 'Access - TE': true, 'Access - Dismantle': true, 'Access - QC / Maintenance': true, 'PTW - CW': true, 'PTW - TE': true, 'PTW - Dismantle': true,
    });
    const site = await newSite(db);
    const a = await permit(site, 'City Council Permit', { from: await wd(db, -3) });
    const b = await permit(site, 'Access - TE', { status: 'Applied' });
    expect((await q<{ has_expiry: boolean }>(db, 'SELECT has_expiry FROM permit_records WHERE id = $1', [a.rows[0].id]))[0]!.has_expiry).toBe(false);
    expect((await q<{ has_expiry: boolean }>(db, 'SELECT has_expiry FROM permit_records WHERE id = $1', [b.rows[0].id]))[0]!.has_expiry).toBe(true);
  });

  it('needs the expiry date once an expiring permit is approved, and a permanent permit has none', async () => {
    const site = await newSite(db);
    await expect(permit(site, 'Access - CW', { from: await wd(db, -3) })).rejects.toMatchObject({ code: '23514' });                 // Yes, approved, no valid_to
    await expect(permit(site, 'City Council Permit', { from: await wd(db, -3), to: await wd(db, 9) })).rejects.toMatchObject({ code: '23514' });   // No, with a valid_to
    await expect(permit(site, 'Access - CW', { from: await wd(db, 3), to: await wd(db, -3) })).rejects.toMatchObject({ code: '23514' });          // valid_to before valid_from
    await permit(site, 'Access - CW', { status: 'Applied' });                                                                        // not approved yet: the date can wait
  });

  it('counts a permanent permit as valid on any later date, and an unknown type without an expiry date as not valid (D36)', async () => {
    const site = await newSite(db);
    const from = await wd(db, -9);
    const rid = (await permit(site, 'Access - CW', { from, hasExpiry: false })).rows[0].id as string;          // the record overrides the type: permanent
    const valid = async (on: string) => (await q<{ v: boolean }>(db, 'SELECT permit_valid_on(p, $2::date) AS v FROM permit_records p WHERE id = $1', [rid, on]))[0]!.v;
    expect(await valid(await wd(db, 400))).toBe(true);
    expect(await valid(await wd(db, -30))).toBe(false);                                                      // not before it starts
    const unknown = (await permit(site, 'Some Other Type', { from })).rows[0].id as string;                  // no type row, no choice: blank
    expect((await q<{ v: boolean }>(db, 'SELECT permit_valid_on(p, $2::date) AS v FROM permit_records p WHERE id = $1', [unknown, await wd(db, -1)]))[0]!.v).toBe(false);
  });
});

describe('Change Control shifts the gate (rules.md section 2.3)', () => {
  const change = async (site: Site, kind: 'suspension' | 'resumption', date: string, status = 'approved') => {
    const u = await makeUser(db);
    await db.query(
      `INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, requested_by) VALUES ($1, $2, $3, $4::"ChangeKind", $5::"ChangeStatus", $6, $7)`,
      [`CC-${site.code}-${kind}-${date}`, site.id, site.region, kind, status, date, u.id],
    );
  };

  it('locks the gate while suspended, moves it to the approved resumption, and ignores a resumption that was never approved', async () => {
    const site = await newSite(db);
    const ms1 = await wd(db, -10);
    await makeTask(db, site, 'MS1', 'approved', { actualDate: ms1 });
    expect(await gate(site, 'G2')).toMatchObject({ status: 'open', gate_date: ms1, shifted: false });
    await change(site, 'suspension', await wd(db, -12));
    const locked = await gate(site, 'G2');
    expect(locked.status).toBe('blocked');
    expect(locked.reasons.some((r) => r.kind === 'suspension')).toBe(true);
    await change(site, 'resumption', await wd(db, -3), 'requested');
    expect((await gate(site, 'G2')).status).toBe('blocked');
    const back = await wd(db, -5);
    await change(site, 'resumption', back);
    expect(await gate(site, 'G2')).toMatchObject({ status: 'open', gate_date: back, base_date: ms1, shifted: true });
  });

  it('does not move a gate whose resumption is after the suspension on the candidate date, and a later suspension waits for the next gate', async () => {
    const site = await newSite(db);
    const ms1 = await wd(db, -10);
    await makeTask(db, site, 'MS1', 'approved', { actualDate: ms1 });
    await change(site, 'suspension', await wd(db, -14));
    await change(site, 'resumption', await wd(db, -12));
    await change(site, 'suspension', await wd(db, -2));                         // after the gate opened
    expect(await gate(site, 'G2')).toMatchObject({ status: 'open', gate_date: ms1, shifted: false });
  });

  it('shows the shift and the lock reasons on the site pipeline', async () => {
    const admin = await plainAdmin(app, db, false);
    const site = await newSite(db);
    const ms1 = await wd(db, -10);
    await makeTask(db, site, 'MS1', 'approved', { actualDate: ms1 });
    await change(site, 'suspension', await wd(db, -12));
    const back = await wd(db, -5);
    await change(site, 'resumption', back);
    const res = await admin.api.call('get', `/sites/${site.id}`);
    expect(res.status).toBe(200);
    const g2 = res.body.pipeline.find((n: { code: string }) => n.code === 'G2');
    expect(g2).toMatchObject({ kind: 'gate', actual_date: back, shifted_by_suspension: true });
  });
});

describe('Site RFI (MS4) is pre-filled, editable, and then approved (Q38)', () => {
  async function rfiSite(): Promise<{ site: Site; ms4: string }> {
    const site = await newSite(db);
    await makeTask(db, site, 'MS3', 'approved', { actualDate: await wd(db, -8) });
    await makeTask(db, site, 'B13', 'approved', { actualDate: await wd(db, -6) });
    await makeTask(db, site, 'C4', 'approved', { actualDate: await wd(db, -5) });          // TX Link Tested (Q54)
    await makeTask(db, site, 'C2', 'approved', { actualDate: await wd(db, -4) });          // Power-On (Q54)
    const ms4 = await makeTask(db, site, 'MS4', 'locked');
    await open(db, ms4);
    return { site, ms4: ms4 };
  }

  it('fills the latest condition date and leaves the task open for its holder, with no approval of its own', async () => {
    const { site } = await rfiSite();
    const t = await taskRow(db, site, 'MS4');
    expect(t.state).toBe('open');
    expect(t.actual_date).toBe(await wd(db, -4));
    expect(t.values).toMatchObject({ prefilled: true, prefilled_date: await wd(db, -4) });
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'milestone_prefill' AND entity_id = $1`, [await taskId(db, site, 'MS4')])).toHaveLength(1);
    expect((await gate(site, 'G4')).gate_date).toBe(await wd(db, -8));
  });

  it('shows prefill_date, accepts an edit on or after the RFI Readiness gate and refuses an earlier date', async () => {
    const { site } = await rfiSite();
    const e = await actor(app, db, { level: 'entry' });
    await setCell(db, 'MS4', 5, 'entry', { user: [e.user.id] });
    const id = await taskId(db, site, 'MS4');
    const t = (await e.api.call('get', `/tasks/${id}`)).body;
    expect(t.prefill_date).toBe(await wd(db, -4));
    expect(t.actual_date).toBe(await wd(db, -4));
    const early = await e.api.call('patch', `/tasks/${id}`, { actual_date: await wd(db, -10) }, { 'If-Match': `"${t.version}"` });
    expect(early.status).toBe(422);
    expect(early.body.errors[0]).toMatchObject({ path: '/actual_date', code: 'before_gate' });
    const ok = await e.api.call('patch', `/tasks/${id}`, { actual_date: await wd(db, -3) }, { 'If-Match': `"${t.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.actual_date).toBe(await wd(db, -3));
  });

  it('refuses a Site RFI date while its gate is not open (fail closed)', async () => {
    const { site } = await rfiSite();
    const id = await taskId(db, site, 'MS4');
    // take the gate's base away: without a CW Completion (MS3) date the RFI Readiness gate (G4) is not open
    await db.query(`UPDATE task_instances SET actual_date = NULL, state = 'open' WHERE site_id = $1 AND task_def_id = (SELECT id FROM task_definitions WHERE code = 'MS3' AND workflow_id = (SELECT workflow_version_id FROM sites WHERE id = $1))`, [site.id]);
    const st = (await gate(site, 'G4')).status;
    expect(['blocked', 'pending']).toContain(st);
    await expect(db.query(`UPDATE task_instances SET actual_date = $2 WHERE id = $1`, [id, await wd(db, -2)])).rejects.toThrow(/not open/);
  });

  it('keeps a date the user edited when a condition date moves, and follows it when nobody edited', async () => {
    const edited = await rfiSite();
    const untouched = await rfiSite();
    await db.query(`UPDATE task_instances SET actual_date = $2 WHERE id = $1`, [await taskId(db, edited.site, 'MS4'), await wd(db, -3)]);
    const newer = await wd(db, -1);
    for (const s of [edited.site, untouched.site]) {
      await db.query(`UPDATE task_instances SET actual_date = $2 WHERE id = $1`, [await taskId(db, s, 'C2'), newer]);
      await db.query('SELECT calc_refresh_site($1)', [s.id]);
    }
    expect((await taskRow(db, edited.site, 'MS4')).actual_date).toBe(await wd(db, -3));
    expect((await taskRow(db, untouched.site, 'MS4')).actual_date).toBe(newer);
  });

  it('is not calculated into approved: only the holder\'s approval closes it', async () => {
    const { site } = await rfiSite();
    expect((await taskRow(db, site, 'MS4')).state).toBe('open');
    await db.query('SELECT calc_refresh_site($1)', [site.id]);
    expect((await taskRow(db, site, 'MS4')).state).toBe('open');
  });
});
