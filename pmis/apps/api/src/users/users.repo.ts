import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { contentVersion } from '../common/etag';
import { DbService } from '../db/db.service';

export interface PickerItem {
  id: string;
  display_name: string;
  employee_id: string | null;
}

export interface UserRef { id: string; display_name: string; employee_id: string | null }
export interface DepartmentRef { id: string; code: string; name_en: string; name_ar: string | null }
export interface GroupRef { id: string; name: string; is_system_admins: boolean }

export interface UserDto extends UserRef {
  email: string;
  status: string;
  locale: string;
  theme: string;
  is_break_glass: boolean;
  phone: string | null;
  local_sign_in: boolean;
  must_change_password: boolean;
  manager: UserRef | null;
  department: DepartmentRef | null;
  last_login_at: Date | null;
  created_at: Date;
  version: number;
  deleted_at: Date | null;
  deleted_by: UserRef | null;
  delete_reason: string | null;
}

interface UserDbRow {
  id: string;
  email: string;
  display_name: string;
  employee_id: string | null;
  phone: string | null;
  status: string;
  locale: string;
  theme: string;
  is_break_glass: boolean;
  last_login_at: Date | null;
  created_at: Date;
  version: string;
  local_sign_in: boolean;
  must_change: boolean;
  manager_id: string | null;
  manager_name: string | null;
  manager_employee_id: string | null;
  dept_id: string | null;
  dept_code: string | null;
  dept_name_en: string | null;
  dept_name_ar: string | null;
  deleted_at: Date | null;
  delete_reason: string | null;
  deleted_by_id: string | null;
  deleted_by_name: string | null;
  deleted_by_employee_id: string | null;
}

/**
 * Columns of the contract's User. local_sign_in and must_change_password come from auth_local_lookup (pmis_app cannot read
 * local_credentials). `version` is the microsecond epoch of users.updated_at: an integer that changes with every write to the row.
 */
const USER_SELECT = Prisma.sql`u.id::text AS id, u.email, u.display_name, trim(u.employee_id) AS employee_id, u.phone, u.status::text AS status,
  u.locale, u.theme, u.is_break_glass, u.last_login_at, u.created_at,
  (extract(epoch FROM u.updated_at) * 1000000)::bigint::text AS version,
  (l.user_id IS NOT NULL) AS local_sign_in, coalesce(l.must_change, false) AS must_change,
  m.id::text AS manager_id, m.display_name AS manager_name, trim(m.employee_id) AS manager_employee_id,
  dp.id::text AS dept_id, dp.code AS dept_code, dp.name_en AS dept_name_en, dp.name_ar AS dept_name_ar,
  u.deleted_at, u.delete_reason, dby.id::text AS deleted_by_id, dby.display_name AS deleted_by_name, trim(dby.employee_id) AS deleted_by_employee_id`;
const USER_FROM = Prisma.sql`FROM users u LEFT JOIN LATERAL auth_local_lookup(u.email) l ON true
  LEFT JOIN users m ON m.id = u.manager_id LEFT JOIN departments dp ON dp.id = u.department_id
  LEFT JOIN users dby ON dby.id = u.deleted_by`;

export const toUserDto = (r: UserDbRow): UserDto => ({
  id: r.id,
  display_name: r.display_name,
  employee_id: r.employee_id,
  email: r.email,
  status: r.status,
  locale: r.locale,
  theme: r.theme,
  is_break_glass: r.is_break_glass,
  phone: r.phone,
  local_sign_in: r.local_sign_in,
  must_change_password: r.must_change,
  manager: r.manager_id ? { id: r.manager_id, display_name: r.manager_name ?? '', employee_id: r.manager_employee_id } : null,
  department: r.dept_id ? { id: r.dept_id, code: r.dept_code ?? '', name_en: r.dept_name_en ?? '', name_ar: r.dept_name_ar } : null,
  last_login_at: r.last_login_at,
  created_at: r.created_at,
  version: Number(r.version),
  deleted_at: r.deleted_at,
  deleted_by: r.deleted_by_id ? { id: r.deleted_by_id, display_name: r.deleted_by_name ?? '', employee_id: r.deleted_by_employee_id } : null,
  delete_reason: r.delete_reason,
});

