import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DbService } from '../db/db.service';

export interface UserRef { id: string; display_name: string; employee_id: string | null }
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
  last_login_at: Date | null;
  created_at: Date;
  version: number;
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
}

/**
 * Columns of the contract's User. local_sign_in and must_change_password come from auth_local_lookup (pmis_app cannot read
 * local_credentials). `version` is the microsecond epoch of users.updated_at: an integer that changes with every write to the row.
 */
const USER_SELECT = Prisma.sql`u.id::text AS id, u.email, u.display_name, trim(u.employee_id) AS employee_id, u.phone, u.status::text AS status,
  u.locale, u.theme, u.is_break_glass, u.last_login_at, u.created_at,
  (extract(epoch FROM u.updated_at) * 1000000)::bigint::text AS version,
  (l.user_id IS NOT NULL) AS local_sign_in, coalesce(l.must_change, false) AS must_change`;
const USER_FROM = Prisma.sql`FROM users u LEFT JOIN LATERAL auth_local_lookup(u.email) l ON true`;

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
  last_login_at: r.last_login_at,
  created_at: r.created_at,
  version: Number(r.version),
});

export interface AssignmentDto {
  id: string;
  user: UserRef;
  role: { id: string; code: string; name_en: string; name_ar: string | null; parent_role_id: string | null };
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

export interface UserFilter {
  q?: string;
  status?: string;
  roleId?: string;
  regionId?: number;
  groupId?: string;
}

@Injectable()
export class UsersRepo {
  constructor(private readonly db: DbService) {}

  async find(id: string): Promise<UserDto | null> {
    const rows = await this.db.tx.$queryRaw<UserDbRow[]>(Prisma.sql`SELECT ${USER_SELECT} ${USER_FROM} WHERE u.id = ${id}::uuid`);
    return rows[0] ? toUserDto(rows[0]) : null;
  }

  async list(filter: UserFilter, limit: number, after: [string, string] | null, like: string | null): Promise<{ rows: UserDto[]; total: number }> {
    const where: Prisma.Sql[] = [Prisma.sql`true`];
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

  async groupsOf(userId: string): Promise<GroupRef[]> {
    const rows = await this.db.tx.groupMember.findMany({
      where: { user_id: userId, group: { is_active: true } },
      include: { group: true },
      orderBy: { group: { name: 'asc' } },
    });
    return rows.map((m) => ({ id: m.group.id, name: m.group.name, is_system_admins: m.group.is_system_admins }));
  }

  /** Assignments that have not ended (current and scheduled), primary first. */
  async assignmentsOf(userId: string): Promise<AssignmentDto[]> {
    const now = new Date();
    const rows = await this.db.tx.userRoleAssignment.findMany({
      where: { user_id: userId, OR: [{ valid_to: null }, { valid_to: { gt: now } }] },
      include: {
        role: true,
        regions: true,
        modules: true,
        UserRoleAssignmentProfile: true,
        assigner: { select: { id: true, display_name: true, employee_id: true } },
        user: { select: { id: true, display_name: true, employee_id: true } },
      },
      orderBy: [{ is_primary: 'desc' }, { assigned_at: 'asc' }],
    });
    return rows.map((a) => ({
      id: a.id,
      user: { id: a.user.id, display_name: a.user.display_name, employee_id: a.user.employee_id?.trim() ?? null },
      role: { id: a.role.id, code: a.role.code, name_en: a.role.name_en, name_ar: a.role.name_ar, parent_role_id: a.role.parent_role_id },
      permission_level: a.permission_level,
      team: a.team,
      region_ids: a.all_regions ? 'all' : a.regions.map((r) => r.region_id).sort((x, y) => x - y),
      module_keys: a.all_modules ? 'all' : a.modules.map((m) => m.module_key).sort(),
      profile_ids: a.UserRoleAssignmentProfile.map((p) => p.profile_id),
      is_primary: a.is_primary,
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      is_active_now: a.valid_from <= now,
      assigned_by: a.assigner ? { id: a.assigner.id, display_name: a.assigner.display_name, employee_id: a.assigner.employee_id?.trim() ?? null } : undefined,
      assigned_at: a.assigned_at,
      version: 1,
    }));
  }
}
