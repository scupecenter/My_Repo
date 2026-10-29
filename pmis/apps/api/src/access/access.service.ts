import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ProblemException } from '../common/problem';
import type { AuthContext } from '../auth/auth.types';

/** Actions the database enum "PermissionAction" knows (the contract lists two more that migration 0007 has not added yet). */
export type DbAction = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export' | 'import' | 'download_documents' | 'view_audit' | 'administer';

/**
 * Permission checks answer from the database resolvers (ADR 0003): the API asks, the database decides.
 * The idm_* functions repeat the same check, so a bug here cannot widen anyone's rights.
 */
@Injectable()
export class AccessService {
  constructor(private readonly db: DbService) {}

  /** System Admin, or an active delegation covering (module, action). The test every idm_* write applies. */
  async isAdmin(module: string, action: DbAction): Promise<boolean> {
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT app_actor_is_admin(${module}, ${action}::"PermissionAction") AS ok`;
    return rows[0]?.ok === true;
  }

  async requireAdmin(module: string, action: DbAction): Promise<void> {
    if (!(await this.isAdmin(module, action))) {
      throw new ProblemException(403, 'action_forbidden', { detail: `You need ${action} on ${module}.` });
    }
  }

  /** The permission grid (profiles of the active assignments, delegations, System Admin). */
  async hasGrant(auth: AuthContext, module: string, action: DbAction): Promise<boolean> {
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT app_has_permission(${auth.user.id}::uuid, ${module}, ${action}::"PermissionAction") AS ok`;
    return rows[0]?.ok === true;
  }

  /** A module the caller cannot use at all answers 403 module_forbidden (contract conventions). */
  async requireModuleView(auth: AuthContext, module: string): Promise<void> {
    if (!(await this.hasGrant(auth, module, 'view'))) {
      throw new ProblemException(403, 'module_forbidden', { detail: `You cannot use ${module}.` });
    }
  }

  /** 403 module_forbidden unless the caller may view at least one of the modules (screens that several admin roles share). */
  async requireAnyModuleView(auth: AuthContext, modules: string[]): Promise<void> {
    for (const m of modules) if (await this.hasGrant(auth, m, 'view')) return;
    throw new ProblemException(403, 'module_forbidden', { detail: `You cannot use ${modules.join(' or ')}.` });
  }

  /** The caller is an active member of the System Admins group (not merely a delegate). */
  async isSystemAdmin(): Promise<boolean> {
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT app_actor_is_system_admin() AS ok`;
    return rows[0]?.ok === true;
  }

  /**
   * May send announcements: a System Admin, or a delegate of announcements.create covering all regions (the same test
   * as ann_send). Drives the "announcements" navigation entry.
   */
  async canSendAnnouncements(): Promise<boolean> {
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT app_actor_is_admin('announcements', 'create'::"PermissionAction")
      AND (app_actor_is_system_admin() OR app_actor_region_filter('announcements', 'create'::"PermissionAction") IS NULL) AS ok`;
    return rows[0]?.ok === true;
  }
}
