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
import { MailMessage, MailPort } from '../mail/mail.port';
import { sendQuietly } from '../mail/noop-mail';
import { DepartmentRef, UserRef, UsersRepo } from '../users/users.repo';

/**
 * Fields a user changes on their own account (owner decision 2026-11-02). Everything else on the account is admin-owned. The phone left this
 * list in 0058 (D156): it is a sign-in identifier and changes through a request an admin approves (POST /me/phone-change).
 */
export const SELF_EDITABLE = ['display_name', 'locale', 'theme'] as const;
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
  locale: z.enum(['en', 'ar']).optional(),
  theme: z.enum(['light', 'dark']).optional(),
}).strict();

const emailRequestSchema = z.object({
  new_email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
}).strict();

const phoneRequestSchema = z.object({
  new_phone: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, 'Use the E.164 form, for example +218912345678.').nullable(),
  password: z.string().min(1).max(128),
}).strict();
const verifySchema = z.object({ code: z.string().trim().min(1).max(16) }).strict();

const codeFields = { code: z.string().trim().max(16).optional(), recovery_code: z.string().trim().max(32).optional() };
const disableSchema = z.object({ password: z.string().min(1).max(128), ...codeFields }).strict()
  .refine((b) => (b.code === undefined) !== (b.recovery_code === undefined), { message: 'Send code or recovery_code, not both.', path: ['code'] });
const confirmSchema = z.object({ code: z.string().trim().min(1).max(16) }).strict();

export const EMAIL_CHANGE_LIMIT = 5;
export const PHONE_CHANGE_LIMIT = 5;
/** Codes sent again for one user (per rate window). */
export const EMAIL_VERIFY_RESEND_LIMIT = 3;
export const EMAIL_VERIFY_LIMIT = 10;
export const SELF_TWO_FACTOR_LIMIT = 10;

export interface EmailChangeDto {
  id: string;
  old_email: string;
  new_email: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_at: Date;
  decided_at: Date | null;
  decision_reason: string | null;
  /** 0058 (Q158): when and how the new address was checked: a mailed code the user entered, or the admin's documented identity check. */
  verified_at: Date | null;
  verified_via: 'code' | 'admin_check' | null;
  verify_sent_at: Date | null;
  verify_expires_at: Date | null;
}

export interface PhoneChangeDto {
  id: string;
  old_phone: string | null;
  new_phone: string | null;
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
  /** 0058 (D156): the newest phone change request (any status). */
  phone_change: PhoneChangeDto | null;
  version: number;
}

const EMAIL_COLS = Prisma.sql`id::text AS id, old_email, new_email, status, requested_at, decided_at, decision_reason, verified_at, verified_via, verify_sent_at, verify_expires_at`;

