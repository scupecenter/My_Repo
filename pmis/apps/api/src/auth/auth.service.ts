import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { ProblemException, problems } from '../common/problem';
import { parse, zodErrors } from '../common/zod';
import type { AuthContext, UserStatus } from './auth.types';
import { LogHmacService } from './log-hmac.service';
import { PasswordService } from './password.service';
import { passwordPolicyErrors } from './password.policy';
import { RateLimiter } from './rate-limiter';
import { SessionService } from './session.service';
import { StepUpService } from './step-up.service';
import { SyslogService } from './syslog.service';
import { UserStateService } from './user-state.service';
import { IDLE_HOURS } from './session.service';
import { CodeInput, TwoFactorService, TWO_FACTOR_PARAMS } from './two-factor.service';
import { SecurityLogService } from '../logs/security-log.service';
import { applyContext, RequestContext, UA_MAX } from '../logs/context';

/** The context of a sign-in request that has no session yet. */
const signInCtx = (ip: string | null, userAgent: string | undefined, requestId: string, sessionId?: string): RequestContext => ({
  ip, userAgent: userAgent ? userAgent.slice(0, UA_MAX) : null, requestId: requestId || null, sessionId: sessionId ?? null, authMethod: 'local', via: 'manual',
});

export const loginSchema = z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(128) }).strict();
const codeFields = {
  code: z.string().trim().max(16).optional(),
  recovery_code: z.string().trim().max(32).optional(),
};
const eitherCode = (b: { code?: string; recovery_code?: string }): boolean => (b.code === undefined) !== (b.recovery_code === undefined);
const eitherMsg = { message: 'Send code or recovery_code, not both.', path: ['code'] };
/** POST /auth/local/2fa: a TOTP code or one recovery code. */
export const twoFactorSchema = z.object(codeFields).strict().refine(eitherCode, eitherMsg);
const stepUpSchema = z.object({ password: z.string().max(128), ...codeFields }).strict();
const confirmSchema = z.object({ code: z.string().trim().min(1).max(16) }).strict();
/** The one-time enrolment code an admin handed over (XXXX-XXXX; spaces and a missing dash are fine). A missing one is a 422 and counts for nothing. */
const enrolCodeField = z.string().trim().min(1, 'Enter the enrolment code from your administrator.').max(32);
const enrolStartSchema = z.object({ enrol_code: enrolCodeField }).strict();
const enrolConfirmSchema = z.object({ code: z.string().trim().min(1).max(16), enrol_code: enrolCodeField }).strict();

function codeInput(b: { code?: string; recovery_code?: string }): CodeInput | null {
  if (b.recovery_code !== undefined) return { recovery_code: b.recovery_code };
  if (b.code !== undefined) return { code: b.code.replace(/\s/g, '') };
  return null;
}
const changePasswordSchema = z.object({ current_password: z.string().max(128), new_password: z.string().max(1024) }).strict();

export const LOGIN_LIMIT_PER_IP = 10;
/** Progressive limiting per address (Q168): failures counted over 15 minutes; after LOGIN_LIMIT_PER_IP of them the wait doubles from 2 s up to 60 s. */
export const LOGIN_IP_WINDOW_MS = 15 * 60_000;
export const LOGIN_IP_BASE_SECONDS = 2;
export const LOGIN_IP_MAX_SECONDS = 60;
export const LOGIN_LIMIT_PER_IDENTIFIER = 5;
export const PASSWORD_CHANGE_LIMIT = 10;

interface LookupRow {
  user_id: string;
  password_hash: string;
  must_change: boolean;
  locked_until: Date | null;
  status: UserStatus;
}

/** Login answer when the password was right but a code (or enrolment) is still needed. No session exists yet. */
export interface PendingBody {
  authenticated: false;
  next: 'two_factor' | 'enrol';
  expires_at: Date;
}

export type LoginResult =
  | { kind: 'session'; token: string; body: SessionBody }
  | { kind: 'pending'; token: string; body: PendingBody };

