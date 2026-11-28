import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { DbService } from '../db/db.service';

/** A body of a settings save: an object; the reason is sent to the database apart from the closed rest. */
function split(raw: unknown): { reason: string | null; rest: Record<string, unknown> } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw problems.validation([{ path: '/', code: 'invalid', message: 'The body is a JSON object.' }]);
  }
  const { reason, ...rest } = raw as Record<string, unknown>;
  if (reason !== undefined && typeof reason !== 'string') {
    throw problems.validation([{ path: '/reason', code: 'invalid', message: 'The reason is text.' }]);
  }
  return { reason: typeof reason === 'string' ? reason : null, rest };
}

/**
 * Migration 0145 (contract 0.15.61): the system-settings screens the web served from mocks only. The database owns every rule (the readers and the doors
 * dlp_settings_json, admin_publish_dlp, idle_task_alert_json, admin_set_idle_task_alert, notification_policy_json, notification_catalogue_json and
 * admin_set_notification_policy): who may read or write (admin.settings, System Admin or an all-regions delegate), the closed schemas with field errors,
 * the cross-field rules, the versions, the step-up and the audit rows. The service only shapes the call and keeps the step-up method of the session.
 */
@Injectable()
export class SettingsScreensService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  private async one<T>(sql: Prisma.Sql): Promise<T> {
    const r = await this.db.tx.$queryRaw<{ j: T }[]>(sql);
    return r[0]!.j;
  }

  /** A door that may ask for a step-up: the database decides when (the notification policy); the session decides how (password or password and code). */
  private async withStepUp<T>(auth: AuthContext, sql: Prisma.Sql): Promise<T> {
    await this.db.tx.$executeRaw`SAVEPOINT ssa_call`;
    try {
      const r = await this.one<T>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT ssa_call`;
      return r;
    } catch (e) {
      const p = e instanceof ProblemException ? e : mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT ssa_call`;
      if (p.code === 'step_up_required') await this.stepUp.require(auth);
      throw p;
    }
  }

  // ------------------------------------------------------------------ DLP
  /** GET /settings/dlp (every signed-in user) */
  dlp(): Promise<unknown> {
    return this.one(Prisma.sql`SELECT dlp_settings_json() AS j`);
  }

  /** POST /settings/dlp/versions (step-up) */
  async publishDlp(auth: AuthContext, raw: unknown): Promise<unknown> {
    const { reason, rest } = split(raw);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_publish_dlp(${JSON.stringify(rest)}::jsonb, ${reason}::text) AS j`);
  }

  // ------------------------------------------------------------------ idle-task alert
  /** GET /settings/idle-task-alert (every signed-in user: it drives the stale badge) */
  idle(): Promise<{ version: number }> {
    return this.one(Prisma.sql`SELECT idle_task_alert_json() AS j`);
  }

  /** PUT /settings/idle-task-alert (If-Match) */
  setIdle(ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(raw);
    return this.one(Prisma.sql`SELECT admin_set_idle_task_alert(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
  }

  // ------------------------------------------------------------------ planned-date rules (A4, migration 0603)
  /** GET /settings/plan-rules */
  planRules(): Promise<{ version: number }> {
    return this.one(Prisma.sql`SELECT plan_rules_json() AS j`);
  }

  /** PUT /settings/plan-rules (If-Match) */
  setPlanRules(ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(raw);
    return this.one(Prisma.sql`SELECT admin_save_plan_rules(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
  }

  // ------------------------------------------------------------------ table display (W8, migration 0148)
  /** GET /settings/table-display (every signed-in user: every site-data table starts from these defaults) */
  tableDisplay(): Promise<{ version: number }> {
    return this.one(Prisma.sql`SELECT table_display_json() AS j`);
  }

  /** PUT /settings/table-display (If-Match) */
  setTableDisplay(ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(raw);
    return this.one(Prisma.sql`SELECT admin_set_table_display(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
  }

  // ------------------------------------------------------------------ interface features (migration 0280)
  /** GET /settings/ui-features (every signed-in user: the avatars, the New badge and the other interface features read it) */
  uiFeatures(): Promise<{ version: number }> {
    return this.one(Prisma.sql`SELECT ui_features_json() AS j`);
  }

  /** PUT /settings/ui-features (If-Match) */
  setUiFeatures(ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(raw);
    return this.one(Prisma.sql`SELECT admin_set_ui_features(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
  }

  // ------------------------------------------------------------------ notification policy
  /** GET /settings/notification-policy (view on admin.settings) */
  policy(): Promise<{ version: number }> {
    return this.one(Prisma.sql`SELECT notification_policy_json() AS j`);
  }

  /** GET /settings/notification-policy/catalogue (view on admin.settings) */
  catalogue(): Promise<unknown> {
    return this.one(Prisma.sql`SELECT notification_catalogue_json() AS j`);
  }

  /** PUT /settings/notification-policy (If-Match; step-up and a System Admin for the security and system rows) */
  setPolicy(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<{ version: number }> {
    const version = parseIfMatch(ifMatch);
    const { reason, rest } = split(raw);
    return this.withStepUp(auth, Prisma.sql`SELECT admin_set_notification_policy(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
  }
}
