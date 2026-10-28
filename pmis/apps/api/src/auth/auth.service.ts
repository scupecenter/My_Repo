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

export const loginSchema = z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(128) }).strict();
const stepUpSchema = z.object({ password: z.string().max(128) }).strict();
const changePasswordSchema = z.object({ current_password: z.string().max(128), new_password: z.string().max(1024) }).strict();

export const LOGIN_LIMIT_PER_IP = 10;
export const LOGIN_LIMIT_PER_IDENTIFIER = 5;
export const PASSWORD_CHANGE_LIMIT = 10;

interface LookupRow {
  user_id: string;
  password_hash: string;
  must_change: boolean;
  locked_until: Date | null;
  status: UserStatus;
}

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
  ) {}

  async sessionBody(auth: AuthContext, csrf = auth.session.csrfToken): Promise<SessionBody> {
    const idleEnd = auth.session.lastActivityAt.getTime() + IDLE_HOURS * 3600_000;
    return {
      authenticated: true,
      csrf_token: csrf,
      user: { id: auth.user.id, display_name: auth.user.displayName, employee_id: auth.user.employeeId },
      status: auth.user.status,
      needs_employee_id: false, // a local account is created with its identifiers; the M365 employee-ID link does not apply
      mfa: false,
      break_glass: auth.session.authMethod === 'break_glass',
      auth_method: auth.session.authMethod,
      must_change_password: auth.state.mustChange && auth.session.authMethod === 'local',
      stepup_valid_until: await this.stepUp.validUntil(auth),
      expires_at: new Date(Math.min(auth.session.expiresAt.getTime(), idleEnd)),
    };
  }

  /**
   * POST /auth/local/login. Every failure is the same 401: unknown identifier, wrong password, locked, local sign-in off,
   * suspended or disabled. A dummy argon2 verify runs when nothing matched so the timing does not tell them apart.
   */
  async login(rawBody: unknown, ip: string | null, userAgent: string | undefined, requestId: string): Promise<{ token: string; body: SessionBody }> {
    const parsed = loginSchema.safeParse(rawBody);
    if (!parsed.success) throw new ProblemException(400, 'validation_failed', { detail: 'identifier and password are required.', errors: zodErrors(parsed.error) });
    const { password } = parsed.data;
    const identifier = normaliseIdentifier(parsed.data.identifier);
    const masked = this.hmac.mask(identifier);

    const ipWait = this.limiter.hit(`login:ip:${ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP);
    const idWait = this.limiter.hit(`login:id:${masked}`, LOGIN_LIMIT_PER_IDENTIFIER);
    if (ipWait || idWait) {
      await this.syslog.write('warn', 'local_sign_in_rate_limited', { identifier_hmac: masked, ip }, undefined, requestId);
      throw problems.rateLimited(Math.max(ipWait, idWait));
    }

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
      await this.syslog.write('warn', 'local_sign_in_failed', { identifier_hmac: masked, reason: 'no_match', ip }, undefined, requestId);
      throw problems.invalidCredentials();
    }
    if (!eligible) {
      await this.syslog.write('warn', 'local_sign_in_failed', { identifier_hmac: masked, reason: locked ? 'locked' : 'status', ip }, row.user_id, requestId);
      throw problems.invalidCredentials();
    }

    // One transaction: the lockout bookkeeping and, on success, the session. app.user_id is set so the audit rows know the user.
    const created = await this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${row.user_id}, true)`;
      await tx.$executeRaw`SELECT auth_local_result(${row.user_id}::uuid, ${ok}::boolean)`;
      return this.db.runIn(tx, async () => {
        await this.syslog.write(ok ? 'info' : 'warn', ok ? 'local_sign_in_ok' : 'local_sign_in_failed',
          { identifier_hmac: masked, reason: ok ? undefined : 'bad_password', ip }, row.user_id, requestId);
        return ok ? this.sessions.create(row.user_id, 'local', ip, userAgent) : null;
      });
    });
    this.states.invalidate(row.user_id);
    if (!created) throw problems.invalidCredentials();

    const found = await this.sessions.load(created.token);
    if (!found) throw new ProblemException(500, 'internal_error', {});
    const state = await this.states.get(found.user.id, found.user.email, found.user.status);
    const auth: AuthContext = { session: found.session, user: found.user, state, ip, live: false };
    return { token: created.token, body: await this.sessionBody(auth) };
  }

  /** POST /auth/local/step-up: re-enter the password. A wrong password counts toward the lockout. */
  async localStepUp(auth: AuthContext, rawBody: unknown): Promise<SessionBody> {
    const { password } = parse(stepUpSchema, rawBody);
    const wait = this.limiter.hit(`stepup:${auth.user.id}`, LOGIN_LIMIT_PER_IDENTIFIER);
    if (wait) throw problems.rateLimited(wait);
    await this.checkOwnPassword(auth, password, 'step_up');
    const at = await this.sessions.markStepUp(auth.session.id);
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

  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revoke(auth.session.id, auth.user.id, 'logout');
  }

  /**
   * Checks the signed-in user's own password against auth_local_own_hash and records the result (lockout counter).
   * A wrong password commits the failure first and then answers 401; a locked account answers 429.
   */
  private async checkOwnPassword(auth: AuthContext, password: string, purpose: string): Promise<string> {
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
      throw problems.invalidCredentials(true);
    }
    return row.password_hash;
  }
}
