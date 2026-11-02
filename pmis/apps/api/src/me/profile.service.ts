import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuthService, SessionBody } from '../auth/auth.service';
import type { AuthContext } from '../auth/auth.types';
import { RateLimiter } from '../auth/rate-limiter';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { TWO_FACTOR_PARAMS, TwoFactorService, labelOf } from '../auth/two-factor.service';
import { UserStateService } from '../auth/user-state.service';
import { checkIfMatch } from '../common/etag';
import { FieldError, ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { DepartmentRef, UserRef, UsersRepo } from '../users/users.repo';

/** Fields a user changes on their own account (owner decision 2026-11-02). Everything else on the account is admin-owned. */
export const SELF_EDITABLE = ['display_name', 'phone', 'locale', 'theme'] as const;
/**
 * Admin-owned fields a client might try to send: refused with 403 field_read_only (email has its own approval flow). Any other unknown
 * key is a plain 422.
 */
export const ADMIN_OWNED = [
  'email', 'employee_id', 'status', 'team', 'teams', 'region', 'region_id', 'region_ids', 'regions', 'role', 'roles', 'role_ids', 'assignments',
  'department', 'department_id', 'manager', 'manager_id', 'position', 'title', 'groups', 'is_system_admin', 'local_sign_in', 'two_factor',
] as const;

const profilePatchSchema = z.object({
  display_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Use the E.164 form, for example +218912345678.').nullable().optional(),
  locale: z.enum(['en', 'ar']).optional(),
  theme: z.enum(['light', 'dark']).optional(),
}).strict();

const emailRequestSchema = z.object({
  new_email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
}).strict();

const codeFields = { code: z.string().trim().max(16).optional(), recovery_code: z.string().trim().max(32).optional() };
const disableSchema = z.object({ password: z.string().min(1).max(128), ...codeFields }).strict()
  .refine((b) => (b.code === undefined) !== (b.recovery_code === undefined), { message: 'Send code or recovery_code, not both.', path: ['code'] });
const confirmSchema = z.object({ code: z.string().trim().min(1).max(16) }).strict();

export const EMAIL_CHANGE_LIMIT = 5;
export const SELF_TWO_FACTOR_LIMIT = 10;

export interface EmailChangeDto {
  id: string;
  old_email: string;
  new_email: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_at: Date;
  decided_at: Date | null;
  decision_reason: string | null;
}

export interface TwoFactorSelfDto {
  state: 'off' | 'pending_enrolment' | 'on';
  enforced: boolean;
  recovery_codes_remaining: number;
  /** A local session may turn it on itself (off now, local account). */
  can_enable: boolean;
  /** A local session may turn it off itself (on, not enforced). */
  can_disable: boolean;
}

export interface ProfileDto {
  id: string;
  display_name: string;
  email: string;
  employee_id: string | null;
  phone: string | null;
  locale: string;
  theme: string;
  status: string;
  auth_method: string;
  local_sign_in: boolean;
  editable_fields: string[];
  admin_owned: {
    roles: { id: string; code: string; name_en: string; name_ar: string | null }[];
    teams: string[];
    region_ids: 'all' | number[];
    department: DepartmentRef | null;
    manager: UserRef | null;
  };
  two_factor: TwoFactorSelfDto;
  /** The newest email change request (any status), so the page can show a pending one or the last decision. */
  email_change: EmailChangeDto | null;
  version: number;
}

/**
 * The self-service "My profile" page (contract 0.9.2, migration 0044). Every write goes through an idm_* / auth_totp_self_* function
 * (SECURITY DEFINER, owner pmis_identity_owner) that re-checks who acts; the API checks first so the answers are precise.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly db: DbService,
    private readonly repo: UsersRepo,
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly stepUp: StepUpService,
    private readonly limiter: RateLimiter,
    private readonly syslog: SyslogService,
    private readonly states: UserStateService,
  ) {}

  async get(auth: AuthContext): Promise<ProfileDto> {
    const user = await this.repo.find(auth.user.id);
    if (!user) throw problems.unauthenticated();
    const assignments = (await this.repo.assignmentsOf(auth.user.id)).filter((a) => a.is_active_now);
    const roles = [...new Map(assignments.map((a) => [a.role.id, a.role])).values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const teams = [...new Set(assignments.map((a) => a.team).filter((t) => t !== 'none'))].sort();
    let regionIds: 'all' | number[] = [];
    if (assignments.some((a) => a.region_ids === 'all')) regionIds = 'all';
    else regionIds = [...new Set(assignments.flatMap((a) => a.region_ids as number[]))].sort((a, b) => a - b);
    const tf = await this.twoFactor.state(auth.user.id);
    const enforced = tf.required ? await this.twoFactor.enforced(auth.user.id) : false;
    const local = auth.session.authMethod === 'local' && user.local_sign_in;
    const changes = await this.emailChanges();
    return {
      id: user.id,
      display_name: user.display_name,
      email: user.email,
      employee_id: user.employee_id,
      phone: user.phone,
      locale: user.locale,
      theme: user.theme,
      status: user.status,
      auth_method: auth.session.authMethod,
      local_sign_in: user.local_sign_in,
      editable_fields: [...SELF_EDITABLE],
      admin_owned: { roles, teams, region_ids: regionIds, department: user.department, manager: user.manager },
      two_factor: {
        state: labelOf(tf),
        enforced,
        recovery_codes_remaining: tf.required && tf.enrolled ? tf.recovery_remaining : 0,
        can_enable: local && !tf.required,
        can_disable: local && tf.required && tf.enrolled && !enforced,
      },
      email_change: changes[0] ?? null,
      version: user.version,
    };
  }

  /** PATCH /me/profile: only the self-editable fields; If-Match on the profile version; audited with before and after in the database. */
  async patch(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<ProfileDto> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw problems.validation([{ path: '/', code: 'type', message: 'Send an object.' }]);
    const keys = Object.keys(raw as Record<string, unknown>);
    const adminOwned = keys.filter((k) => (ADMIN_OWNED as readonly string[]).includes(k)).sort();
    if (adminOwned.length > 0) {
      const errors: FieldError[] = adminOwned.map((k) => ({
        path: `/${k}`, code: 'read_only',
        message: k === 'email' ? 'Ask for an email change instead (POST /me/email-change); an administrator approves it.' : 'An administrator manages this field.',
      }));
      throw new ProblemException(403, 'field_read_only', { detail: 'These fields are managed by an administrator.', errors });
    }
    const body = parse(profilePatchSchema, raw);
    if (Object.keys(body).length === 0) throw problems.validation([{ path: '/', code: 'min_properties', message: `Send at least one of ${SELF_EDITABLE.join(', ')}.` }]);
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, '');
    const current = await this.repo.find(auth.user.id);
    if (!current) throw problems.unauthenticated();
    checkIfMatch(ifMatch, current.version);
    await this.db.tx.$queryRaw`SELECT idm_update_own_profile(${JSON.stringify(body)}::jsonb) AS n`;
    return this.get(auth);
  }

  /** POST /me/password: the local password change (same rules as POST /auth/local/password), for a full session. */
  async changePassword(auth: AuthContext, raw: unknown): Promise<SessionBody> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365. Change your password there.');
    return this.auth.changePassword(auth, raw);
  }

  // ------------------------------------------------------------------ email change
  private async emailChanges(): Promise<EmailChangeDto[]> {
    return this.db.tx.$queryRaw<EmailChangeDto[]>`SELECT id::text AS id, old_email, new_email, status, requested_at, decided_at, decision_reason FROM idm_my_email_changes()`;
  }

  /** POST /me/email-change: a request with the password re-entered (counted toward the lock like sign-in). An admin decides it. */
  async requestEmailChange(auth: AuthContext, raw: unknown): Promise<EmailChangeDto> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365. Ask an administrator to change your email.');
    const body = parse(emailRequestSchema, raw);
    const wait = this.limiter.hit(`emailchange:${auth.user.id}`, EMAIL_CHANGE_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    await this.auth.checkOwnPassword(auth, body.password, 'email_change');
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT idm_request_email_change(${body.new_email}::text)::text AS id`;
    await this.syslog.write('info', 'email_change_requested', { request_id: rows[0]?.id }, auth.user.id, undefined);
    const mine = await this.emailChanges();
    const r = mine.find((x) => x.id === rows[0]?.id);
    if (!r) throw new ProblemException(500, 'internal_error', {});
    return r;
  }

  /** DELETE /me/email-change: withdraws the pending request. 404 when nothing is pending. */
  async cancelEmailChange(): Promise<void> {
    const pending = (await this.emailChanges()).find((x) => x.status === 'pending');
    if (!pending) throw problems.notFound('No email change is waiting for a decision.');
    await this.db.tx.$executeRaw`SELECT idm_cancel_email_change(${pending.id}::uuid)`;
  }

  // ------------------------------------------------------------------ two-factor self-service
  private async selfState(auth: AuthContext): Promise<TwoFactorSelfDto> {
    return (await this.get(auth)).two_factor;
  }

  /** POST /me/two-factor/enrol/start: off now, local session, fresh step-up. No admin enrolment code: the live session is the proof. */
  async enrolStart(auth: AuthContext): Promise<Record<string, unknown>> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365, where two-factor is managed.');
    const tf = await this.twoFactor.state(auth.user.id);
    if (tf.required) throw new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is already on for your account.' });
    await this.stepUp.require(auth);
    const wait = this.limiter.hit(`2fa:self:${auth.user.id}`, SELF_TWO_FACTOR_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    const e = await this.twoFactor.selfBeginEnrol(auth.user.id, auth.session.id, auth.user.email);
    if (!e.ok) throw this.twoFactor.problem('locked', false);
    return { secret: e.secret, otpauth_uri: e.otpauth_uri, issuer: TWO_FACTOR_PARAMS.issuer, account: auth.user.email, algorithm: TWO_FACTOR_PARAMS.algorithm, digits: TWO_FACTOR_PARAMS.digits, period: TWO_FACTOR_PARAMS.period };
  }

  /** POST /me/two-factor/enrol/confirm: the first code. Two-factor goes on (not enforced), recovery codes once, other sessions end. */
  async enrolConfirm(auth: AuthContext, raw: unknown): Promise<{ recovery_codes: string[]; two_factor: TwoFactorSelfDto; other_sessions_ended: number }> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365, where two-factor is managed.');
    const { code } = parse(confirmSchema, raw);
    const wait = this.limiter.hit(`2fa:self:${auth.user.id}`, SELF_TWO_FACTOR_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    const r = await this.twoFactor.selfCheckPending(auth.user.id, auth.session.id, code.replace(/\s/g, ''));
    if (!r.ok) {
      if (r.reason === 'none') throw new ProblemException(409, 'invalid_transition', { detail: 'Start the set-up again: no QR code is waiting for this session.' });
      await this.twoFactor.logFailure(auth.user.id, r.reason, 'totp', auth.ip, 'self_enrol');
      throw this.twoFactor.problem(r.reason, true);
    }
    const done = await this.twoFactor.selfConfirmEnrol(auth.user.id, auth.session.id, r.step);
    this.states.invalidate(auth.user.id);
    await this.syslog.write('info', 'local_two_factor_self_enabled', { other_sessions_ended: done.sessionsEnded }, auth.user.id, undefined);
    return { recovery_codes: done.codes, two_factor: await this.selfState(auth), other_sessions_ended: done.sessionsEnded };
  }

  /**
   * POST /me/two-factor/disable: the password and a TOTP code (or one recovery code). 403 two_factor_enforced when an admin enforces it,
   * before anything is counted. A wrong password or code counts toward the lock and is committed.
   */
  async disable(auth: AuthContext, raw: unknown): Promise<TwoFactorSelfDto> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365, where two-factor is managed.');
    const body = parse(disableSchema, raw);
    const tf = await this.twoFactor.state(auth.user.id);
    if (!tf.required || !tf.enrolled) throw new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is not on for your account.' });
    if (await this.twoFactor.enforced(auth.user.id)) {
      throw new ProblemException(403, 'two_factor_enforced', { detail: 'An administrator enforces two-factor on your account, so you cannot turn it off. Ask an administrator.' });
    }
    const wait = this.limiter.hit(`2fa:self:${auth.user.id}`, SELF_TWO_FACTOR_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    await this.auth.checkOwnPassword(auth, body.password, 'two_factor_disable');
    const input = body.recovery_code !== undefined ? { recovery_code: body.recovery_code } : { code: (body.code ?? '').replace(/\s/g, '') };
    const r = await this.twoFactor.check(auth.user.id, input);
    if (!r.ok) {
      await this.twoFactor.logFailure(auth.user.id, r.reason, r.via, auth.ip, 'self_disable');
      throw this.twoFactor.problem(r.reason, true);
    }
    await this.twoFactor.selfDisable(auth.user.id, auth.session.id);
    this.states.invalidate(auth.user.id);
    await this.syslog.write('info', 'local_two_factor_self_disabled', { via: r.via }, auth.user.id, undefined);
    return this.selfState(auth);
  }

  private needLocal(auth: AuthContext, detail: string): void {
    if (auth.session.authMethod !== 'local') throw new ProblemException(403, 'action_forbidden', { detail });
  }
}

// ------------------------------------------------------------------ admin side of the email change
export interface EmailChangeAdminDto extends EmailChangeDto {
  user: UserRef;
  decided_by: UserRef | null;
}

interface AdminRow {
  id: string; user_id: string; display_name: string; employee_id: string | null; old_email: string; new_email: string; status: EmailChangeDto['status'];
  requested_at: Date; decided_at: Date | null; decided_by: string | null; decided_by_name: string | null; decision_reason: string | null;
}

const decideSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(1000) }).strict();
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'all'] as const;

/** GET /email-change-requests and POST /email-change-requests/{id}/decide (System Admin, or a delegate holding users.edit for all regions). */
@Injectable()
export class EmailChangesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly states: UserStateService,
    private readonly syslog: SyslogService,
  ) {}

  private async rows(status: string | null): Promise<EmailChangeAdminDto[]> {
    const rows = await this.db.tx.$queryRaw<AdminRow[]>(Prisma.sql`SELECT id::text AS id, user_id::text AS user_id, display_name, employee_id, old_email, new_email,
      status, requested_at, decided_at, decided_by::text AS decided_by, decided_by_name, decision_reason FROM idm_email_change_list(${status}::text)`);
    return rows.map((r) => ({
      id: r.id, old_email: r.old_email, new_email: r.new_email, status: r.status, requested_at: r.requested_at, decided_at: r.decided_at,
      decision_reason: r.decision_reason,
      user: { id: r.user_id, display_name: r.display_name, employee_id: r.employee_id?.trim() || null },
      decided_by: r.decided_by ? { id: r.decided_by, display_name: r.decided_by_name ?? '', employee_id: null } : null,
    }));
  }

  async list(q: Record<string, unknown>): Promise<{ items: EmailChangeAdminDto[]; page: { limit: number; next_cursor: null; total: number } }> {
    await this.access.requireAdmin('users', 'edit');
    const raw = q.status ?? 'pending';
    if (typeof raw !== 'string' || !(STATUSES as readonly string[]).includes(raw)) {
      throw problems.validation([{ path: '/status', code: 'invalid', message: `One of ${STATUSES.join(', ')}.` }]);
    }
    const items = (await this.rows(raw === 'all' ? null : raw)).slice(0, 200);
    return { items, page: { limit: 200, next_cursor: null, total: items.length } };
  }

  async decide(auth: AuthContext, id: string, raw: unknown): Promise<EmailChangeAdminDto> {
    const body = parse(decideSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    if (!z.string().uuid().safeParse(id).success) throw problems.notFound();
    // the database decides who may (idm_actor users.edit, global, not one's own, a delegate never for an admin); step-up first
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw`SELECT idm_decide_email_change(${id}::uuid, ${body.decision === 'approve'}::boolean, ${body.reason}::text) AS s`;
    const r = (await this.rows(null)).find((x) => x.id === id);
    if (!r) throw new ProblemException(500, 'internal_error', {});
    this.states.invalidate(r.user.id);
    await this.syslog.write('info', body.decision === 'approve' ? 'email_change_approved' : 'email_change_rejected', { target_user: r.user.id, request_id: id }, auth.user.id);
    return r;
  }
}