/** The text of the mails sent by the profile flows. They never carry a reason, a password or a link that signs in. */
export const PROFILE_MAIL = {
  verify: (code: string, until: string): Omit<MailMessage, 'to'> => ({
    category: 'email_change_verification',
    subject: 'GSDN Workspace: confirm your new email address',
    text: `You asked to use this address for your GSDN Workspace account. Open My profile in GSDN Workspace and enter this code: ${code}\n`
      + `It works once and expires at ${until}. If you did not ask for this, ignore this message.\n\n`
      + `طلبت استخدام هذا البريد لحسابك في نظام GSDN Workspace. افتح "ملفي الشخصي" وأدخل الرمز: ${code}\nإن لم تطلب ذلك فتجاهل هذه الرسالة.`,
  }),
  emailRequestedOld: (): Omit<MailMessage, 'to'> => ({
    category: 'security_notice',
    subject: 'GSDN Workspace: a change of your sign-in email was requested',
    text: 'Someone signed in to your GSDN Workspace account asked to change its sign-in email. An administrator must approve it. '
      + 'If this was not you, change your password and tell an administrator.\n\n'
      + 'طُلب تغيير بريد الدخول لحسابك في نظام GSDN Workspace، ويجب أن يوافق عليه مسؤول. إن لم تكن أنت فغيّر كلمة المرور وأبلغ المسؤول.',
  }),
  emailDecided: (approved: boolean): Omit<MailMessage, 'to'> => ({
    category: 'email_change_decided',
    subject: approved ? 'GSDN Workspace: your sign-in email was changed' : 'GSDN Workspace: your email change was rejected',
    text: (approved
      ? 'The sign-in email of your GSDN Workspace account was changed after an administrator approved the request. Your sessions were signed out: sign in again with the new address. '
      : 'An administrator rejected the request to change the sign-in email of your GSDN Workspace account; it stays as it was. ')
      + 'See My profile for the details. If you did not ask for this, tell an administrator.\n\n'
      + (approved ? 'تم تغيير بريد الدخول لحسابك بعد موافقة المسؤول وتم إنهاء جلساتك، فسجّل الدخول من جديد بالعنوان الجديد.' : 'رفض المسؤول طلب تغيير بريد الدخول، ويبقى كما هو.'),
  }),
  phone: (what: 'requested' | 'approved' | 'rejected'): Omit<MailMessage, 'to'> => ({
    category: 'phone_change',
    subject: what === 'requested' ? 'GSDN Workspace: a change of your sign-in phone was requested'
      : what === 'approved' ? 'GSDN Workspace: your sign-in phone was changed' : 'GSDN Workspace: your phone change was rejected',
    text: (what === 'requested' ? 'A change of the sign-in phone of your GSDN Workspace account was requested and waits for an administrator. '
      : what === 'approved' ? 'The sign-in phone of your GSDN Workspace account was changed after an administrator approved the request. '
        : 'An administrator rejected the request to change the sign-in phone of your GSDN Workspace account; it stays as it was. ')
      + 'See My profile for the details. If you did not ask for this, change your password and tell an administrator.\n\n'
      + 'تغيّرت حالة طلب تغيير هاتف الدخول لحسابك في نظام GSDN Workspace. راجع "ملفي الشخصي". إن لم تطلب ذلك فأبلغ المسؤول.',
  }),
  twoFactorOff: (byAdmin: boolean): Omit<MailMessage, 'to'> => ({
    category: 'security_notice',
    subject: 'GSDN Workspace: two-factor sign-in was turned off',
    text: (byAdmin ? 'An administrator turned two-factor sign-in off for your GSDN Workspace account. Your sessions were signed out. '
      : 'Two-factor sign-in was turned off on your GSDN Workspace account from My profile. Your other sessions were signed out. ')
      + 'Your recovery codes no longer work. If you did not expect this, change your password and tell an administrator.\n\n'
      + 'تم إيقاف التحقق بخطوتين لحسابك في نظام GSDN Workspace وإنهاء الجلسات الأخرى. إن لم تتوقع ذلك فغيّر كلمة المرور وأبلغ المسؤول.',
  }),
};

