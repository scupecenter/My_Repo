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
import { TwoFactorService } from '../auth/two-factor.service';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { checkIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { MailMessage, MailPort } from '../mail/mail.port';
import { MailService } from '../mail/mail.service';
import { SecurityLogService } from '../logs/security-log.service';
import { FilterCatalogService } from '../views/filter-catalog.service';
import { notifyByMail, PROFILE_MAIL } from '../me/profile.service';
import { AssignmentDto, GroupRef, PickerItem, PurgedUserDto, UserDto, UsersRepo } from './users.repo';

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
  /** 0161: the admin edits the display name. E-mail and phone stay on the verified request flow. */
  display_name: z.string().trim().min(1).max(200).optional(),
  reason,
}).strict();

const deleteSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const restoreSchema = z.object({ reason }).strict();
/** 0089: permanent delete. `confirm_text` is the account's employee ID or e-mail, typed by the admin. */
const purgeSchema = z.object({ reason: z.string().trim().min(3).max(500), confirm_text: z.string().trim().min(1).max(254) }).strict();

const orgSchema = z.object({
  manager_id: z.guid().nullable(),
  department_id: z.guid().nullable(),
  reason,
}).strict();

const twoFactorSchema = z.object({ enabled: z.boolean(), reason }).strict();
const twoFactorResetSchema = z.object({ reason }).strict();
const enforcedSchema = z.object({ enforced: z.boolean(), reason }).strict();

/** 0143: PUT /users/{id}/mfa-exemption (`until` null or missing = until revoked) and the revoke body. */
const mfaSetSchema = z.object({ reason, until: z.string().datetime({ offset: true }).nullable().optional() }).strict();
const mfaRevokeSchema = z.object({ reason }).strict();

const resetSchema = z.object({ reason, temporary_password: z.string().max(1024).optional() }).strict();

/** Answer of the two-factor admin calls. `enrol_code` is present only when a new code was made; it is shown once and never stored in clear. */
export interface TwoFactorChange {
  two_factor: string;
  enrol_code?: string;
  enrol_code_expires_at?: Date;
}
const changeOf = (r: { s: string; e: Date | null }, code: string): TwoFactorChange =>
  r.e ? { two_factor: r.s, enrol_code: code, enrol_code_expires_at: r.e } : { two_factor: r.s };

/** Contract MfaExemption (0143). */
export interface MfaExemptionDto {
  user: { id: string; display_name: string; employee_id: string | null };
  exempt: boolean;
  until: Date | null;
  reason: string | null;
  granted_by?: { id: string; display_name: string; employee_id: string | null };
  granted_at: Date | null;
}

