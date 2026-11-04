import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DbService } from '../db/db.service';
import { LogHmacService } from '../auth/log-hmac.service';
import { RequestContext, applyContext, secCtx } from './context';

/** The events of the sign-in and security log (migration 0045, contract `SecurityEvent`). */
export type SecurityEvent =
  | 'sign_in_started' | 'sign_in_succeeded' | 'callback_account_mismatch' | 'sign_in_failed' | 'sign_in_locked' | 'sign_in_rate_limited'
  | 'signed_out' | 'session_expired' | 'session_ended' | 'session_revoked_by_admin' | 'mfa_exemption_granted' | 'mfa_exemption_revoked'
  | 'step_up_passed' | 'step_up_failed' | 'break_glass_used' | 'two_factor_passed' | 'two_factor_failed' | 'recovery_code_used'
  | 'two_factor_enrolled' | 'password_changed' | 'password_reset';
export type SecurityOutcome = 'success' | 'failure' | 'info';

export interface SecurityWrite {
  event: SecurityEvent;
  outcome: SecurityOutcome;
  /** The matched person; null when the identifier matched nobody. */
  userId?: string | null;
  /** What was typed in the sign-in box. Only its masked keyed hash is stored, never the text. */
  identifier?: string | null;
  detail?: Record<string, unknown> | null;
  ctx?: RequestContext;
}

/**
 * The one writer of the security log for the API and for the self-service auth endpoints (migration 0044 calls it too). It writes through its own
 * statement (autocommit) by default, so a failed sign-in is recorded even when the request answers an error; `inTx` writes through the request
 * transaction instead (the row then commits or rolls back with the change it describes). Never throws: a logging failure must not break sign-in.
 * Session ends, password changes and resets, lockouts, 2FA enrolment and recovery-code use are recorded by database triggers, not here.
 */
@Injectable()
export class SecurityLogService {
  private readonly log = new Logger('SecurityLog');

  constructor(private readonly db: DbService, private readonly hmac: LogHmacService) {}

  async write(w: SecurityWrite, opts: { inTx?: boolean } = {}): Promise<void> {
    const masked = w.identifier ? this.hmac.masked(w.identifier) : null;
    const ctx = w.ctx ? JSON.stringify(secCtx(w.ctx)) : '{}';
    const detail = w.detail ? JSON.stringify(w.detail) : null;
    const q = Prisma.sql`SELECT sec_log_write(${w.event}::text, ${w.outcome}::text, ${w.userId ?? null}::uuid, ${masked}::text, ${detail}::jsonb, ${ctx}::jsonb)`;
    try {
      if (opts.inTx) await this.db.tx.$queryRaw(q);
      else await this.db.client.$queryRaw(q);
    } catch (e) {
      this.log.warn(`security log write failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }

  /** A cookie that maps to a session past its idle or absolute limit: logged once per session. */
  async sessionExpired(sessionId: string, ctx?: RequestContext): Promise<void> {
    try {
      await this.db.client.$transaction(async (tx) => {
        if (ctx) await applyContext(tx, ctx); // signed, user-less: only the request data for the row
        await tx.$executeRaw(Prisma.sql`SELECT sec_log_session_expired(${sessionId}::uuid)`);
      });
    } catch (e) {
      this.log.warn(`session expiry log failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }
}
