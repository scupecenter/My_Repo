import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './dash-fixture';
import { superDb } from './helpers';

/**
 * Migration 0593 (contract 0.15.590): the site-complexity weighting of the progress calculation (owner approval
 * 2026-11-28, relayed by Main; plan 2026-11-27-progress-standards). A site's coefficient is its applicable weight
 * share over the project average, clamped to [0.25, 4]; region and project rollups weigh each site's task
 * instances by it; a site's own row is unchanged; dashboard.site_complexity_weighting = false restores the old
 * behaviour exactly. The suite seeds one full-scope site (every task open) and two minimal sites (one small task
 * approved, the rest na) on the shared database and drives the SQL pipeline the way dash_core does.
 */
let db: PgClient;

const SEED = `
  INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, updated_at)
  SELECT c, c, 1, (SELECT id FROM workflow_definitions WHERE version = 1), 'new_build', 'in_progress', now()
  FROM (VALUES ('CX-FULL'), ('CX-MIN1'), ('CX-MIN2')) v(c);
  INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, updated_at)
  SELECT s.id, 1, td.id, 'open', 0, 1, now()
  FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id
  WHERE s.site_code = 'CX-FULL';
  INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
  SELECT s.id, 1, td.id,
         CASE WHEN td.code = 'A1' THEN 'approved' ELSE 'na' END::"TaskState",
         0, 1,
         CASE WHEN td.code = 'A1' THEN cal_today() END,
         CASE WHEN td.code = 'A1' THEN now() END,
         now()
  FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id
  WHERE s.site_code IN ('CX-MIN1', 'CX-MIN2') AND td.code IN ('A1', 'A2', 'A3');
`;

/** Runs the live dashboard build inside one transaction (the temp tables die at commit) and returns the rows. */
async function runPipeline(): Promise<{ coeff: Record<string, number>; project: number; sites: Record<string, number>; flag: boolean }> {
  await db.query('BEGIN');
  try {
    await db.query('SELECT dash_build_cal()');
    await db.query('SELECT dash_build_facts(cal_today(), NULL, NULL, NULL, NULL)');
    await db.query(`SELECT dash_build_items(cal_today(), public.weight_set_in_force('project_status', cal_today()), true)`);
    const coeff: Record<string, number> = {};
    for (const r of await q<{ site_code: string; coeff: number }>(db,
      `SELECT s.site_code, c.coeff::float8 AS coeff FROM _dscf c JOIN sites s ON s.id = c.site_id WHERE s.site_code LIKE 'CX-%'`)) coeff[r.site_code] = r.coeff;
    const proj = await q<{ pct: number }>(db, `SELECT (r ->> 'progress_pct')::float8 AS pct FROM jsonb_array_elements(public.dash_ps_rows('none', true)) r`);
    const sites: Record<string, number> = {};
    for (const r of await q<{ k: string; pct: number }>(db,
      `SELECT r ->> 'key' AS k, (r ->> 'progress_pct')::float8 AS pct FROM jsonb_array_elements(public.dash_ps_rows('site', false)) r WHERE r ->> 'key' LIKE 'CX-%'`)) sites[r.k] = r.pct;
    const flag = (await q<{ f: boolean }>(db, `SELECT (public.dash_ps_card(true) ->> 'site_complexity_weighting')::boolean AS f`))[0]!.f;
    return { coeff, project: proj[0]!.pct, sites, flag };
  } finally {
    await db.query('ROLLBACK');
  }
}

const setWeighting = async (on: boolean): Promise<void> => {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('dashboard.site_complexity_weighting', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [on ? 'true' : 'false']);
};

beforeAll(async () => {
  db = await superDb();
  await db.query('SET session_replication_role = replica');
  await db.query(`DELETE FROM task_instances WHERE site_id IN (SELECT id FROM sites WHERE site_code LIKE 'CX-%')`);
  await db.query(`DELETE FROM sites WHERE site_code LIKE 'CX-%'`);
  await db.query(SEED);
});

afterAll(async () => {
  await db.query(`DELETE FROM task_instances WHERE site_id IN (SELECT id FROM sites WHERE site_code LIKE 'CX-%')`);
  await db.query(`DELETE FROM sites WHERE site_code LIKE 'CX-%'`);
  await db.query(`DELETE FROM settings WHERE key = 'dashboard.site_complexity_weighting'`);
  await db.end();
});

describe('0593: site-complexity weighting', () => {
  it('derives a coefficient above 1 for the full-scope site and clamps the minimal sites at 0.25', async () => {
    await setWeighting(true);
    const r = await runPipeline();
    expect(r.coeff['CX-FULL']).toBeGreaterThan(1);
    expect(r.coeff['CX-MIN1']).toBe(0.25);
    expect(r.coeff['CX-MIN2']).toBe(0.25);
  });

  it('pulls the project figure toward the complex site and leaves per-site rows unchanged', async () => {
    await setWeighting(true);
    const on = await runPipeline();
    await setWeighting(false);
    const off = await runPipeline();
    // the full-scope site is 0% done and the minimal sites 100%: weighting must lower the pooled figure
    expect(on.project).toBeLessThan(off.project);
    expect(on.project).toBeCloseTo(off.project * (0.5 / (on.coeff['CX-FULL']! + 0.5)) / (2 / 3), 2);
    expect(on.sites).toEqual(off.sites);
    expect(on.sites['CX-FULL']).toBe(0);
    expect(on.sites['CX-MIN1']).toBe(100);
  });

  it('setting off pins every coefficient to 1 (exactly the previous behaviour) and reports the flag', async () => {
    await setWeighting(false);
    const off = await runPipeline();
    expect(Object.values(off.coeff).every((c) => c === 1)).toBe(true);
    expect(off.flag).toBe(false);
    await setWeighting(true);
    const on = await runPipeline();
    expect(on.flag).toBe(true);
  });
});
