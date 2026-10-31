import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import { DbService } from '../db/db.service';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException } from '../common/problem';
import { AssignmentDto, GroupRef, UserDto, UsersRepo } from '../users/users.repo';

/** Module keys the web app knows (apps/web/src/components/Shell.tsx NAV). A System Admin sees all of them. */
export const NAV_KEYS = [
  'my_work', 'approvals', 'sites', 'dashboard', 'templates', 'admin.users', 'admin.roles', 'admin.groups', 'admin.delegation',
  'absence', 'admin.matrix', 'admin.settings', 'admin.security_log', 'admin.online', 'audit', 'messages', 'announcements',
] as const;

/** Every action of the contract's PermissionAction (a System Admin holds all of them on every module). */
const ALL_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'import', 'download_documents', 'view_audit', 'administer', 'manage_users', 'view_security_log'] as const;
const LEVEL_ORDER = ['view', 'entry', 'review', 'approve', 'admin'];

type RegionSet = 'all' | number[];

export interface EffectiveDto {
  grants: { module_key: string; action: string; region_ids: RegionSet }[];
  nav: string[];
  matrix_levels: { module_key: string; level: string; region_ids: RegionSet }[];
}

export interface MeDto {
  user: UserDto;
  assignments: AssignmentDto[];
  groups: GroupRef[];
  is_system_admin: boolean;
  effective: EffectiveDto;
}

class RegionAcc {
  all = false;
  ids = new Set<number>();
  add(r: RegionSet): void {
    if (r === 'all') this.all = true;
    else r.forEach((x) => this.ids.add(x));
  }
  value(): RegionSet {
    return this.all ? 'all' : [...this.ids].sort((a, b) => a - b);
  }
}

@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly repo: UsersRepo,
    private readonly access: AccessService,
  ) {}

  async me(auth: AuthContext): Promise<MeDto> {
    const user = await this.repo.find(auth.user.id);
    if (!user) throw new ProblemException(401, 'unauthenticated', {});
    const [assignments, groups] = await Promise.all([this.repo.assignmentsOf(auth.user.id), this.repo.groupsOf(auth.user.id)]);
    return {
      user,
      assignments,
      groups,
      is_system_admin: auth.state.isAdmin,
      effective: await this.effective(auth, assignments),
    };
  }

  /**
   * Union over the active assignments (profiles of each, limited to the assignment's modules and regions) plus delegated
   * rights; scopes never cross (ADR 0003 item 1). A System Admin has everything.
   */
  async effective(auth: AuthContext, assignments: AssignmentDto[]): Promise<EffectiveDto> {
    if (auth.state.isAdmin) {
      return {
        grants: ALL_ACTIONS.map((action) => ({ module_key: '*', action, region_ids: 'all' as const })),
        nav: [...NAV_KEYS],
        matrix_levels: [{ module_key: '*', level: 'admin', region_ids: 'all' }],
      };
    }
    if (auth.state.pending || auth.user.status !== 'active') return { grants: [], nav: [], matrix_levels: [] };

    const active = assignments.filter((a) => a.is_active_now);
    const grants = new Map<string, { module_key: string; action: string; acc: RegionAcc }>();
    const put = (module: string, action: string, regions: RegionSet): void => {
      const k = `${module}\u0000${action}`;
      let g = grants.get(k);
      if (!g) grants.set(k, (g = { module_key: module, action, acc: new RegionAcc() }));
      g.acc.add(regions);
    };

    const profileIds = [...new Set(active.flatMap((a) => a.profile_ids))];
    const profileGrants = profileIds.length
      ? await this.db.tx.permissionGrant.findMany({ where: { profile_id: { in: profileIds }, profile: { is_active: true } } })
      : [];
    for (const a of active) {
      for (const g of profileGrants) {
        if (!a.profile_ids.includes(g.profile_id)) continue;
        const top = g.module_key.split('.')[0] ?? g.module_key;
        if (a.module_keys === 'all' || a.module_keys.includes(top)) put(g.module_key, g.action, a.region_ids);
      }
    }

    // Delegations that apply to the user (directly, through a role or through a group).
    const deleg = await this.db.tx.$queryRaw<{ id: string; is_full: boolean; all_regions: boolean; regions: number[] | null }[]>(Prisma.sql`
      SELECT d.id::text AS id, d.is_full, d.all_regions,
             (SELECT array_agg(dr.region_id) FROM delegation_regions dr WHERE dr.delegation_id = d.id) AS regions
      FROM app_user_delegations(${auth.user.id}::uuid) x(id) JOIN delegations d ON d.id = x.id`);
    for (const d of deleg) {
      const regions: RegionSet = d.all_regions ? 'all' : (d.regions ?? []);
      if (d.is_full) for (const action of ALL_ACTIONS) put('*', action, regions);
      const dg = await this.db.tx.delegationGrant.findMany({ where: { delegation_id: d.id } });
      for (const g of dg) put(g.module_key, g.action, regions);
    }

    const effGrants = [...grants.values()]
      .map((g) => ({ module_key: g.module_key, action: g.action, region_ids: g.acc.value() }))
      .sort((a, b) => a.module_key.localeCompare(b.module_key) || a.action.localeCompare(b.action));

    const nav = new Set<string>();
    for (const g of effGrants) {
      if (g.action !== 'view') continue;
      if (g.module_key === '*') NAV_KEYS.forEach((k) => nav.add(k));
      else nav.add(g.module_key);
    }

    // Highest permission level per module and region set, for roles that may hold matrix levels.
    const levels = new Map<string, { module_key: string; level: string; region_ids: RegionSet }>();
    const roles = await this.db.tx.role.findMany({ where: { id: { in: active.map((a) => a.role.id) } }, select: { id: true, can_hold_matrix_levels: true } });
    const canHold = new Set(roles.filter((r) => r.can_hold_matrix_levels).map((r) => r.id));
    for (const a of active) {
      if (!canHold.has(a.role.id)) continue;
      const mods = a.module_keys === 'all' ? ['*'] : a.module_keys;
      for (const m of mods) {
        const k = `${m}\u0000${JSON.stringify(a.region_ids)}`;
        const cur = levels.get(k);
        if (!cur || LEVEL_ORDER.indexOf(a.permission_level) > LEVEL_ORDER.indexOf(cur.level)) {
          levels.set(k, { module_key: m, level: a.permission_level, region_ids: a.region_ids });
        }
      }
    }
    // Messages are for every active user; Announcements for System Admins (above) and delegates of announcements.create.
    nav.add('messages');
    if (await this.access.canSendAnnouncements()) nav.add('announcements');
    return { grants: effGrants, nav: [...nav].sort(), matrix_levels: [...levels.values()] };
  }
}
