import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { Api, TestUser, loggedIn, makeAdmin, makeUser } from './helpers';

/** Fixtures for the approval engine, written straight into the database as the superuser. */

let seq = 0;
const uniq = (): string => `${process.pid}${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(2).toString('hex')}`;

export interface Actor {
  user: TestUser;
  api: Api;
  roleId: string;
}

export interface ActorOptions {
  /** permission level of the assignment (decides matrix eligibility) */
  level?: 'view' | 'entry' | 'review' | 'approve' | 'admin';
  /** grid grants of the assignment's profile; default = view, edit and approve on sites and view on approvals */
  grants?: [string, string][];
  /** null = all regions */
  regions?: number[] | null;
  /** null = all modules */
  modules?: string[] | null;
  stepUp?: boolean;
}

const DEFAULT_GRANTS: [string, string][] = [
  ['sites', 'view'], ['sites', 'edit'], ['sites', 'approve'], ['approvals', 'view'], ['approvals', 'approve'],
];

/** A role with its own code (so a matrix cell can name it), used by assignments. */
export async function newRole(db: PgClient, canHold = true): Promise<string> {
  const code = `WFR_${uniq().toUpperCase()}`;
  const r = await db.query('INSERT INTO roles (code, name_en, can_hold_matrix_levels) VALUES ($1, $1, $2) RETURNING id', [code, canHold]);
  return r.rows[0].id as string;
}

/** One assignment with its own regions, modules, level and profile, inserted in one transaction (the scope check is deferred). */
export async function addAssignment(
  db: PgClient, userId: string, o: { roleId?: string; level?: string; regions?: number[] | null; modules?: string[] | null; grants?: [string, string][] } = {},
): Promise<string> {
  const roleId = o.roleId ?? (await newRole(db));
  const profile = await db.query('INSERT INTO permission_profiles (code, name_en) VALUES ($1, $1) RETURNING id', [`WFP_${uniq()}`]);
  for (const [m, a] of o.grants ?? DEFAULT_GRANTS) {
    await db.query('INSERT INTO permission_grants (profile_id, module_key, action) VALUES ($1, $2, $3::"PermissionAction")', [profile.rows[0].id, m, a]);
  }
  await db.query('BEGIN');
  try {
    const a = await db.query(
      `INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, $3::"PermissionLevel", $4, $5) RETURNING id`,
      [userId, roleId, o.level ?? 'approve', o.regions == null, o.modules == null],
    );
    const id = a.rows[0].id as string;
    for (const r of o.regions ?? []) await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, $2)', [id, r]);
    for (const m of o.modules ?? []) await db.query('INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, $2)', [id, m]);
    await db.query('INSERT INTO user_role_assignment_profiles (assignment_id, profile_id) VALUES ($1, $2)', [id, profile.rows[0].id]);
    await db.query('COMMIT');
    return id;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

/** A user with one assignment, signed in. */
export async function actor(app: NestExpressApplication, db: PgClient, o: ActorOptions = {}): Promise<Actor> {
  const user = await makeUser(db, { status: 'active' });
  const roleId = await newRole(db);
  await addAssignment(db, user.id, { roleId, level: o.level, regions: o.regions, modules: o.modules, grants: o.grants });
  const api = await loggedIn(app, user);
  if (o.stepUp !== false) {
    const res = await api.stepUp(user.password);
    if (res.status !== 200) throw new Error(`step-up failed in test setup: ${res.status}`);
  }
  return { user, api, roleId };
}

/** A System Admin who is signed in (step-up optional). */
export async function plainAdmin(app: NestExpressApplication, db: PgClient, stepUp = true): Promise<Actor> {
  const user = await makeAdmin(db);
  const api = await loggedIn(app, user);
  if (stepUp) await api.stepUp(user.password);
  return { user, api, roleId: '' };
}

export async function groupWith(db: PgClient, memberIds: string[]): Promise<string> {
  const g = await db.query('INSERT INTO groups (name) VALUES ($1) RETURNING id', [`wfgroup-${uniq()}`]);
  for (const m of memberIds) await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g.rows[0].id, m]);
  return g.rows[0].id as string;
}

export interface Site {
  id: string;
  code: string;
  region: number;
}

export async function makeSite(db: PgClient, region = 5, over: { scenario?: string; cluster?: string; prefix?: string; status?: string } = {}): Promise<Site> {
  const code = `${over.prefix ?? 'WF'}-${uniq().toUpperCase()}`;
  const wf = await db.query('SELECT id FROM workflow_definitions WHERE version = 1');
  const r = await db.query(
    `INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, cluster_id, overall_status, updated_at)
     VALUES ($1, $2, $3, $4, $5::"DeliveryScenario", $6, $7::"OverallStatus", now()) RETURNING id`,
    [code, `Site ${code}`, region, wf.rows[0].id, over.scenario ?? 'new_build', over.cluster ?? null, over.status ?? 'in_progress'],
  );
  return { id: r.rows[0].id as string, code, region };
}

export async function taskDef(db: PgClient, code: string): Promise<{ id: string; stage_id: string }> {
  const r = await db.query('SELECT td.id, td.stage_id FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = $1', [code]);
  return r.rows[0] as { id: string; stage_id: string };
}

export async function makeTask(db: PgClient, site: Site, code: string, state = 'open', over: { level?: number; levels?: number; actualDate?: string | null; dueDate?: string | null } = {}): Promise<string> {
  const td = await taskDef(db, code);
  const level = over.level ?? (state === 'open' || state === 'entry' ? 1 : state === 'in_review' ? 2 : state === 'in_approval' ? 3 : 0);
  const r = await db.query(
    `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, due_date, level_opened_at, level_round, updated_at)
     VALUES ($1, $2, $3, $4::"TaskState", $5, $6, $7, $8, now(), 1, now()) RETURNING id`,
    [site.id, site.region, td.id, state, level, over.levels ?? 3, over.actualDate ?? null, over.dueDate ?? null],
  );
  return r.rows[0].id as string;
}

/** Replaces the matrix cell of (task, level, region) and names its holders. Region-specific, so parallel suites in other regions do not meet it. */
export async function setCell(
  db: PgClient, taskCode: string, region: number, kind: 'entry' | 'review' | 'approve',
  assignees: { user?: string[]; role?: string[]; group?: string[] }, rule: 'any_one' | 'all_members' = 'any_one',
): Promise<string> {
  const td = await taskDef(db, taskCode);
  const level = kind === 'entry' ? 1 : kind === 'review' ? 2 : 3;
  await db.query('DELETE FROM matrix_cells WHERE stage_id = $1 AND task_def_id = $2 AND level = $3 AND region_id = $4', [td.stage_id, td.id, level, region]);
  const c = await db.query(
    'INSERT INTO matrix_cells (stage_id, task_def_id, level, rule, region_id, is_global, updated_at) VALUES ($1, $2, $3, $4::"MatrixRule", $5, false, now()) RETURNING id',
    [td.stage_id, td.id, level, rule, region],
  );
  const id = c.rows[0].id as string;
  for (const [k, list] of [['user', assignees.user], ['role', assignees.role], ['group', assignees.group]] as const) {
    for (const ref of list ?? []) await db.query('INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, $2::"AssigneeKind", $3)', [id, k, ref]);
  }
  return id;
}

export const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