/** Mail through MailPort without failing the request; a failure is written to the System Log. */
export async function notifyByMail(mail: MailPort, syslog: SyslogService, to: (string | null | undefined)[], m: Omit<MailMessage, 'to'>,
  userId?: string): Promise<boolean> {
  return sendQuietly(mail, { ...m, to: to.filter((x): x is string => typeof x === 'string') }, (e) =>
    syslog.write('warn', 'mail_send_failed', { category: m.category, error: e instanceof Error ? e.message.split('\n')[0] : 'unknown' }, userId));
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
    private readonly mail: MailPort,
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
    const phones = await this.phoneChanges();
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
      phone_change: phones[0] ?? null,
      version: user.version,
    };
  }

  /** PATCH /me/profile: only the self-editable fields; If-Match on the profile version; audited with before and after in the database. */
  async patch(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<ProfileDto> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw problems.validation([{ path: '/', code: 'type', message: 'Send an object.' }]);
    const keys = Object.keys(raw as Record<string, unknown>);
    const adminOwned = keys.filter((k) => (ADMIN_OWNED as readonly string[]).includes(k) || k === 'phone').sort();
    if (adminOwned.length > 0) {
      const errors: FieldError[] = adminOwned.map((k) => ({
        path: `/${k}`, code: 'read_only',
        message: k === 'email' ? 'Ask for an email change instead (POST /me/email-change); an administrator approves it.'
          : k === 'phone' ? 'Ask for a phone change instead (POST /me/phone-change); an administrator approves it.' : 'An administrator manages this field.',
      }));
      throw new ProblemException(403, 'field_read_only', { detail: 'These fields are managed by an administrator or change only through a request.', errors });
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
    return this.db.tx.$queryRaw<EmailChangeDto[]>(Prisma.sql`SELECT ${EMAIL_COLS} FROM idm_my_email_changes()`);
  }

  /**
   * POST /me/email-change: a request with the password re-entered (counted toward the lock like sign-in). An admin decides it.
   * 0058 (Q158): a one-time code is mailed to the new address (the user enters it on the profile), and the old address is told.
   */
  async requestEmailChange(auth: AuthContext, raw: unknown): Promise<EmailChangeDto> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365. Ask an administrator to change your email.');
    const body = parse(emailRequestSchema, raw);
    const wait = this.limiter.hit(`emailchange:${auth.user.id}`, EMAIL_CHANGE_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    await this.auth.checkOwnPassword(auth, body.password, 'email_change');
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT idm_request_email_change(${body.new_email}::text)::text AS id`;
    const id = rows[0]?.id;
    if (!id) throw new ProblemException(500, 'internal_error', {});
    await this.syslog.write('info', 'email_change_requested', { request_id: id }, auth.user.id, undefined);
    await this.sendVerification(auth, id, body.new_email);
    await notifyByMail(this.mail, this.syslog, [auth.user.email], PROFILE_MAIL.emailRequestedOld(), auth.user.id);
    return this.myEmailChange(id);
  }

  /** POST /me/email-change/resend: a new code for the pending, unverified request (the old one stops working). */
  async resendEmailVerification(auth: AuthContext): Promise<EmailChangeDto> {
    const pending = (await this.emailChanges()).find((x) => x.status === 'pending');
    if (!pending) throw problems.notFound('No email change is waiting for a decision.');
    if (pending.verified_at) throw new ProblemException(409, 'invalid_transition', { detail: 'The new address is already confirmed.' });
    const wait = this.limiter.hit(`emailverify:send:${auth.user.id}`, EMAIL_VERIFY_RESEND_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    await this.sendVerification(auth, pending.id, pending.new_email);
    return this.myEmailChange(pending.id);
  }

  /**
   * POST /me/email-change/verify: the code that reached the new address. A wrong code is counted (five end it: send a new one) and the
   * count is committed with the error.
   */
  async verifyEmailChange(auth: AuthContext, raw: unknown): Promise<EmailChangeDto> {
    const { code } = parse(verifySchema, raw);
    const wait = this.limiter.hit(`emailverify:${auth.user.id}`, EMAIL_VERIFY_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    const pending = (await this.emailChanges()).find((x) => x.status === 'pending');
    if (!pending) throw problems.notFound('No email change is waiting for a decision.');
    const hash = this.twoFactor.emailVerifyHash(pending.id, code);
    const r = (await this.db.tx.$queryRaw<{ r: string }[]>`SELECT idm_email_change_verify(${hash}::text) AS r`)[0]?.r ?? 'bad';
    if (r === 'ok' || r === 'verified') {
      if (r === 'ok') await this.syslog.write('info', 'email_change_verified', { request_id: pending.id }, auth.user.id, undefined);
      return this.myEmailChange(pending.id);
    }
    if (r === 'none') throw new ProblemException(409, 'invalid_transition', { detail: 'No code was sent for this request: send a new one.' });
    const msg = r === 'locked' ? 'Too many wrong codes: send a new code.' : r === 'expired' ? 'The code has expired: send a new code.' : 'The code is not correct.';
    await this.syslog.write('warn', 'email_change_verify_failed', { request_id: pending.id, outcome: r }, auth.user.id, undefined);
    throw new ProblemException(422, 'invalid_code', {
      detail: msg, errors: [{ path: '/code', code: r === 'bad' ? 'invalid' : r, message: msg }], commit: true,
    });
  }

  private async sendVerification(auth: AuthContext, requestId: string, address: string): Promise<void> {
    const fresh = this.twoFactor.newEmailVerifyCode(requestId);
    const exp = (await this.db.tx.$queryRaw<{ e: Date }[]>`SELECT idm_email_change_set_verification(${requestId}::uuid, ${fresh.hash}::text) AS e`)[0]?.e;
    const until = exp ? `${exp.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
    const sent = await notifyByMail(this.mail, this.syslog, [address], PROFILE_MAIL.verify(fresh.code, until), auth.user.id);
    if (!sent) await this.syslog.write('warn', 'email_change_code_not_sent', { request_id: requestId }, auth.user.id, undefined);
  }

  private async myEmailChange(id: string): Promise<EmailChangeDto> {
    const r = (await this.emailChanges()).find((x) => x.id === id);
    if (!r) throw new ProblemException(500, 'internal_error', {});
    return r;
  }

  /** DELETE /me/email-change: withdraws the pending request. 404 when nothing is pending. */
  async cancelEmailChange(): Promise<void> {
    const pending = (await this.emailChanges()).find((x) => x.status === 'pending');
    if (!pending) throw problems.notFound('No email change is waiting for a decision.');
    await this.db.tx.$executeRaw`SELECT idm_cancel_email_change(${pending.id}::uuid)`;
  }

  // ------------------------------------------------------------------ phone change (0058, D156)
  private async phoneChanges(): Promise<PhoneChangeDto[]> {
    return this.db.tx.$queryRaw<PhoneChangeDto[]>`SELECT id::text AS id, old_phone, new_phone, status, requested_at, decided_at, decision_reason FROM idm_my_phone_changes()`;
  }

  /** POST /me/phone-change: the new phone (E.164) or null (remove it), with the password re-entered. An admin decides it. */
  async requestPhoneChange(auth: AuthContext, raw: unknown): Promise<PhoneChangeDto> {
    this.needLocal(auth, 'Your account signs in with Microsoft 365. Ask an administrator to change your phone.');
    const body = parse(phoneRequestSchema, raw);
    const wait = this.limiter.hit(`phonechange:${auth.user.id}`, PHONE_CHANGE_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    await this.auth.checkOwnPassword(auth, body.password, 'phone_change');
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>`SELECT idm_request_phone_change(${body.new_phone}::text)::text AS id`;
    const id = rows[0]?.id;
    await this.syslog.write('info', 'phone_change_requested', { request_id: id }, auth.user.id, undefined);
    await notifyByMail(this.mail, this.syslog, [auth.user.email], PROFILE_MAIL.phone('requested'), auth.user.id);
    const r = (await this.phoneChanges()).find((x) => x.id === id);
    if (!r) throw new ProblemException(500, 'internal_error', {});
    return r;
  }

  /** DELETE /me/phone-change: withdraws the pending request. 404 when nothing is pending. */
  async cancelPhoneChange(): Promise<void> {
    const pending = (await this.phoneChanges()).find((x) => x.status === 'pending');
    if (!pending) throw problems.notFound('No phone change is waiting for a decision.');
    await this.db.tx.$executeRaw`SELECT idm_cancel_phone_change(${pending.id}::uuid)`;
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
    // 0058 (Q161): the other sessions end, a security notice goes to the inbox (database) and by mail; this session stays
    const ended = await this.twoFactor.selfDisable(auth.user.id, auth.session.id);
    this.states.invalidate(auth.user.id);
    await this.syslog.write('info', 'local_two_factor_self_disabled', { via: r.via, other_sessions_ended: ended }, auth.user.id, undefined);
    await notifyByMail(this.mail, this.syslog, [auth.user.email], PROFILE_MAIL.twoFactorOff(false), auth.user.id);
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
  /** 0058: the documented identity check the admin recorded instead of a mailed code (null otherwise). */
  identity_check: string | null;
}

interface AdminRow {
  id: string; user_id: string; display_name: string; employee_id: string | null; old_email: string; new_email: string; status: EmailChangeDto['status'];
  requested_at: Date; decided_at: Date | null; decided_by: string | null; decided_by_name: string | null; decision_reason: string | null;
  verified_at: Date | null; verified_via: EmailChangeDto['verified_via']; verify_sent_at: Date | null; verify_expires_at: Date | null; identity_check: string | null;
}

const decideSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(1000) }).strict();
const emailDecideSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(3).max(1000),
  identity_check: z.string().trim().min(3).max(1000).optional(),
}).strict();
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'all'] as const;

