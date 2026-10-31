import type { Client as PgClient } from 'pg';
import { Site, makeSite, makeTask, taskDef } from './wf-helpers';

/** Helpers for the calculation suites: tasks written straight into the database as the superuser, so the triggers of migration 0017 run. */

export const q = async <T = Record<string, unknown>>(db: PgClient, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

/** A date computed by the database, as YYYY-MM-DD. */
export async function dbDate(db: PgClient, expr: string): Promise<string> {
  return (await q<{ d: string }>(db, `SELECT (${expr})::text AS d`))[0]!.d;
}

/** Today in the business time zone plus n working days (negative = back), as the database counts them. */
export const wd = (db: PgClient, n: number, from = 'cal_today()'): Promise<string> => dbDate(db, `cal_add_workdays(${from}, ${n})`);

export async function newSite(db: PgClient, region = 5, over: { scenario?: string } = {}): Promise<Site> {
  return makeSite(db, region, { prefix: 'CALC', ...over });
}

export async function taskId(db: PgClient, site: Site, code: string): Promise<string> {
  const td = await taskDef(db, code);
  return (await q<{ id: string }>(db, 'SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2', [site.id, td.id]))[0]!.id;
}

export async function taskRow(db: PgClient, site: Site, code: string): Promise<Record<string, unknown>> {
  const td = await taskDef(db, code);
  return (await q(db, `SELECT state::text AS state, actual_date::text AS actual_date, approved_date::text AS approved_date, sla_start_date::text AS sla_start_date,
      sla_target_date::text AS sla_target_date, due_date::text AS due_date, sla_end_date::text AS sla_end_date, sla_elapsed_wd, sla_rule_id, lock_reason, values
    FROM task_instances WHERE site_id = $1 AND task_def_id = $2`, [site.id, td.id]))[0]!;
}

/** A locked task (no clock yet). */
export const locked = (db: PgClient, site: Site, code: string): Promise<string> => makeTask(db, site, code, 'locked');

/** Opens a locked task, the way the engine does when its predecessors are approved (this fires the statement trigger). */
export async function open(db: PgClient, id: string): Promise<void> {
  await db.query(`UPDATE task_instances SET state = 'open', current_level = 1 WHERE id = $1`, [id]);
}

/** Approves a task with its actual date and lets the engine unlock the successors (as wf_complete does). */
export async function approve(db: PgClient, site: Site, code: string, date: string): Promise<string> {
  const td = await taskDef(db, code);
  const id = (await q<{ id: string }>(db, 'SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2', [site.id, td.id]))[0]!.id;
  await db.query(`UPDATE task_instances SET state = 'open' WHERE id = $1 AND state = 'locked'`, [id]);
  await db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2, approved_date = $2 WHERE id = $1`, [id, date]);
  await db.query('SELECT wf_unlock_successors($1)', [id]);
  return id;
}

/** All tasks of workflow v1 on the site, locked (the shape of a site as created). */
export async function allLocked(db: PgClient, site: Site): Promise<void> {
  await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, levels_required, updated_at)
     SELECT $1, $2, td.id, 'locked', 3, now() FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1`,
    [site.id, site.region],
  );
}
