import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDbPstd } from './helpers';

/**
 * Migration 0547 (0.15.269, owner decision 2026-11-27): the B11 split. Draft workflow v2 carries B12 (Internal AC/DC) and B16 (Site internal fiber)
 * after B9 like B11, feeding MS3, with the B11 SLA; B9/B11/B12/B16 apply to every site; GECOL/HLC rules unchanged; the draft v2 weight set reads
 * 4.3 = [B11,B12] and 4.5 = [B11,B16] while published v1 keeps B11 only; the site migration carries an approved B11 into B12/B16 approvals with
 * the B11 date and leaves B12/B16 open when B11 is in progress.
 */
let db: PgClient;

beforeAll(async () => {
  db = await superDbPstd();
});
afterAll(async () => {
  await db.end();
});

const V2 = `(SELECT id FROM workflow_definitions WHERE version = 2)`;

describe('the draft workflow v2', () => {
  it('exists as a draft with B12 and B16 after B9 in MS3, counting toward the milestone', async () => {
    const r = await db.query(
      `SELECT t.code, t.sort_order, t.counts_toward_milestone FROM task_definitions t JOIN stage_definitions s ON s.id = t.stage_id
       WHERE s.workflow_id = ${V2} AND s.code = 'MS3' AND t.is_active ORDER BY t.sort_order`);
    expect(r.rows.map((x) => x.code)).toEqual(['B8', 'B9', 'B10', 'B11', 'B12', 'B16', 'MS3']);
    for (const row of r.rows.filter((x) => ['B11', 'B12', 'B16'].includes(x.code))) expect(row.counts_toward_milestone).toBe(true);
  });

  it('gives B12/B16 the B9 predecessor and the B11 SLA, and MS3 all of B10/B11/B12/B16', async () => {
    const r = await db.query(
      `SELECT t.code AS task, pt.code AS pred FROM task_predecessors p
       JOIN task_definitions t ON t.id = p.task_def_id JOIN task_definitions pt ON pt.id = p.predecessor_id
       WHERE t.workflow_id = ${V2} AND t.code IN ('B12', 'B16', 'MS3')`);
    const preds = (c: string) => r.rows.filter((x) => x.task === c).map((x) => x.pred).sort();
    expect(preds('B12')).toEqual(['B9']);
    expect(preds('B16')).toEqual(['B9']);
    expect(preds('MS3')).toEqual(['B10', 'B11', 'B12', 'B16']);
    const sla = await db.query(
      `SELECT t.code, r.min_working_days, r.max_working_days, r.start_event, r.start_ref FROM sla_rules r JOIN task_definitions t ON t.id = r.task_def_id
       WHERE t.workflow_id = ${V2} AND t.code IN ('B12', 'B16') AND r.effective_to IS NULL ORDER BY t.code`);
    expect(sla.rows).toHaveLength(2);
    for (const row of sla.rows) {
      expect([row.min_working_days, row.max_working_days]).toEqual([4, 8]);
      expect(row.start_event).toBe('CW MOS Actual (AZ)');
      expect(row.start_ref).toBe('B9');
    }
  });

  it('applies B9/B11/B12/B16 to every site and keeps the GECOL/HLC rules', async () => {
    const r = await db.query(`SELECT task_code, rule, flag_expr FROM scenario_task_rules WHERE workflow_id = ${V2} AND is_active`);
    const forTask = (c: string) => r.rows.filter((x) => x.task_code === c);
    // no adaption_only (or any flag) restriction on the four, so they apply to every site
    for (const c of ['B9', 'B11', 'B12', 'B16']) expect(forTask(c).filter((x) => x.rule === 'flag')).toHaveLength(0);
    expect(forTask('B12')).toHaveLength(0);
    expect(forTask('B16')).toHaveLength(0);
    for (const [c, flag] of [['C1', 'gecol'], ['C2', 'gecol'], ['C3', 'hlc'], ['C4', 'hlc']] as const) {
      expect(forTask(c).some((x) => x.rule === 'flag' && x.flag_expr === flag)).toBe(true);
    }
  });
});