function statusParam(q: Record<string, unknown>): string | null {
  const raw = q.status ?? 'pending';
  if (typeof raw !== 'string' || !(STATUSES as readonly string[]).includes(raw)) {
    throw problems.validation([{ path: '/status', code: 'invalid', message: `One of ${STATUSES.join(', ')}.` }]);
  }
  return raw === 'all' ? null : raw;
}

/** GET /email-change-requests and POST /email-change-requests/{id}/decide (System Admin, or a delegate holding users.edit for all regions). */
@Injectable()
export class EmailChangesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly states: UserStateService,
    private readonly syslog: SyslogService,
    private readonly mail: MailPort,
  ) {}

  private async rows(status: string | null): Promise<EmailChangeAdminDto[]> {
    const rows = await this.db.tx.$queryRaw<AdminRow[]>(Prisma.sql`SELECT id::text AS id, user_id::text AS user_id, display_name, employee_id, old_email, new_email,
      status, requested_at, decided_at, decided_by::text AS decided_by, decided_by_name, decision_reason, verified_at, verified_via, verify_sent_at,
      verify_expires_at, identity_check FROM idm_email_change_list(${status}::text)`);
    return rows.map((r) => ({
      id: r.id, old_email: r.old_email, new_email: r.new_email, status: r.status, requested_at: r.requested_at, decided_at: r.decided_at,
      decision_reason: r.decision_reason, verified_at: r.verified_at, verified_via: r.verified_via, verify_sent_at: r.verify_sent_at,
      verify_expires_at: r.verify_expires_at, identity_check: r.identity_check,
      user: { id: r.user_id, display_name: r.display_name, employee_id: r.employee_id?.trim() || null },
      decided_by: r.decided_by ? { id: r.decided_by, display_name: r.decided_by_name ?? '', employee_id: null } : null,
    }));
  }

  async list(q: Record<string, unknown>): Promise<{ items: EmailChangeAdminDto[]; page: { limit: number; next_cursor: null; total: number } }> {
    await this.access.requireAdmin('users', 'edit');
    const items = (await this.rows(statusParam(q))).slice(0, 200);
    return { items, page: { limit: 200, next_cursor: null, total: items.length } };
  }

  /**
   * Approve needs a verified new address (Q158): the user entered the mailed code, or the admin sends `identity_check` (the documented
   * check made while mail is unavailable). Otherwise 409 email_not_verified. Old and new addresses are told by mail.
   */
  async decide(auth: AuthContext, id: string, raw: unknown): Promise<EmailChangeAdminDto> {
    const body = parse(emailDecideSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    if (!z.string().uuid().safeParse(id).success) throw problems.notFound();
    // the database decides who may (idm_actor users.edit, global, not one's own, a delegate never for an admin); step-up first
    await this.stepUp.require(auth);
    const check = body.decision === 'approve' ? body.identity_check ?? null : null;
    await this.db.tx.$queryRaw`SELECT idm_decide_email_change(${id}::uuid, ${body.decision === 'approve'}::boolean, ${body.reason}::text, ${check}::text) AS s`;
    const r = (await this.rows(null)).find((x) => x.id === id);
    if (!r) throw new ProblemException(500, 'internal_error', {});
    this.states.invalidate(r.user.id);
    await this.syslog.write('info', body.decision === 'approve' ? 'email_change_approved' : 'email_change_rejected',
      { target_user: r.user.id, request_id: id, verified_via: r.verified_via }, auth.user.id);
    await notifyByMail(this.mail, this.syslog, [r.old_email, r.new_email], PROFILE_MAIL.emailDecided(body.decision === 'approve'), auth.user.id);
    return r;
  }
}