/** The mail to the user (0143). It never carries the reason or a link that signs in. */
const MFA_MAIL = (granted: boolean, until: Date | null): Omit<MailMessage, 'to'> => ({
  category: 'security_notice',
  subject: granted ? 'GSDN Workspace: your account is exempt from the MFA requirement' : 'GSDN Workspace: your MFA exemption was revoked',
  text: (granted
    ? `An administrator exempted your GSDN Workspace account from the GSDN Workspace MFA requirement ${until ? `until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'until it is revoked'}. `
      + 'MFA required by Microsoft 365 is not changed. '
    : 'An administrator revoked the exemption of your GSDN Workspace account from the MFA requirement. Sign-in and step-up follow the normal MFA rule again. ')
    + 'If you did not expect this, tell an administrator.\n\n'
    + (granted ? 'أعفى المسؤول حسابك في نظام GSDN Workspace من شرط التحقق متعدد العوامل الخاص بالنظام. لا يتغير ما يفرضه Microsoft 365.'
      : 'ألغى المسؤول إعفاء حسابك في نظام GSDN Workspace من شرط التحقق متعدد العوامل.'),
});

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
    private readonly twoFactor: TwoFactorService,
    private readonly mail: MailPort,
    private readonly securityLog: SecurityLogService,
    private readonly mailer: MailService,
    private readonly filters: FilterCatalogService,
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
    const adv = await this.filters.fromQuery('users', q); // the + Filter tree of the screen users (the module view grant is checked above)
    const { rows, total } = await this.repo.list(
      { status, roleId, groupId, regionId, adv },
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
    if (body.status === undefined && body.employee_id === undefined && body.display_name === undefined) {
      throw problems.validation([{ path: '/', code: 'min_properties', message: 'Send status, employee_id or display_name with the reason.' }]);
    }
    await this.access.requireAdmin('users', 'edit');
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, ''); // 428 before any other work
    await this.stepUp.require(auth);
    const current = await this.detail(id);
    if (!current) throw problems.notFound();
    checkIfMatch(ifMatch, current.version);

    if (body.employee_id !== undefined || body.display_name !== undefined) {
      // 0161: the name and the employee number, one audited change (the employee number is unique and never your own)
      await this.db.tx.$executeRaw`SAVEPOINT user_identity`;
      try {
        await this.db.tx.$executeRaw`SELECT idm_set_user_identity(${id}::uuid, ${body.display_name ?? null}::text, ${body.employee_id ?? null}::text, ${body.reason}::text)`;
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT user_identity`;
      } catch (e) {
        await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT user_identity`;
        if (/employee_id_in_use/.test(String((e as { message?: string }).message ?? ''))) {
          throw new ProblemException(409, 'duplicate', { detail: 'Another account already has this employee ID.' });
        }
        throw e;
      }
    }
    if (body.status !== undefined) {
      await this.db.tx.$executeRaw`SELECT idm_set_user_status(${id}::uuid, ${body.status}::"UserStatus", ${body.reason}::text)`;
      await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      if (body.status === 'suspended' || body.status === 'disabled') {
        const ended = await this.sessions.revokeAll(id, auth.user.id, 'user_deactivated');
        await this.syslog.write('info', 'session_revoked_by_admin', { target_user: id, sessions: ended, reason: 'user_deactivated' }, auth.user.id);
      }
    }
    this.states.invalidate(id);
    const next = await this.detail(id);
    if (!next) throw new ProblemException(500, 'internal_error', {});
    return next;
  }

  /**
   * GET /users/deleted: soft-deleted users, newest deletion first (permanently deleted ones are tombstones and are not listed).
   * A deleted user keeps its e-mail, employee ID and phone, so they stay unique and a restore normally works; `can_restore` is still
   * computed against every other account (0089) and says why not.
   */
  async listDeleted(auth: AuthContext, q: Query): Promise<{ items: (UserDto & { can_restore: boolean; restore_blocked_reason: string | null })[]; page: { limit: number; next_cursor: null; total: number } }> {
    await this.access.requireModuleView(auth, 'admin.users');
    const text = one(q, 'q')?.trim();
    const { rows, total } = await this.repo.list({ deleted: true }, 200, null, text ? likePattern(text) : null);
    const blockers = await this.repo.restoreBlockers(rows.map((u) => u.id));
    const items = rows
      .sort((a, b) => (b.deleted_at?.getTime() ?? 0) - (a.deleted_at?.getTime() ?? 0))
      .map((u) => ({ ...u, can_restore: !blockers.has(u.id), restore_blocked_reason: blockers.get(u.id) ?? null }));
    return { items, page: { limit: 200, next_cursor: null, total } };
  }

  /** POST /users/{id}/delete (B14): soft delete through idm_delete_user; sessions end and sign-in stops. */
  async softDelete(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<UserDto & { can_restore: boolean; restore_blocked_reason: null }> {
    const body = parse(deleteSchema, raw);
    await this.access.requireAdmin('users', 'delete');
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, '');
    await this.stepUp.require(auth);
    const current = await this.detail(id);
    if (!current) throw problems.notFound();
    checkIfMatch(ifMatch, current.version);
    await this.db.tx.$executeRaw`SELECT idm_delete_user(${id}::uuid, ${body.reason}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    await this.syslog.write('info', 'session_revoked_by_admin', { target_user: id, reason: 'user_deleted' }, auth.user.id);
    this.states.invalidate(id);
    const next = await this.repo.find(id);
    if (!next) throw new ProblemException(500, 'internal_error', {});
    return { ...next, can_restore: true, restore_blocked_reason: null };
  }

  /**
   * POST /users/{id}/purge (0089, owner decision 3 of 2026-11-12): permanent delete of an already soft-deleted user. The row stays as a tombstone
   * (name and history kept); the e-mail, employee ID, phone and Entra link are released so a new account can use them. System Admin only
   * (a delegate gets 403), reason, step-up and the typed confirmation (employee ID or e-mail) are required.
   */
  async purge(auth: AuthContext, id: string, raw: unknown): Promise<PurgedUserDto> {
    const body = parse(purgeSchema, raw);
    await this.access.requireAdmin('users', 'delete');
    if (!(await this.access.isSystemAdmin())) throw problems.forbidden('action_forbidden', 'Permanent delete is for System Admins only.');
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const alreadyPurged = await this.repo.findPurged(id);
    if (alreadyPurged) throw new ProblemException(409, 'invalid_transition', { detail: 'The account was already deleted permanently.' });
    if (!(await this.repo.find(id))) throw problems.notFound();
    await this.db.tx.$executeRaw`SELECT idm_purge_user(${id}::uuid, ${body.reason}::text, ${body.confirm_text}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    await this.syslog.write('info', 'session_revoked_by_admin', { target_user: id, reason: 'user_purged' }, auth.user.id);
    this.states.invalidate(id);
    const next = await this.repo.findPurged(id);
    if (!next) throw new ProblemException(500, 'internal_error', {});
    return next;
  }

  /** POST /users/{id}/restore (B14): back to the status before the delete; local sign-in on again. */
  async restore(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<UserDetailDto> {
    const body = parse(restoreSchema, raw);
    await this.access.requireAdmin('users', 'delete');
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, '');
    await this.stepUp.require(auth);
    const current = await this.detail(id);
    if (!current) throw problems.notFound();
    checkIfMatch(ifMatch, current.version);
    await this.db.tx.$executeRaw`SELECT idm_restore_user(${id}::uuid, ${body.reason}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(id);
    const next = await this.detail(id);
    if (!next) throw new ProblemException(500, 'internal_error', {});
    return next;
  }

  /** PUT /users/{id}/org: direct manager and department together (idm_set_user_org). */
  async setOrg(auth: AuthContext, id: string, raw: unknown): Promise<UserDetailDto> {
    const body = parse(orgSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    await this.stepUp.require(auth);
    if (!uuidSchema.safeParse(id).success || !(await this.repo.find(id))) throw problems.notFound();
    await this.db.tx.$executeRaw`SELECT idm_set_user_org(${id}::uuid, ${body.manager_id}::uuid, ${body.department_id}::uuid, ${body.reason}::text)`;
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

  /**
   * PUT /users/{id}/two-factor: turns two-factor on or off. System Admin, or a delegate with users.two_factor; needs a reason and the
   * actor's step-up; nobody changes their own (idm_set_two_factor). Turning it on ends the user's local sessions and returns a one-time
   * enrolment code (shown once): the user enrols at next sign-in with it, and a password alone can never enrol a phone.
   */
  async setTwoFactor(auth: AuthContext, id: string, raw: unknown): Promise<TwoFactorChange> {
    const body = parse(twoFactorSchema, raw);
    await this.access.requireAdmin('users', 'administer');
    await this.stepUp.require(auth);
    const user = uuidSchema.safeParse(id).success ? await this.repo.find(id) : null;
    if (!user) throw problems.notFound();
    const fresh = this.twoFactor.newEnrolCode(user.id);
    const rows = await this.db.tx.$queryRaw<{ s: string; e: Date | null }[]>`
      SELECT r_state AS s, r_expires AS e FROM idm_set_two_factor(${user.id}::uuid, ${body.enabled}::boolean, ${body.reason}::text, ${fresh.hash}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(user.id);
    await this.syslog.write('info', body.enabled ? 'two_factor_enabled_by_admin' : 'two_factor_disabled_by_admin', { target_user: user.id }, auth.user.id);
    // 0058 (Q161): turning it off ended the user's sessions and wrote a security notice; the user is also told by mail
    if (!body.enabled && user.two_factor !== 'off') await notifyByMail(this.mail, this.syslog, [user.email], PROFILE_MAIL.twoFactorOff(true), auth.user.id);
    return changeOf(rows[0]!, fresh.code);
  }

  /** POST /users/{id}/two-factor/reset: lost phone. Clears the secret and the recovery codes, forces a new enrolment (new code), ends the sessions. */
  async resetTwoFactor(auth: AuthContext, id: string, raw: unknown): Promise<TwoFactorChange> {
    const body = parse(twoFactorResetSchema, raw);
    await this.access.requireAdmin('users', 'administer');
    await this.stepUp.require(auth);
    const user = uuidSchema.safeParse(id).success ? await this.repo.find(id) : null;
    if (!user) throw problems.notFound();
    const fresh = this.twoFactor.newEnrolCode(user.id);
    const rows = await this.db.tx.$queryRaw<{ s: string; e: Date | null }[]>`
      SELECT r_state AS s, r_expires AS e FROM idm_reset_two_factor(${user.id}::uuid, ${body.reason}::text, ${fresh.hash}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(user.id);
    await this.syslog.write('info', 'two_factor_reset_by_admin', { target_user: user.id }, auth.user.id);
    return changeOf(rows[0]!, fresh.code);
  }

  /**
   * POST /users/{id}/two-factor/enrol-code: a new enrolment code for a user who is waiting for enrolment (lost or expired code). The old code
   * stops working. Same rights, reason, step-up and self rule as the toggle. 409 when the user is not waiting for enrolment.
   */
  async issueEnrolCode(auth: AuthContext, id: string, raw: unknown): Promise<TwoFactorChange> {
    const body = parse(twoFactorResetSchema, raw);
    await this.access.requireAdmin('users', 'administer');
    await this.stepUp.require(auth);
    const user = uuidSchema.safeParse(id).success ? await this.repo.find(id) : null;
    if (!user) throw problems.notFound();
    const fresh = this.twoFactor.newEnrolCode(user.id);
    const rows = await this.db.tx.$queryRaw<{ e: Date }[]>`SELECT idm_issue_two_factor_enrol_code(${user.id}::uuid, ${body.reason}::text, ${fresh.hash}::text) AS e`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(user.id);
    await this.syslog.write('info', 'two_factor_enrol_code_issued_by_admin', { target_user: user.id }, auth.user.id);
    return changeOf({ s: 'pending_enrolment', e: rows[0]!.e }, fresh.code);
  }

  /**
   * PUT /users/{id}/two-factor/enforced (0.9.2): marks or unmarks "enforced by admin". While enforced the user cannot turn two-factor off
   * themselves (403 two_factor_enforced). Same rights, reason, step-up and self rule as the toggle (idm_set_two_factor_enforced).
   */
  async setTwoFactorEnforced(auth: AuthContext, id: string, raw: unknown): Promise<{ two_factor: string; enforced: boolean }> {
    const body = parse(enforcedSchema, raw);
    await this.access.requireAdmin('users', 'administer');
    await this.stepUp.require(auth);
    const user = uuidSchema.safeParse(id).success ? await this.repo.find(id) : null;
    if (!user) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<{ e: boolean }[]>`SELECT idm_set_two_factor_enforced(${user.id}::uuid, ${body.enforced}::boolean, ${body.reason}::text) AS e`;
    this.states.invalidate(user.id);
    await this.syslog.write('info', body.enforced ? 'two_factor_enforced_by_admin' : 'two_factor_unenforced_by_admin', { target_user: user.id }, auth.user.id);
    return { two_factor: user.two_factor, enforced: rows[0]?.e === true };
  }

  /** GET /users/{id}/mfa-exemption (0143): the exemption in force, for a holder of admin.users view (or the user themselves). */
  async getMfaExemption(auth: AuthContext, id: string): Promise<MfaExemptionDto> {
    if (id !== auth.user.id) await this.access.requireModuleView(auth, 'admin.users');
    const user = uuidSchema.safeParse(id).success ? await this.repo.find(id) : null;
    if (!user || user.is_break_glass) throw problems.notFound();
    return this.mfaState(user);
  }

  /**
   * PUT /users/{id}/mfa-exemption and POST /users/{id}/mfa-exemption/revoke (0143, idm_set_mfa_exempt). System Admin, or a delegate holding
   * users.administer for all regions; a reason and the acting admin's own step-up; nobody exempts themselves; admins and delegates are exempted
   * by a System Admin only. Removes only GSDN Workspace's own MFA check (auth_mfa_required), never Entra Conditional Access. The user is told in the
   * inbox (database) and by mail (outbox).
   */
  async setMfaExemption(auth: AuthContext, id: string, raw: unknown, revoke: boolean): Promise<MfaExemptionDto> {
    const body = revoke ? { ...parse(mfaRevokeSchema, raw), until: null } : parse(mfaSetSchema, raw);
    await this.access.requireAdmin('users', 'administer');
    const user = uuidSchema.safeParse(id).success ? await this.repo.find(id) : null;
    if (!user || user.is_break_glass) throw problems.notFound();
    if (user.id === auth.user.id) throw new ProblemException(403, 'self_beneficiary', { detail: 'Nobody can exempt themselves from MFA; another admin does it.' });
    await this.stepUp.require(auth);
    const until = body.until ? new Date(body.until) : null;
    if (!revoke && until && until.getTime() <= Date.now()) {
      throw problems.validation([{ path: '/until', code: 'must_be_future', message: 'The end date must be in the future (or empty: until revoked).' }]);
    }
    const rows = await this.db.tx.$queryRaw<{ act: string; nid: string | null }[]>`
      SELECT r_action AS act, r_notification::text AS nid FROM idm_set_mfa_exempt(${user.id}::uuid, ${!revoke}::boolean, ${until}::timestamptz, ${body.reason}::text)`;
    this.states.invalidate(user.id);
    const granted = !revoke;
    await this.securityLog.write({ event: granted ? 'mfa_exemption_granted' : 'mfa_exemption_revoked', outcome: 'info', userId: user.id,
      detail: { by: auth.user.id, until: until?.toISOString() ?? null, action: rows[0]?.act ?? null },
      ctx: { ip: auth.ip, userAgent: null, requestId: null, sessionId: auth.session.id, authMethod: auth.session.authMethod === 'm365' ? 'oidc' : auth.session.authMethod } }, { inTx: true });
    await this.mailMfa(user.email, granted, until, rows[0]?.nid ?? null, auth.user.id);
    const next = await this.repo.find(user.id);
    if (!next) throw new ProblemException(500, 'internal_error', {});
    return this.mfaState(next);
  }

  /**
   * The mail to the user, always sent, never failing the request. Its dedup key is the one mail_on_notification gives the in-app notice
   * (notification:<id>), so a System Admin who lists the kind mfa_exemption in mail.notification_kinds never causes a second mail.
   */
  private async mailMfa(email: string, granted: boolean, until: Date | null, notificationId: string | null, actor: string): Promise<void> {
    const m = MFA_MAIL(granted, until);
    await this.db.tx.$executeRaw`SAVEPOINT pmis_mfa_mail`;
    try {
      await this.mailer.sendToAddress(email, { kind: `identity.${m.category}`, subject: m.subject, text: m.text, dedupKey: notificationId ? `notification:${notificationId}` : undefined });
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT pmis_mfa_mail`;
    } catch (e) {
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT pmis_mfa_mail`;
      await this.syslog.write('warn', 'mail_send_failed', { category: m.category, error: e instanceof Error ? e.message.split('\n')[0] : 'unknown' }, actor);
    }
  }

  private async mfaState(user: UserDto): Promise<MfaExemptionDto> {
    const rows = await this.db.tx.$queryRaw<{ exempt: boolean; until: Date | null; reason: string | null; granted_at: Date | null; by_id: string | null; by_name: string | null; by_emp: string | null }[]>`
      SELECT s.exempt, s.until, s.reason, s.granted_at, g.id::text AS by_id, g.display_name AS by_name, trim(g.employee_id) AS by_emp
      FROM idm_mfa_exemption_state(${user.id}::uuid) s LEFT JOIN users g ON g.id = s.granted_by`;
    const r = rows[0];
    const ref = { id: user.id, display_name: user.display_name, employee_id: user.employee_id };
    if (!r?.exempt) return { user: ref, exempt: false, until: null, reason: null, granted_at: null };
    return {
      user: ref, exempt: true, until: r.until, reason: r.reason, granted_at: r.granted_at,
      ...(r.by_id ? { granted_by: { id: r.by_id, display_name: r.by_name ?? '', employee_id: r.by_emp } } : {}),
    };
  }

  private requireStrong(password: string, ctx: { email: string; employeeId: string | null; phone: string | null }, path: string): void {
    const errors = passwordPolicyErrors(password, ctx, path);
    if (errors.length > 0) throw new ProblemException(422, 'weak_password', { detail: 'The password does not meet the policy.', errors });
  }
}