describe('the weight sets over the split', () => {
  const ITEMS = `FROM weight_items i JOIN weight_activities a ON a.id = i.activity_id JOIN weight_sets s ON s.id = a.weight_set_id WHERE s.code = 'project_status'`;
  it('keeps published v1 on B11 only and links the draft v2 to both codes', async () => {
    const r = await db.query(`SELECT s.version, i.code, i.measure_rule -> 'tasks' AS tasks ${ITEMS} AND i.code IN ('4.1', '4.3', '4.5') ORDER BY s.version, i.code`);
    const get = (v: number, c: string) => r.rows.find((x) => x.version === v && x.code === c)?.tasks as string[];
    expect(get(1, '4.3')).toEqual(['B11']);
    expect(get(1, '4.5')).toEqual(['B11']);
    expect(get(2, '4.1')).toEqual(['B11']);
    expect(get(2, '4.3')).toEqual(['B11', 'B12']);
    expect(get(2, '4.5')).toEqual(['B11', 'B16']);
  });

  it('lets B12 move only 4.3 and B16 only 4.5', async () => {
    const r = await db.query(`SELECT i.code, i.measure_rule -> 'tasks' AS tasks ${ITEMS} AND s.version = 2 AND s.status = 'draft'`);
    const withTask = (t: string) => r.rows.filter((x) => Array.isArray(x.tasks) && (x.tasks as string[]).includes(t)).map((x) => x.code);
    expect(withTask('B12')).toEqual(['4.3']);
    expect(withTask('B16')).toEqual(['4.5']);
  });

  it('keeps every activity at 100', async () => {
    for (const v of [1, 2]) {
      const r = await db.query(`SELECT a.code, sum(i.weight)::numeric AS total ${ITEMS} AND s.version = ${v} GROUP BY a.code`);
      expect(r.rows).toHaveLength(8);
      for (const row of r.rows) expect(Number(row.total)).toBe(100);
    }
  });
});

describe('the site migration carry-over', () => {
  it('approves B12/B16 with the B11 date, or leaves them open when B11 is in progress', async () => {
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO users (id, display_name, status, email, updated_at) VALUES ('11111111-1111-1111-1111-111111111111', 'b11 split test', 'active', 'b11-split-test@example.invalid', now())`);
      await db.query(`INSERT INTO groups (id, name, is_system_admins, is_active) VALUES ('22222222-2222-2222-2222-222222222222', 'b11 split test admins', true, true)`);
      await db.query(`INSERT INTO group_members (group_id, user_id) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')`);
      await db.query(`SELECT set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true)`);
      await db.query(`UPDATE workflow_definitions SET status = 'published' WHERE version = 2`);
      await db.query(
        `INSERT INTO sites (site_code, name, region_id, workflow_version_id, updated_at)
         SELECT 'ZZ-SPLIT-1', 'split test 1', 1, id, now() FROM workflow_definitions WHERE version = 1`);
      await db.query(
        `INSERT INTO sites (site_code, name, region_id, workflow_version_id, updated_at)
         SELECT 'ZZ-SPLIT-2', 'split test 2', 1, id, now() FROM workflow_definitions WHERE version = 1`);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT s.id, 1, td.id, 'approved', 2, 2, '2026-11-10', '2026-11-10', now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'B9' WHERE s.site_code LIKE 'ZZ-SPLIT-%'`);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT s.id, 1, td.id, 'approved', 2, 2, '2026-11-20', '2026-11-20', now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'B11' WHERE s.site_code = 'ZZ-SPLIT-1'`);
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, updated_at)
         SELECT s.id, 1, td.id, 'entry', 0, 2, now()
         FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = 'B11' WHERE s.site_code = 'ZZ-SPLIT-2'`);
      const mig = await db.query(
        `SELECT admin_migrate_sites_to_workflow(ARRAY(SELECT id FROM sites WHERE site_code LIKE 'ZZ-SPLIT-%'), ${V2}, 'b11 split test') AS n`);
      expect(mig.rows[0]!.n).toBe(2);
      const rows = await db.query(
        `SELECT s.site_code, t.code, ti.state, ti.actual_date::text AS actual, ti.approved_date::text AS approved
         FROM task_instances ti JOIN task_definitions t ON t.id = ti.task_def_id JOIN sites s ON s.id = ti.site_id
         WHERE s.site_code LIKE 'ZZ-SPLIT-%' AND t.code IN ('B11', 'B12', 'B16') ORDER BY s.site_code, t.code`);
      const get = (site: string, code: string) => rows.rows.find((x) => x.site_code === site && x.code === code);
      expect(get('ZZ-SPLIT-1', 'B11')!.state).toBe('approved');
      for (const c of ['B12', 'B16']) {
        expect(get('ZZ-SPLIT-1', c)!.state).toBe('approved');
        expect(get('ZZ-SPLIT-1', c)!.actual.slice(0, 10)).toBe('2026-11-20');
        expect(get('ZZ-SPLIT-1', c)!.approved.slice(0, 10)).toBe('2026-11-20');
        expect(get('ZZ-SPLIT-2', c)!.state).toBe('open');
      }
      expect(get('ZZ-SPLIT-2', 'B11')!.state).toBe('entry');
      const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'workflow_migration_b11_split'`);
      expect(audit.rows[0]!.n).toBe(2);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
