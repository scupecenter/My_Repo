import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { applyContext, RequestContext, UA_MAX } from '../logs/context';
import { MailService } from '../mail/mail.service';
import { LogHmacService } from './log-hmac.service';
import { PasswordService } from './password.service';
import { passwordPolicyErrors } from './password.policy';
import { RateLimiter } from './rate-limiter';
import { SyslogService } from './syslog.service';
import { UserStateService } from './user-state.service';

/** "Forgot password" by email (migration 0162). Every choice is listed in the pull request. */
export const RESET_REQUEST_LIMIT_PER_IP = 10;
export const RESET_REQUEST_LIMIT_PER_IDENTIFIER = 3;
export const RESET_WINDOW_MS = 60 * 60_000;
export const RESET_CONFIRM_LIMIT_PER_IP = 20;
export const RESET_MINUTES = 30;

const requestSchema = z.object({ identifier: z.string().trim().min(1).max(254) }).strict();
/** The token is 32 random bytes as base64url (43 characters). Anything else is refused before it reaches the database. */
const confirmSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), new_password: z.string().max(1024) }).strict();

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const ctxOf = (ip: string | null, userAgent: string | undefined, requestId: string): RequestContext => ({
  ip, userAgent: userAgent ? userAgent.slice(0, UA_MAX) : null, requestId: requestId || null, sessionId: null, authMethod: 'local', via: 'manual',
});
/** Same normalisation as the sign-in box: an email in lower case, a phone without spaces. */
const normalise = (s: string): string => {
  const t = s.trim();
  return t.includes('@') ? t.toLowerCase() : t.replace(/[\s()-]/g, '');
};

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly db: DbService,
    private readonly limiter: RateLimiter,
    private readonly hmac: LogHmacService,
    private readonly passwords: PasswordService,
    private readonly syslog: SyslogService,
    private readonly states: UserStateService,
    private readonly mail: MailService,
  ) {}

  /**
   * POST /auth/local/password-reset/request. Always answers the same (nothing says whether the identifier matched, whether the account is eligible, or
   * whether the per-account limit was hit). Only a limit per address answers 429, which is the same for every identifier.
   */
  async request(rawBody: unknown, ip: string | null, userAgent: string | undefined, requestId: string): Promise<void> {
    const { identifier: typed } = parse(requestSchema, rawBody);
    const identifier = normalise(typed);
    const masked = this.hmac.mask(identifier);
    const wait = this.limiter.hit(`pwreset:ip:${ip ?? 'unknown'}`, RESET_REQUEST_LIMIT_PER_IP, RESET_WINDOW_MS);
    if (wait) {
      await this.syslog.write('warn', 'password_reset_rate_limited', { by: 'ip', ip }, undefined, requestId);
      throw problems.rateLimited(wait);
    }
    // Per account (by keyed hash of what was typed): over the limit the request is dropped quietly, the answer stays the same.
    const quiet = this.limiter.hit(`pwreset:id:${masked}`, RESET_REQUEST_LIMIT_PER_IDENTIFIER, RESET_WINDOW_MS) > 0;
    // The token is made for every request, matched or not, so the work does not tell the two apart.
    const token = randomBytes(32).toString('base64url');
    const ctx = ctxOf(ip, userAgent, requestId);
    let queued = false;
    if (!quiet) {
      queued = await this.db.client.$transaction(async (tx) => {
        await applyContext(tx, ctx);
        return this.db.runIn(tx, async () => {
          const rows = await this.db.tx.$queryRaw<{ user_id: string; email: string }[]>(Prisma.sql`
            SELECT user_id::text AS user_id, email FROM auth_pwreset_request(${identifier}::text, ${sha256Hex(token)}::text, ${ip && isIP(ip) ? ip : null}::inet)`);
          const row = rows[0];
          if (!row) return false;
          await this.db.tx.$executeRaw`SAVEPOINT pmis_reset_mail`;
          try {
            await this.mail.sendToUser(row.user_id, {
              kind: 'identity.password_reset',
              subject: 'GSDN Workspace: reset your password',
              text: `Someone asked to reset the password of your GSDN Workspace account.\n\nOpen this link to choose a new password. It works once and expires in ${RESET_MINUTES} minutes:\n\n{{app_url}}/reset-password#token=${token}\n\n`
                + 'If you did not ask for this, ignore this message: your password has not changed. The link does not sign you in.',
              sensitive: true,
            });
            await this.db.tx.$executeRaw`RELEASE SAVEPOINT pmis_reset_mail`;
            return true;
          } catch {
            await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT pmis_reset_mail`;
            return false;
          }
        });
      });
    }
    // The log never holds the token or the email: only the keyed hash of what was typed and whether the request was dropped.
    await this.syslog.write('info', 'password_reset_requested', { identifier_hmac: masked, ip, dropped: quiet, queued }, undefined, requestId);
  }

  /**
   * POST /auth/local/password-reset/confirm. A wrong, used or expired link answers one generic 422. The new password goes through the same policy as
   * a password change; on success every session of the account ends and two-factor stays required at the next sign-in.
   */
  async confirm(rawBody: unknown, ip: string | null, userAgent: string | undefined, requestId: string): Promise<void> {
    const body = confirmSchema.safeParse(rawBody);
    const wait = this.limiter.hit(`pwreset:confirm:${ip ?? 'unknown'}`, RESET_CONFIRM_LIMIT_PER_IP, RESET_WINDOW_MS);
    if (wait) throw problems.rateLimited(wait);
    if (!body.success) throw this.badLink();
    const hash = sha256Hex(body.data.token);
    const ctx = ctxOf(ip, userAgent, requestId);
    const ipValue = ip && isIP(ip) ? ip : null;
    const found = await this.db.client.$transaction(async (tx) => {
      await applyContext(tx, ctx);
      return this.db.runIn(tx, () => this.db.tx.$queryRaw<{ user_id: string; email: string; employee_id: string | null; phone: string | null; password_hash: string }[]>(
        Prisma.sql`SELECT user_id::text AS user_id, email, employee_id, phone, password_hash FROM auth_pwreset_context(${hash}::text)`));
    });
    const who = found[0];
    if (!who) {
      await this.syslog.write('warn', 'password_reset_failed', { reason: 'bad_link', ip }, undefined, requestId);
      throw this.badLink();
    }
    const errors = passwordPolicyErrors(body.data.new_password, { email: who.email, employeeId: who.employee_id?.trim() || null, phone: who.phone }, '/new_password');
    if (await this.passwords.verify(who.password_hash, body.data.new_password)) {
      errors.push({ path: '/new_password', code: 'same_as_current', message: 'The new password must differ from the current one.' });
    }
    if (errors.length > 0) throw new ProblemException(422, 'weak_password', { detail: 'The new password does not meet the policy.', errors });
    const newHash = await this.passwords.hash(body.data.new_password);
    const done = await this.db.client.$transaction(async (tx) => {
      await applyContext(tx, { ...ctx, userId: who.user_id });
      return this.db.runIn(tx, async () => {
        const r = await this.db.tx.$queryRaw<{ id: string | null }[]>(Prisma.sql`SELECT auth_pwreset_complete(${hash}::text, ${newHash}::text, ${ipValue}::inet)::text AS id`);
        const id = r[0]?.id ?? null;
        if (!id) return false;
        await this.db.tx.$executeRaw`SAVEPOINT pmis_reset_mail`;
        try {
          await this.mail.sendToUser(id, {
            kind: 'identity.password_reset_done',
            subject: 'GSDN Workspace: your password was changed',
            text: 'The password of your GSDN Workspace account was just changed with a reset link, and every open session ended.\n\n'
              + 'If this was you, no action is needed. If it was not, tell a System Admin at once.',
          });
          await this.db.tx.$executeRaw`RELEASE SAVEPOINT pmis_reset_mail`;
        } catch {
          await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT pmis_reset_mail`;
        }
        await this.syslog.write('info', 'password_reset_done', { ip }, id, requestId);
        return true;
      });
    });
    if (!done) throw this.badLink();
    this.states.invalidate(who.user_id);
  }

  private badLink(): ProblemException {
    return new ProblemException(422, 'invalid_code', {
      detail: 'This link is not valid or has expired. Ask for a new one.', errors: [{ path: '/token', code: 'invalid', message: 'This link is not valid or has expired.' }],
    });
  }
}