export interface AssignmentDto {
  id: string;
  user: UserRef;
  role: { id: string; code: string; name_en: string; name_ar: string | null };
  permission_level: string;
  team: string;
  region_ids: 'all' | number[];
  module_keys: 'all' | string[];
  profile_ids: string[];
  is_primary: boolean;
  valid_from: Date;
  valid_to: Date | null;
  is_active_now: boolean;
  assigned_by?: UserRef;
  assigned_at: Date;
  version: number;
}

export const ASSIGNMENT_INCLUDE = {
  role: true,
  regions: true,
  modules: true,
  UserRoleAssignmentProfile: true,
  assigner: { select: { id: true, display_name: true, employee_id: true } },
  user: { select: { id: true, display_name: true, employee_id: true } },
} satisfies Prisma.UserRoleAssignmentInclude;

export type AssignmentRow = Prisma.UserRoleAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

/**
 * Assignments have no version column: the version is an integer derived from everything an edit can change, so
 * bulk-update and bulk-end detect a row that changed since it was read (If-Match style, per item).
 */
export function assignmentVersion(a: AssignmentRow): number {
  return contentVersion([
    a.permission_level, a.team, a.valid_from.toISOString(), a.valid_to?.toISOString() ?? null, a.all_regions, a.all_modules, a.is_primary,
    a.regions.map((r) => r.region_id).sort((x, y) => x - y), a.modules.map((m) => m.module_key).sort(),
    a.UserRoleAssignmentProfile.map((p) => p.profile_id).sort(),
  ]);
}

export function toAssignmentDto(a: AssignmentRow, now: Date): AssignmentDto {
  return {
    id: a.id,
    user: { id: a.user.id, display_name: a.user.display_name, employee_id: a.user.employee_id?.trim() ?? null },
    role: { id: a.role.id, code: a.role.code, name_en: a.role.name_en, name_ar: a.role.name_ar },
    permission_level: a.permission_level,
    team: a.team,
    region_ids: a.all_regions ? 'all' : a.regions.map((r) => r.region_id).sort((x, y) => x - y),
    module_keys: a.all_modules ? 'all' : a.modules.map((m) => m.module_key).sort(),
    profile_ids: a.UserRoleAssignmentProfile.map((p) => p.profile_id).sort(),
    is_primary: a.is_primary,
    valid_from: a.valid_from,
    valid_to: a.valid_to,
    is_active_now: a.valid_from <= now && (a.valid_to === null || a.valid_to > now),
    assigned_by: a.assigner ? { id: a.assigner.id, display_name: a.assigner.display_name, employee_id: a.assigner.employee_id?.trim() ?? null } : undefined,
    assigned_at: a.assigned_at,
    version: assignmentVersion(a),
  };
}

export interface UserFilter {
  q?: string;
  status?: string;
  roleId?: string;
  regionId?: number;
  groupId?: string;
  /** true: only soft-deleted users (GET /users/deleted); otherwise soft-deleted users are left out. */
  deleted?: boolean;
}

@Injectable()
export class UsersRepo {
  constructor(private readonly db: DbService) {}

  async find(id: string): Promise<UserDto | null> {
    const rows = await this.db.tx.$queryRaw<UserDbRow[]>(Prisma.sql`SELECT ${USER_SELECT} ${USER_FROM} WHERE u.id = ${id}::uuid`);
    return rows[0] ? toUserDto(rows[0]) : null;
  }

