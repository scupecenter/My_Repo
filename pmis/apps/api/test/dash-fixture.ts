import type { Client as PgClient } from 'pg';

/**
 * A small, known data set for the dashboard suites (fictional sites, written straight into the database as the superuser with triggers off, so the
 * calculation layer does not change what is written). Every date is "today minus n days" counted by the database, so nothing depends on the weekday.
 *
 * Tripoli (region 1): T1..T4, T6 are active, T5 is cancelled.   Benghazi (region 5): B1..B3.
 *   L = milestones done in a row:  T1 4 (MS5 open) · T2 1 · T3 0 · T4 10 (completed) · T6 9 (HOTO done, not closed) · B1 6 · B2 1 (on hold) · B3 0 · T5 1 (cancelled)
 *   MS j is done n days ago:  T1 60 50 40 30 · T2 20 · T4 110-10j · T6 100-10j · B1 100-10j · B2 15 · T5 10
 */
export interface Fix {
  site: Record<string, { id: string; region: number }>;
  td: Record<string, string>;
  userX: string;
  userY: string;
  party: string;
  today: string;
}

const MS = ['MS1', 'MS2', 'MS3', 'MS4', 'MS5', 'MS6', 'MS7', 'MS8', 'MS9', 'MS10'];

export const q = async <T = Record<string, unknown>>(db: PgClient, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

export async function today(db: PgClient): Promise<string> {
  return (await q<{ d: string }>(db, 'SELECT cal_today()::text AS d'))[0]!.d;
}

/** Working days between two "days ago" offsets, counted by the database's own calendar function. */
export async function wdBetween(db: PgClient, fromAgo: number, toAgo = 0): Promise<number> {
  return (await q<{ n: number }>(db, 'SELECT cal_workdays_between(cal_today() - $1::int, cal_today() - $2::int) AS n', [fromAgo, toAgo]))[0]!.n;
}

export async function buildFixture(db: PgClient, userX: string, userY: string): Promise<Fix> {
  await db.query("SET session_replication_role = replica");
  const wf = (await q<{ id: string }>(db, 'SELECT id FROM workflow_definitions WHERE version = 1'))[0]!.id;
  const td: Record<string, string> = {};
  for (const r of await q<{ id: string; code: string }>(db, 'SELECT id, code FROM task_definitions WHERE workflow_id = $1', [wf])) td[r.code] = r.id;
  const party = (await q<{ id: string }>(db, `INSERT INTO external_parties (name, type) VALUES ('Dash Test Vendor', 'te_vendor') RETURNING id`))[0]!.id;
  const site: Fix['site'] = {};
  const mk = async (code: string, region: number, status = 'in_progress', scenario = 'new_build', cluster: string | null = null): Promise<void> => {
    const r = await q<{ id: string }>(db,
      `INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, cluster_id, updated_at)
       VALUES ($1, $2, $3, $4, $5::"DeliveryScenario", $6::"OverallStatus", $7, now()) RETURNING id`,
      [`DASH-${code}`, `Dash ${code}`, region, wf, scenario, status, cluster]);
    site[code] = { id: r[0]!.id, region };
  };
  const cl = (await q<{ id: string }>(db, `INSERT INTO clusters (cluster_code, name, is_global) VALUES ('DASH-CL1', 'Dash cluster', true) RETURNING id`))[0]!.id;
  await mk('T1', 1, 'in_progress', 'new_build', cl); await mk('T2', 1, 'in_progress', 'expansion', cl); await mk('T3', 1, 'not_started'); await mk('T4', 1, 'completed');
  await mk('T5', 1, 'cancelled'); await mk('T6', 1);
  await mk('B1', 5); await mk('B2', 5, 'on_hold'); await mk('B3', 5, 'not_started');

  /** Milestone tasks of a site: the first `done` are approved `ago(j)` days ago, the next is open, the rest locked. */
  const milestones = async (code: string, done: number, ago: (j: number) => number): Promise<void> => {
    const s = site[code]!;
    for (let j = 1; j <= 10; j++) {
      const state = j <= done ? 'approved' : j === done + 1 ? 'open' : 'locked';
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         VALUES ($1, $2, $3, $4::"TaskState", $5, 3, $6, $6, now())`,
        [s.id, s.region, td[MS[j - 1]!], state, state === 'open' ? 1 : 0, j <= done ? (await q<{ d: string }>(db, 'SELECT (cal_today() - $1::int)::text AS d', [ago(j)]))[0]!.d : null]);
    }
  };
  await milestones('T1', 4, (j) => [60, 50, 40, 30][j - 1]!);
  await milestones('T2', 1, () => 20);
  await milestones('T3', 0, () => 0);
  await milestones('T4', 10, (j) => 110 - 10 * j);
  await milestones('T5', 1, () => 10);
  await milestones('T6', 9, (j) => 100 - 10 * j);
  await milestones('B1', 6, (j) => 100 - 10 * j);
  await milestones('B2', 1, () => 15);
  await milestones('B3', 0, () => 0);

  /** One extra task: dates are days ago (negative = ahead). */
  const task = async (s: string, code: string, state: string, o: { actual?: number; start?: number; target?: number; due?: number; end?: number; elapsedPlus?: number; rule?: boolean; returns?: number } = {}): Promise<void> => {
    const site_ = site[s]!;
    const ago = (n: number | undefined): string | null => (n === undefined ? null : `(cal_today() - ${n})`);
    await db.query(
      `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, sla_rule_id, sla_start_date, sla_target_date, due_date, sla_end_date, sla_elapsed_wd, return_count, updated_at)
       SELECT $1, $2, $3, $4::"TaskState", 0, 3, ${ago(o.actual) ?? 'NULL'}, ${ago(o.actual) ?? 'NULL'}, r.id, ${ago(o.start) ?? 'NULL'}, ${ago(o.target) ?? 'NULL'}, ${ago(o.due) ?? 'NULL'}, ${ago(o.end) ?? 'NULL'},
              CASE WHEN $5::int IS NULL THEN NULL ELSE r.max_working_days + $5::int END, $6, now()
       FROM (SELECT 1) one LEFT JOIN sla_rules r ON r.task_def_id = $3 AND $7::boolean`,
      [site_.id, site_.region, td[code], state, o.elapsedPlus ?? null, o.returns ?? 0, o.rule ?? true]);
  };
  // closed SLA clocks: A2 on time at T1 and B1, late at T2 (the second one has a returned approval)
  await task('T1', 'A2', 'approved', { actual: 100, start: 110, end: 100, elapsedPlus: 0 });
  await task('T2', 'A2', 'approved', { actual: 100, start: 110, end: 100, elapsedPlus: 4, returns: 1 });
  await task('B1', 'A2', 'approved', { actual: 100, start: 110, end: 100, elapsedPlus: 0 });
  // open clocks: late (T1 B8 due 30 days ago, B1 B8 due 60 days ago), at risk (T1 D5), on time (T2 D7, B1 D7)
  await task('T1', 'B8', 'open', { start: 90, target: 60, due: 30 });
  await task('B1', 'B8', 'open', { start: 120, target: 90, due: 60 });
  await task('T1', 'D5', 'open', { start: 40, target: 30, due: -30 });
  await task('T2', 'D7', 'open', { start: 5, target: -30, due: -40 });
  await task('B1', 'D7', 'open', { start: 5, target: -30, due: -40 });
  // CW and TE acceptance, for the Final Closure KPI: T6 waits for CW FAC (DLP ended 20 days ago) and TE FAC (10 days ago); T1 is not due yet
  await task('T1', 'B13', 'approved', { actual: 35, rule: false });
  await task('T4', 'B13', 'approved', { actual: 35, rule: false });
  await task('T6', 'B13', 'approved', { actual: 35, rule: false });
  await task('T1', 'B15', 'open', { start: -30, rule: false });
  await task('T4', 'B15', 'approved', { actual: 5, rule: false });
  await task('T6', 'B15', 'open', { start: 20, rule: false });
  await task('T4', 'D16', 'approved', { actual: 20, rule: false });
  await task('T6', 'D16', 'approved', { actual: 25, rule: false });
  await task('T4', 'D18', 'approved', { actual: 2, rule: false });
  await task('T6', 'D18', 'open', { start: 10, rule: false });

  // baselines (an approved version): the milestone date moved by -2 .. +2 days; sites without any are the "baseline missing" ones
  await db.query(`INSERT INTO baseline_versions (version, label, status, approved_at) VALUES (900, 'dash test', 'approved', now())`);
  const bv = (await q<{ id: string }>(db, `SELECT id FROM baseline_versions WHERE version = 900`))[0]!.id;
  const base = async (s: string, m: string, ago: number): Promise<void> => {
    await db.query(`INSERT INTO baseline_entries (version_id, site_id, region_id, milestone_code, baseline_date) VALUES ($1, $2, $3, $4, cal_today() - $5::int)`, [bv, site[s]!.id, site[s]!.region, m, ago]);
  };
  await base('T1', 'MS1', 62); await base('T1', 'MS2', 50); await base('T1', 'MS3', 45); await base('T1', 'MS4', 20); await base('T1', 'MS5', 10); await base('T1', 'MS6', -20);
  await base('T2', 'MS1', 20); await base('T2', 'MS2', 5); await base('T3', 'MS1', 3);
  await base('B1', 'MS1', 91); await base('B2', 'MS1', 15);

  // Change Control: B2 is suspended 5 days ago and not resumed
  await db.query(`INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, is_global, requested_by) VALUES ('DASH-CH-1', $1, 5, 'suspension', 'approved', cal_today() - 5, false, $2)`, [site.B2!.id, userX]);

  // gates held: T1 at G5 and B1 at G7 (site_gate_state is what the calculation layer keeps)
  await db.query(`INSERT INTO site_gate_state (site_id, gate_code, is_open, since) VALUES ($1, 'G5', false, now() - interval '3 days'), ($2, 'G7', false, now() - interval '1 day')`, [site.T1!.id, site.B1!.id]);

  // issues (several per site): T1 has two owned by X (one blocks a gate), T2 one owned by the vendor, T3 one closed, B1 one owned by Y
  const issue = async (s: string, ago: number, o: { owner?: string; party?: boolean; status?: string; blocked?: string }): Promise<void> => {
    const site_ = site[s]!;
    await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, external_party_id, approved_at, current_level)
       VALUES (gen_random_uuid(), 1, 'issues', $1, $2, 'approved', true,
         jsonb_build_object('pending_issue', 'Dash issue', 'raised_date', (cal_today() - $3::int)::text, 'issue_status', $4::text, 'blocked_gate_or_task', $5::text) || CASE WHEN $6::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('owner_user', $6::text) END,
         CASE WHEN $7::boolean THEN $8::uuid END, now(), 3)`,
      [site_.id, site_.region, ago, o.status ?? 'Open', o.blocked ?? '', o.owner ?? null, o.party ?? false, party]);
  };
  await issue('T1', 20, { owner: userX, blocked: 'G5' }); await issue('T1', 5, { owner: userX }); await issue('T2', 40, { party: true });
  await issue('T3', 30, { owner: userX, status: 'Closed' }); await issue('B1', 10, { owner: userY });
  // an open Major snag at B1 also blocks (health factor I)
  const stype = (await q<{ id: string }>(db, `INSERT INTO snag_types (code, name_en) VALUES ('DASHSNAG', 'Dash snag') ON CONFLICT (code) DO UPDATE SET name_en = 'Dash snag' RETURNING id`))[0]!.id;
  await db.query(`INSERT INTO snags (site_id, region_id, snag_type_id, scope, description, severity, status, raised_by) VALUES ($1, 5, $2, 'TE', 'dash', 'Major', 'open', $3)`, [site.B1!.id, stype, userY]);

  // Dismantle: T4 closed its CW part, B1 only asked (RFD)
  const dis = async (s: string, type: string, data: Record<string, unknown>): Promise<void> => {
    await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, record_type, site_id, region_id, state, is_current, data, approved_at, current_level)
       VALUES (gen_random_uuid(), 1, 'dismantle', $1, $2, $3, 'approved', true, $4::jsonb, now(), 3)`, [type, site[s]!.id, site[s]!.region, JSON.stringify(data)]);
  };
  await dis('T4', 'cw', { rfd_date: await ago(db, 40), work_start_date: await ago(db, 30), work_end_date: await ago(db, 20), closing_rn_ref: 'RN-1', closed: true });
  await dis('B1', 'te', { rfd_date: await ago(db, 10) });
  return { site, td, userX, userY, party, today: await today(db) };
}

async function ago(db: PgClient, n: number): Promise<string> {
  return (await q<{ d: string }>(db, 'SELECT (cal_today() - $1::int)::text AS d', [n]))[0]!.d;
}
export { ago };