export interface SessionBody {
  authenticated: true;
  csrf_token: string;
  user: { id: string; display_name: string; employee_id: string | null };
  status: UserStatus;
  needs_employee_id: boolean;
  mfa: boolean;
  break_glass: boolean;
  auth_method: string;
  must_change_password: boolean;
  two_factor: { enabled: boolean; recovery_codes_remaining: number; enforced: boolean };
  stepup_valid_until: Date | null;
  expires_at: Date;
}

/** Phones are typed in many ways; the database looks up the E.164 form only. */
export function normaliseIdentifier(raw: string): string {
  const s = raw.trim();
  if (/^[0-9]{4}$/.test(s) || s.includes('@')) return s;
  if (/^(\+|00)?[0-9][0-9\s().-]{6,}$/.test(s)) {
    const digits = s.replace(/[^0-9+]/g, '');
    return digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
  }
  return s;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly states: UserStateService,
    private readonly stepUp: StepUpService,
    private readonly limiter: RateLimiter,
    private readonly hmac: LogHmacService,
    private readonly syslog: SyslogService,
    private readonly twoFactor: TwoFactorService,
    private readonly securityLog: SecurityLogService,
  ) {}

  async sessionBody(auth: AuthContext, csrf = auth.session.csrfToken): Promise<SessionBody> {
    const idleEnd = auth.session.lastActivityAt.getTime() + IDLE_HOURS * 3600_000;
    const tf = await this.twoFactor.state(auth.user.id);
    return {
      authenticated: true,
      csrf_token: csrf,
      user: { id: auth.user.id, display_name: auth.user.displayName, employee_id: auth.user.employeeId },
      status: auth.user.status,
      needs_employee_id: false, // a local account is created with its identifiers; the M365 employee-ID link does not apply
      mfa: auth.session.twoFactor,
      break_glass: auth.session.authMethod === 'break_glass',
      auth_method: auth.session.authMethod,
      must_change_password: auth.state.mustChange && auth.session.authMethod === 'local',
      two_factor: { enabled: tf.required && tf.enrolled, recovery_codes_remaining: tf.recovery_remaining, enforced: tf.required ? await this.twoFactor.enforced(auth.user.id) : false },
      stepup_valid_until: await this.stepUp.validUntil(auth),
      expires_at: new Date(Math.min(auth.session.expiresAt.getTime(), idleEnd)),
    };
  }

  /**
   * POST /auth/local/login. Every failure is the same 401: unknown identifier, wrong password, locked, local sign-in off,
   * suspended or disabled. A dummy argon2 verify runs when nothing matched so the timing does not tell them apart.
   */
  async login(rawBody: unknown, ip: string | null, userAgent: string | undefined, requestId: string): Promise<LoginResult> {
    const parsed = loginSchema.safeParse(rawBody);
    if (!parsed.success) throw new ProblemException(400, 'validation_failed', { detail: 'identifier and password are required.', errors: zodErrors(parsed.error) });
    const { password } = parsed.data;
    const identifier = normaliseIdentifier(parsed.data.identifier);
    const masked = this.hmac.mask(identifier);
    const ctx = signInCtx(ip, userAgent, requestId);

    const ipKey = `login:ip:${ip ?? 'unknown'}`;
    const ipWait = this.limiter.progressiveWait(ipKey, LOGIN_LIMIT_PER_IP, LOGIN_IP_WINDOW_MS, LOGIN_IP_BASE_SECONDS, LOGIN_IP_MAX_SECONDS);
    const idWait = ipWait ? 0 : this.limiter.hit(`login:id:${masked}`, LOGIN_LIMIT_PER_IDENTIFIER);
    if (ipWait || idWait) {
      await this.syslog.write('warn', 'local_sign_in_rate_limited', { identifier_hmac: masked, ip }, undefined, requestId);
      await this.securityLog.write({ event: 'sign_in_rate_limited', outcome: 'failure', identifier, ctx, detail: { by: ipWait ? 'ip' : 'identifier' } });
      throw problems.rateLimited(Math.max(ipWait, idWait));
    }
    // Reserved before the first await: parallel attempts from one address count as failures until they end, so they cannot all pass the check above.
    const release = this.limiter.progressiveBegin(ipKey);
    const failed = (): void => {
      this.limiter.progressiveFail(ipKey, LOGIN_IP_WINDOW_MS);
      release();
    };
    try {
      return await this.loginChecked(identifier, password, masked, ctx, ip, userAgent, requestId, failed);
    } finally {
      release();
    }
  }

  private async loginChecked(identifier: string, password: string, masked: string, ctx: ReturnType<typeof signInCtx>, ip: string | null,
    userAgent: string | undefined, requestId: string, failed: () => void): Promise<LoginResult> {

    const rows = await this.db.client.$queryRaw<LookupRow[]>(Prisma.sql`SELECT user_id::text AS user_id, password_hash, must_change, locked_until, status::text AS status
      FROM auth_local_lookup(${identifier})`);
    const row = rows[0];
    const locked = !!row?.locked_until && row.locked_until.getTime() > Date.now();
    const statusOk = row?.status === 'active' || row?.status === 'pending_assignment';
    const eligible = !!row && !locked && statusOk;

    let ok = false;
    if (eligible && row) ok = await this.passwords.verify(row.password_hash, password);
    else await this.passwords.dummyVerify(password);

    if (!row) {
      failed();
      await this.syslog.write('warn', 'local_sign_in_failed', { identifier_hmac: masked, reason: 'no_match', ip }, undefined, requestId);
      await this.securityLog.write({ event: 'sign_in_failed', outcome: 'failure', identifier, ctx, detail: { reason: 'no_match' } });
      throw problems.invalidCredentials();
    }
    if (!eligible) {
      failed();
      await this.syslog.write('warn', 'local_sign_in_failed', { identifier_hmac: masked, reason: locked ? 'locked' : 'status', ip }, row.user_id, requestId);
      await this.securityLog.write({ event: 'sign_in_failed', outcome: 'failure', userId: row.user_id, identifier, ctx, detail: { reason: locked ? 'locked' : 'status' } });
      throw problems.invalidCredentials();
    }

    // One transaction: the lockout bookkeeping and, on success, the session. The signed context (app_begin) names the user so the audit rows know them.
    const created = await this.db.client.$transaction(async (tx) => {
      await applyContext(tx, { ...ctx, userId: row.user_id });
      await tx.$executeRaw`SELECT auth_local_result(${row.user_id}::uuid, ${ok}::boolean)`;
      return this.db.runIn(tx, async () => {
        const tf = ok ? await this.twoFactor.state(row.user_id) : null;
        // Two-factor on: the password alone gives no session. A pending sign-in (5 minutes, single use) waits for the code or the enrolment.
        const next = tf?.required ? (tf.enrolled ? ('two_factor' as const) : ('enrol' as const)) : null;
        const pending = next ? await this.twoFactor.createPending(row.user_id, next, ip) : null;
        await this.syslog.write(ok ? 'info' : 'warn', !ok ? 'local_sign_in_failed' : pending ? 'local_sign_in_password_ok' : 'local_sign_in_ok',
          { identifier_hmac: masked, reason: ok ? undefined : 'bad_password', ip, ...(next ? { next } : {}) }, row.user_id, requestId);
        if (!ok) return null;
        if (pending && next) return { pending: true as const, token: pending.token, expiresAt: pending.expiresAt, next };
        return { pending: false as const, ...(await this.sessions.create(row.user_id, 'local', ip, userAgent)) };
      });
    });
    this.states.invalidate(row.user_id);
    if (!created) {
      failed();
      await this.securityLog.write({ event: 'sign_in_failed', outcome: 'failure', userId: row.user_id, identifier, ctx, detail: { reason: 'bad_password' } });
      throw problems.invalidCredentials();
    }
    if (created.pending) await this.securityLog.write({ event: 'sign_in_started', outcome: 'info', userId: row.user_id, identifier, ctx, detail: { next: created.next } });
    else await this.securityLog.write({ event: 'sign_in_succeeded', outcome: 'success', userId: row.user_id, identifier, ctx: { ...ctx, sessionId: created.id }, detail: { method: 'password' } });
    if (created.pending) return { kind: 'pending', token: created.token, body: { authenticated: false, next: created.next, expires_at: created.expiresAt } };

    const found = await this.sessions.load(created.token);
    if (!found) throw new ProblemException(500, 'internal_error', {});
    const state = await this.states.get(found.user.id, found.user.email, found.user.status);
    const auth: AuthContext = { session: found.session, user: found.user, state, ip, live: false };
    return { kind: 'session', token: created.token, body: await this.sessionBody(auth) };
  }

  /** POST /auth/local/step-up: re-enter the password. A wrong password counts toward the lockout. */
  async localStepUp(auth: AuthContext, rawBody: unknown): Promise<SessionBody> {
    const body = parse(stepUpSchema, rawBody);
    // Two-factor on: the password and a code (TOTP, or a recovery code once) together. Nothing is counted while the code is missing.
    const tf = await this.twoFactor.state(auth.user.id);
    const input = codeInput(body);
    const needCode = tf.required && tf.enrolled;
    if (needCode && (!input || (body.code !== undefined && body.recovery_code !== undefined))) {
      throw problems.validation([{ path: '/code', code: 'required', message: 'Send the code from your authenticator app (or one recovery code).' }]);
    }
    const wait = this.limiter.hit(`stepup:${auth.user.id}`, LOGIN_LIMIT_PER_IDENTIFIER);
    if (wait) throw problems.rateLimited(wait);
    await this.checkOwnPassword(auth, body.password, 'step_up');
    if (needCode && input) {
      const r = await this.twoFactor.check(auth.user.id, input);
      if (!r.ok) {
        await this.twoFactor.logFailure(auth.user.id, r.reason, r.via, auth.ip, 'step_up');
        throw this.twoFactor.problem(r.reason, true);
      }
    }
    const at = await this.sessions.markStepUp(auth.session.id);
    await this.securityLog.write({ event: 'step_up_passed', outcome: 'success', userId: auth.user.id, detail: { two_factor: needCode },
      ctx: { ip: auth.ip, userAgent: null, requestId: null, sessionId: auth.session.id, authMethod: 'local' } }, { inTx: true });
    const next: AuthContext = { ...auth, session: { ...auth.session, stepupAt: at, dbNow: new Date(Math.max(at.getTime(), auth.session.dbNow.getTime())) } };
    return this.sessionBody(next);
  }

  /** POST /auth/local/password. Needs the current password; ends the user's other sessions. */
  async changePassword(auth: AuthContext, rawBody: unknown): Promise<SessionBody> {
    const body = parse(changePasswordSchema, rawBody);
    const wait = this.limiter.hit(`pwchange:${auth.user.id}`, PASSWORD_CHANGE_LIMIT);
    if (wait) throw problems.rateLimited(wait);
    const currentHash = await this.checkOwnPassword(auth, body.current_password, 'password_change');

    const errors = passwordPolicyErrors(body.new_password, { email: auth.user.email, employeeId: auth.user.employeeId, phone: auth.user.phone }, '/new_password');
    if (await this.passwords.verify(currentHash, body.new_password)) {
      errors.push({ path: '/new_password', code: 'same_as_current', message: 'The new password must differ from the current one.' });
    }
    if (errors.length > 0) throw new ProblemException(422, 'weak_password', { detail: 'The new password does not meet the policy.', errors });

    const hash = await this.passwords.hash(body.new_password);
    await this.db.tx.$executeRaw`SELECT auth_local_set_own_password(${auth.user.id}::uuid, ${hash})`;
    const ended = await this.sessions.revokeOthers(auth.user.id, auth.session.id, auth.user.id, 'password_changed');
    this.states.invalidate(auth.user.id);
    await this.syslog.write('info', 'local_password_changed', { other_sessions_ended: ended }, auth.user.id, undefined);
    const next: AuthContext = { ...auth, state: { ...auth.state, mustChange: false } };
    return this.sessionBody(next);
  }

  /** Runs `fn` in one transaction for a user who is not signed in yet (pending sign-in): the signed context names the user, ambient transaction on. */
  private async asUser<T>(userId: string, fn: () => Promise<T>, ctx?: RequestContext): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await applyContext(tx, { ...(ctx ?? { ip: null, userAgent: null, requestId: null }), userId });
      return this.db.runIn(tx, fn);
    });
  }

  /** Reads the new session back and builds its body (outside the sign-in transaction). */
  private async sessionFor(token: string, ip: string | null): Promise<{ token: string; body: SessionBody }> {
    const found = await this.sessions.load(token);
    if (!found) throw new ProblemException(500, 'internal_error', {});
    const state = await this.states.get(found.user.id, found.user.email, found.user.status);
    const auth: AuthContext = { session: found.session, user: found.user, state, ip, live: false };
    return { token, body: await this.sessionBody(auth) };
  }

  private async pendingOf(token: string | undefined, kind: 'two_factor' | 'enrol'): Promise<{ userId: string }> {
    const p = token ? await this.twoFactor.loadPending(token) : null;
    if (!p || p.kind !== kind) throw problems.unauthenticated('This sign-in has expired. Enter your password again.');
    return { userId: p.userId };
  }

  /** POST /auth/local/2fa: the code (or one recovery code) after the password. Creates the session; the pending sign-in is single use. */
  async twoFactorSignIn(pendingToken: string | undefined, rawBody: unknown, ip: string | null, userAgent: string | undefined, requestId: string): Promise<{ token: string; body: SessionBody }> {
    const body = parse(twoFactorSchema, rawBody);
    const input = codeInput(body);
    if (!input) throw problems.validation([{ path: '/code', code: 'required' }]);
    const ipWait = this.limiter.hit(`2fa:ip:${ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP);
    if (ipWait) throw problems.rateLimited(ipWait);
    const { userId } = await this.pendingOf(pendingToken, 'two_factor');
    const userWait = this.limiter.hit(`2fa:user:${userId}`, LOGIN_LIMIT_PER_IP);
    if (userWait) throw problems.rateLimited(userWait);

    const out = await this.asUser(userId, async () => {
      const r = await this.twoFactor.check(userId, input);
      if (!r.ok) {
        await this.twoFactor.logFailure(userId, r.reason, r.via, ip, 'sign_in', requestId);
        return { fail: r.reason } as const;
      }
      if (!(await this.twoFactor.consumePending(pendingToken as string, userId))) return { fail: 'expired' } as const;
      await this.syslog.write('info', 'local_sign_in_ok', { via: r.via, two_factor: true, ip }, userId, requestId);
      return { created: await this.sessions.create(userId, 'local', ip, userAgent), via: r.via } as const;
    }, signInCtx(ip, userAgent, requestId));
    if (!('fail' in out)) {
      const c = signInCtx(ip, userAgent, requestId, out.created.id);
      await this.securityLog.write({ event: 'two_factor_passed', outcome: 'success', userId, ctx: c, detail: { via: out.via, purpose: 'sign_in' } });
      await this.securityLog.write({ event: 'sign_in_succeeded', outcome: 'success', userId, ctx: c, detail: { method: 'password_totp' } });
    }
    this.states.invalidate(userId);
    if ('fail' in out) {
      if (out.fail === 'expired') throw problems.unauthenticated('This sign-in has expired. Enter your password again.');
      throw this.twoFactor.problem(out.fail as 'bad' | 'replay' | 'locked', false);
    }
    return this.sessionFor(out.created.token, ip);
  }

  /**
   * POST /auth/local/2fa/enrol/start: a fresh secret and the otpauth URI for the QR code. Only for a pending enrolment, and only with the
   * one-time enrolment code an admin issued: without it nothing is shown and no secret is stored. A wrong code counts toward the lock.
   */
  async enrolStart(pendingToken: string | undefined, rawBody: unknown, ip: string | null, requestId: string): Promise<Record<string, unknown>> {
    const { enrol_code } = parse(enrolStartSchema, rawBody);
    const ipWait = this.limiter.hit(`2fa:ip:${ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP);
    if (ipWait) throw problems.rateLimited(ipWait);
    const { userId } = await this.pendingOf(pendingToken, 'enrol');
    const userWait = this.limiter.hit(`2fa:user:${userId}`, LOGIN_LIMIT_PER_IP);
    if (userWait) throw problems.rateLimited(userWait);
    const out = await this.asUser(userId, async () => {
      const rows = await this.db.tx.$queryRaw<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}::uuid`;
      const email = rows[0]?.email ?? userId;
      const e = await this.twoFactor.beginEnrol(userId, email, pendingToken as string, enrol_code);
      if (!e.ok) {
        await this.twoFactor.logFailure(userId, e.reason === 'locked' ? 'locked' : 'bad', 'enrol_code', ip, 'enrol_start', requestId, e.reason === 'expired' ? 'expired' : undefined);
        return { fail: e.reason } as const;
      }
      return { ok: { secret: e.secret, otpauth_uri: e.otpauth_uri, issuer: TWO_FACTOR_PARAMS.issuer, account: email, algorithm: TWO_FACTOR_PARAMS.algorithm, digits: TWO_FACTOR_PARAMS.digits, period: TWO_FACTOR_PARAMS.period } } as const;
    }, signInCtx(ip, undefined, requestId));
    this.states.invalidate(userId);
    if (out.fail !== undefined) throw this.twoFactor.enrolProblem(out.fail, false);
    return out.ok;
  }

  /** POST /auth/local/2fa/enrol/confirm: the first code. Turns two-factor on for the user, returns the recovery codes once, and signs in. */
  async enrolConfirm(pendingToken: string | undefined, rawBody: unknown, ip: string | null, userAgent: string | undefined, requestId: string): Promise<{ token: string; body: SessionBody; recovery_codes: string[] }> {
    const { code, enrol_code } = parse(enrolConfirmSchema, rawBody);
    const ipWait = this.limiter.hit(`2fa:ip:${ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP);
    if (ipWait) throw problems.rateLimited(ipWait);
    const { userId } = await this.pendingOf(pendingToken, 'enrol');
    const userWait = this.limiter.hit(`2fa:user:${userId}`, LOGIN_LIMIT_PER_IP);
    if (userWait) throw problems.rateLimited(userWait);

    const out = await this.asUser(userId, async () => {
      const r = await this.twoFactor.checkPendingSecret(userId, code.replace(/\s/g, ''));
      if (!r.ok) {
        await this.twoFactor.logFailure(userId, r.reason, 'totp', ip, 'enrol', requestId);
        return { fail: r.reason } as const;
      }
      const done = await this.twoFactor.confirmEnrol(userId, r.step, pendingToken as string, enrol_code);
      if (!done.ok) {
        await this.twoFactor.logFailure(userId, done.reason === 'locked' ? 'locked' : 'bad', 'enrol_code', ip, 'enrol_confirm', requestId, done.reason === 'expired' ? 'expired' : undefined);
        return { enrolFail: done.reason } as const;
      }
      const codes = done.codes;
      if (!(await this.twoFactor.consumePending(pendingToken as string, userId))) return { fail: 'expired' } as const;
      await this.syslog.write('info', 'local_two_factor_enrolled', { ip }, userId, requestId);
      return { codes, created: await this.sessions.create(userId, 'local', ip, userAgent) } as const;
    }, signInCtx(ip, userAgent, requestId));
    if ('created' in out && out.created) await this.securityLog.write({ event: 'sign_in_succeeded', outcome: 'success', userId, ctx: signInCtx(ip, userAgent, requestId, out.created.id), detail: { method: 'enrolment' } });
    this.states.invalidate(userId);
    if (out.enrolFail !== undefined) throw this.twoFactor.enrolProblem(out.enrolFail, false);
    if ('fail' in out) {
      if (out.fail === 'expired') throw problems.unauthenticated('This sign-in has expired. Enter your password again.');
      throw this.twoFactor.problem(out.fail as 'bad' | 'replay' | 'locked', false);
    }
    return { ...(await this.sessionFor(out.created.token, ip)), recovery_codes: out.codes };
  }

  /** POST /auth/local/2fa/recovery-codes: new recovery codes; needs a valid TOTP code (not a recovery code). The old codes stop working. */
  async regenerateRecoveryCodes(auth: AuthContext, rawBody: unknown): Promise<{ recovery_codes: string[]; recovery_codes_remaining: number }> {
    const { code } = parse(confirmSchema, rawBody);
    const tf = await this.twoFactor.state(auth.user.id);
    if (!tf.required || !tf.enrolled) throw new ProblemException(409, 'invalid_transition', { detail: 'Two-factor is not on for your account.' });
    const wait = this.limiter.hit(`2fa:regen:${auth.user.id}`, LOGIN_LIMIT_PER_IDENTIFIER);
    if (wait) throw problems.rateLimited(wait);
    const r = await this.twoFactor.check(auth.user.id, { code: code.replace(/\s/g, '') });
    if (!r.ok) {
      await this.twoFactor.logFailure(auth.user.id, r.reason, r.via, auth.ip, 'recovery_codes');
      throw this.twoFactor.problem(r.reason, true);
    }
    const codes = await this.twoFactor.regenerateRecovery(auth.user.id);
    await this.syslog.write('info', 'local_recovery_codes_regenerated', {}, auth.user.id, undefined);
    return { recovery_codes: codes, recovery_codes_remaining: codes.length };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revoke(auth.session.id, auth.user.id, 'logout');
  }

  /**
   * Checks the signed-in user's own password against auth_local_own_hash and records the result (lockout counter).
   * A wrong password commits the failure first and then answers 401; a locked account answers 429.
   */
  async checkOwnPassword(auth: AuthContext, password: string, purpose: string): Promise<string> {
    const rows = await this.db.tx.$queryRaw<{ password_hash: string; locked_until: Date | null }[]>`SELECT password_hash, locked_until FROM auth_local_own_hash(${auth.user.id}::uuid)`;
    const row = rows[0];
    if (!row) {
      await this.passwords.dummyVerify(password);
      throw problems.invalidCredentials();
    }
    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      await this.passwords.dummyVerify(password);
      throw new ProblemException(429, 'account_locked', {
        detail: 'Too many wrong passwords. The account is locked for a while.',
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((row.locked_until.getTime() - Date.now()) / 1000))) },
      });
    }
    const ok = await this.passwords.verify(row.password_hash, password);
    await this.db.tx.$executeRaw`SELECT auth_local_result(${auth.user.id}::uuid, ${ok}::boolean)`;
    if (!ok) {
      await this.syslog.write('warn', `local_${purpose}_failed`, {}, auth.user.id, undefined);
      await this.securityLog.write({ event: purpose === 'step_up' ? 'step_up_failed' : 'password_changed', outcome: 'failure', userId: auth.user.id,
        detail: { reason: 'bad_password', purpose }, ctx: { ip: auth.ip, userAgent: null, requestId: null, sessionId: auth.session.id, authMethod: 'local' } });
      throw problems.invalidCredentials(true);
    }
    return row.password_hash;
  }
}
