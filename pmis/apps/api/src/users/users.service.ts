import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { PasswordService } from '../auth/password.service';
import { generateTemporaryPassword, passwordPolicyErrors } from '../auth/password.policy';
import { SessionService } from '../auth/session.service';
import { SyslogService } from '../auth/syslog.service';
import { UserStateService } from '../auth/user-state.service';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { checkIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { AssignmentDto, GroupRef, PickerItem, UserDto, UsersRepo } from './users.repo';

const reason = z.string().trim().min(3).max(1000);
const employeeId = z.string().regex(/^[0-9]{4}$/);

const createSchema = z.object({
  display_name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  employee_id: employeeId.nullable().optional(),
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/).nullable().optional(),
  temporary_password: z.string().max(1024).optional(),
  reason,
}).strict();

const patchSchema = z.object({
  status: z.enum(['pending_assignment', 'active', 'suspended', 'disabled']).optional(),
  employee_id: employeeId.optional(),
  reason,
}).strict();

const resetSchema = z.object({ reason, temporary_password: z.string().max(1024).optional() }).strict();

export interface UserDetailDto extends UserDto {
  assignments: AssignmentDto[];
  groups: GroupRef[];
  teams: string[];
}

type Query = Record<string, unknown>;

function one(q: Query, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} must be a single value.` }]);
  return v;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly repo: UsersRepo,
    private readonly access: AccessService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly states: UserStateService,
    private readonly stepUp: StepUpService,
    private readonly syslog: SyslogService,
  ) {}

  async list(auth: AuthContext, q: Query): Promise<{ items: UserDto[]; page: { limit: number; next_cursor: string | null; total: number } }> {
    await this.access.requireModuleView(auth, 'admin.users');
    const limit = parseLimit(one(q, 'limit'));
    const cursor = decodeCursor(one(q, 'cursor'), 2);
    const text = one(q, 'q')?.trim();
    const status = one(q, 'status');
    if (status !== undefined && !['pending_assignment', 'active', 'suspended', 'disabled'].includes(status)) {
      throw problems.validation([{ path: '/status', code: 'invalid', message: 'Unknown status.' }]);
    }
    const roleId = one(q, 'role_id');
    const groupId = one(q, 'group_id');
    for (const [k, v] of [['role_id', roleId], ['group_id', groupId]] as const) {
      if (v !== undefined && !uuidSchema.safeParse(v).success) throw problems.validation([{ path: `/${k}`, code: 'invalid', message: 'Not a uuid.' }]);
    }
    const regionRaw = one(q, 'region_id');
    let regionId: number | undefined;
    if (regionRaw !== undefined) {
      regionId = /^[1-7]$/.test(regionRaw) ? Number(regionRaw) : NaN;
      if (Number.isNaN(regionId)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'Region is 1 to 7.' }]);
    }
    const { rows, total } = await this.repo.list(
      { status, roleId, groupId, regionId },
      limit,
      cursor ? [cursor[0] as string, cursor[1] as string] : null,
      text ? likePattern(text) : null,
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, page: { limit, next_cursor: rows.length > limit && last ? encodeCursor([last.display_name, last.id]) : null, total } };
  }

  /** GET /users/picker: any signed-in, non-pending user (the guard ensures that); never the full User shape. */
  async picker(q: Query): Promise<{ items: PickerItem[]; page: { limit: number; next_cursor: string | null } }> {
    const text = one(q, 'q')?.trim() ?? '';
    if (text.length < 2 || text.length > 100) throw problems.validation([{ path: '/q', code: 'invalid', message: 'Type 2 to 100 characters.' }]);
    const roleId = one(q, 'role_id');
    if (roleId !== undefined && !uuidSchema.safeParse(roleId).success) throw problems.validation([{ path: '/role_id', code: 'invalid', message: 'Not a uuid.' }]);
    const cursor = decodeCursor(one(q, 'cursor'), 2);
    const rows = await this.repo.picker(likePattern(text), roleId, cursor ? [cursor[0] as string, cursor[1] as string] : null);
    const items = rows.slice(0, 20);
    const last = items[items.length - 1];
    return { items, page: { limit: 20, next_cursor: rows.length > 20 && last ? encodeCursor([last.display_name, last.id]) : null } };
  }

  async detail(id: string): Promise<UserDetailDto | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const user = await this.repo.find(id);
    if (!user) return null;
    const [assignments, groups] = await Promise.all([this.repo.assignmentsOf(id), this.repo.groupsOf(id)]);
    const now = Date.now();
    const teams = [...new Set(assignments.filter((a) => a.is_active_now && a.team !== 'none' && (!a.valid_to || a.valid_to.getTime() > now)).map((a) => a.team))];
    return { ...user, assignments, groups, teams };
  }

  async get(auth: AuthContext, id: string): Promise<UserDetailDto> {
    if (id !== auth.user.id) await this.access.requireModuleView(auth, 'admin.users');
    const d = await this.detail(id);
    if (!d) throw problems.notFound();
    return d;
  }

  async create(raw: unknown): Promise<{ user: UserDto; temporary_password: string }> {
    const body = parse(createSchema, raw);
    await this.access.requireAdmin('users', 'create');
    const ctx = { email: body.email, employeeId: body.employee_id ?? null, phone: body.phone ?? null };
    const temporary = body.temporary_password ?? generateTemporaryPassword(ctx);
    if (body.temporary_password !== undefined) this.requireStrong(temporary, ctx, '/temporary_password');
    const hash = await this.passwords.hash(temporary);
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT idm_create_local_user(${body.email}::text, ${body.display_name}::text,
      ${body.employee_id ?? null}::text, ${body.phone ?? null}::text, ${hash}::text, ${body.reason}::text)::text AS id`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    const id = rows[0]!.id;
    const user = await this.repo.find(id);
    if (!user) throw new ProblemException(500, 'internal_error', {});
    return { user, temporary_password: temporary };
  }

  async patch(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<UserDetailDto> {
    const body = parse(patchSchema, raw);
    if (body.status === undefined && body.employee_id === undefined) {
      throw problems.validation([{ path: '/', code: 'min_properties', message: 'Send status (or employee_id) with the reason.' }]);
    }
    await this.access.requireAdmin('users', 'edit');
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, ''); // 428 before any other work
    await this.stepUp.require(auth);
    if (body.employee_id !== undefined) {
      // Contract: PATCH may change the employee ID, but no database path exists yet (idm_set_employee_id is for the user's own first link).
      throw problems.validation([{ path: '/employee_id', code: 'not_supported', message: 'Changing the employee ID is not available yet.' }]);
    }
    const current = await this.detail(id);
    if (!current) throw problems.notFound();
    checkIfMatch(ifMatch, current.version);

    await this.db.tx.$executeRaw`SELECT idm_set_user_status(${id}::uuid, ${body.status}::"UserStatus", ${body.reason}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    if (body.status === 'suspended' || body.status === 'disabled') {
      const ended = await this.sessions.revokeAll(id, auth.user.id, 'user_deactivated');
      await this.syslog.write('info', 'session_revoked_by_admin', { target_user: id, sessions: ended, reason: 'user_deactivated' }, auth.user.id);
    }
    this.states.invalidate(id);
    const next = await this.detail(id);
    if (!next) throw new ProblemException(500, 'internal_error', {});
    return next;
  }

  async resetPassword(auth: AuthContext, id: string, raw: unknown): Promise<{ temporary_password: string }> {
    const body = parse(resetSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const target = await this.repo.find(id);
    if (!target) throw problems.notFound();
    const ctx = { email: target.email, employeeId: target.employee_id, phone: target.phone };
    const temporary = body.temporary_password ?? generateTemporaryPassword(ctx);
    if (body.temporary_password !== undefined) this.requireStrong(temporary, ctx, '/temporary_password');
    const hash = await this.passwords.hash(temporary);
    await this.db.tx.$executeRaw`SELECT idm_reset_local_password(${id}::uuid, ${hash}::text, ${body.reason}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(id);
    await this.syslog.write('info', 'password_reset_by_admin', { target_user: id }, auth.user.id);
    return { temporary_password: temporary };
  }

  private requireStrong(password: string, ctx: { email: string; employeeId: string | null; phone: string | null }, path: string): void {
    const errors = passwordPolicyErrors(password, ctx, path);
    if (errors.length > 0) throw new ProblemException(422, 'weak_password', { detail: 'The password does not meet the policy.', errors });
  }
}