// ------------------------------------------------------------------ admin side of the phone change (0058, D156)
export interface PhoneChangeAdminDto extends PhoneChangeDto {
  user: UserRef;
  decided_by: UserRef | null;
}

interface PhoneAdminRow {
  id: string; user_id: string; display_name: string; employee_id: string | null; old_phone: string | null; new_phone: string | null;
  status: PhoneChangeDto['status']; requested_at: Date; decided_at: Date | null; decided_by: string | null; decided_by_name: string | null; decision_reason: string | null;
}

/** GET /phone-change-requests and POST /phone-change-requests/{id}/decide (same rights as the email change). */
@Injectable()
export class PhoneChangesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly states: UserStateService,
    private readonly syslog: SyslogService,
    private readonly repo: UsersRepo,
    private readonly mail: MailPort,
  ) {}

  private async rows(status: string | null): Promise<PhoneChangeAdminDto[]> {
    const rows = await this.db.tx.$queryRaw<PhoneAdminRow[]>(Prisma.sql`SELECT id::text AS id, user_id::text AS user_id, display_name, employee_id, old_phone, new_phone,
      status, requested_at, decided_at, decided_by::text AS decided_by, decided_by_name, decision_reason FROM idm_phone_change_list(${status}::text)`);
    return rows.map((r) => ({
      id: r.id, old_phone: r.old_phone, new_phone: r.new_phone, status: r.status, requested_at: r.requested_at, decided_at: r.decided_at,
      decision_reason: r.decision_reason,
      user: { id: r.user_id, display_name: r.display_name, employee_id: r.employee_id?.trim() || null },
      decided_by: r.decided_by ? { id: r.decided_by, display_name: r.decided_by_name ?? '', employee_id: null } : null,
    }));
  }

  async list(q: Record<string, unknown>): Promise<{ items: PhoneChangeAdminDto[]; page: { limit: number; next_cursor: null; total: number } }> {
    await this.access.requireAdmin('users', 'edit');
    const items = (await this.rows(statusParam(q))).slice(0, 200);
    return { items, page: { limit: 200, next_cursor: null, total: items.length } };
  }

  async decide(auth: AuthContext, id: string, raw: unknown): Promise<PhoneChangeAdminDto> {
    const body = parse(decideSchema, raw);
    await this.access.requireAdmin('users', 'edit');
    if (!z.string().uuid().safeParse(id).success) throw problems.notFound();
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw`SELECT idm_decide_phone_change(${id}::uuid, ${body.decision === 'approve'}::boolean, ${body.reason}::text) AS s`;
    const r = (await this.rows(null)).find((x) => x.id === id);
    if (!r) throw new ProblemException(500, 'internal_error', {});
    this.states.invalidate(r.user.id);
    await this.syslog.write('info', body.decision === 'approve' ? 'phone_change_approved' : 'phone_change_rejected', { target_user: r.user.id, request_id: id }, auth.user.id);
    const target = await this.repo.find(r.user.id);
    await notifyByMail(this.mail, this.syslog, [target?.email], PROFILE_MAIL.phone(body.decision === 'approve' ? 'approved' : 'rejected'), auth.user.id);
    return r;
  }
}