  async list(filter: UserFilter, limit: number, after: [string, string] | null, like: string | null): Promise<{ rows: UserDto[]; total: number }> {
    // Soft-deleted users (B14) are listed only by listDeleted.
    const where: Prisma.Sql[] = [filter.deleted ? Prisma.sql`u.deleted_at IS NOT NULL` : Prisma.sql`u.deleted_at IS NULL`];
    if (like) where.push(Prisma.sql`(u.display_name ILIKE ${like} OR u.email ILIKE ${like} OR u.employee_id ILIKE ${like} OR u.phone ILIKE ${like})`);
    if (filter.status) where.push(Prisma.sql`u.status = ${filter.status}::"UserStatus"`);
    if (filter.groupId) where.push(Prisma.sql`EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = u.id AND gm.group_id = ${filter.groupId}::uuid)`);
    if (filter.roleId) {
      where.push(Prisma.sql`EXISTS (SELECT 1 FROM user_role_assignments a WHERE a.user_id = u.id AND a.role_id = ${filter.roleId}::uuid
        AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))`);
    }
    if (filter.regionId !== undefined) {
      where.push(Prisma.sql`EXISTS (SELECT 1 FROM user_role_assignments a WHERE a.user_id = u.id AND a.valid_from <= now()
        AND (a.valid_to IS NULL OR a.valid_to > now())
        AND (a.all_regions OR EXISTS (SELECT 1 FROM user_role_assignment_regions r WHERE r.assignment_id = a.id AND r.region_id = ${filter.regionId}::int)))`);
    }
    const base = Prisma.join(where, ' AND ');
    const page = after ? Prisma.sql`AND (u.display_name, u.id::text) > (${after[0]}, ${after[1]})` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<UserDbRow[]>(Prisma.sql`SELECT ${USER_SELECT} ${USER_FROM}
      WHERE ${base} ${page} ORDER BY u.display_name, u.id::text LIMIT ${limit + 1}`);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM users u WHERE ${base}`);
    return { rows: rows.map(toUserDto), total: Number(total[0]?.n ?? 0) };
  }

  /**
   * Name picker: active users only, id, name and employee ID, at most 20 per page (GET /users/picker). Any signed-in user
   * may call it, so it never matches on email: a substring match would let anyone discover addresses letter by letter.
   */
  async picker(like: string, roleId: string | undefined, after: [string, string] | null): Promise<PickerItem[]> {
    const role = roleId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM user_role_assignments a WHERE a.user_id = u.id AND a.role_id = ${roleId}::uuid
          AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))`
      : Prisma.empty;
    const page = after ? Prisma.sql`AND (u.display_name, u.id::text) > (${after[0]}, ${after[1]})` : Prisma.empty;
    const rows = await this.db.tx.$queryRaw<{ id: string; display_name: string; employee_id: string | null }[]>(Prisma.sql`
      SELECT u.id::text AS id, u.display_name, u.employee_id FROM users u
      WHERE u.status = 'active' AND NOT u.is_break_glass
        AND (u.display_name ILIKE ${like} OR u.employee_id ILIKE ${like}) ${role} ${page}
      ORDER BY u.display_name, u.id::text LIMIT 21`);
    return rows.map((r) => ({ id: r.id, display_name: r.display_name, employee_id: r.employee_id?.trim() ?? null }));
  }

  async groupsOf(userId: string): Promise<GroupRef[]> {
    const rows = await this.db.tx.groupMember.findMany({
      where: { user_id: userId, group: { is_active: true } },
      include: { group: true },
      orderBy: { group: { name: 'asc' } },
    });
    return rows.map((m) => ({ id: m.group.id, name: m.group.name, is_system_admins: m.group.is_system_admins }));
  }

  /** Assignments that have not ended (current and scheduled), primary first; `includeEnded` adds the ended ones. */
  async assignmentsOf(userId: string, includeEnded = false): Promise<AssignmentDto[]> {
    const now = new Date();
    const rows = await this.db.tx.userRoleAssignment.findMany({
      where: { user_id: userId, ...(includeEnded ? {} : { OR: [{ valid_to: null }, { valid_to: { gt: now } }] }) },
      include: ASSIGNMENT_INCLUDE,
      orderBy: [{ is_primary: 'desc' }, { assigned_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((a) => toAssignmentDto(a, now));
  }
}
