import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ProblemException } from '../common/problem';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { Clock, systemClock } from './rate-limiter';
import { SyslogService } from './syslog.service';
import { parseCookie } from './session.service';
import {
  base32Encode, decryptSecret, encryptSecret, generateRecoveryCodes, generateSecret, hashRecoveryCode, matchStep,
  normaliseRecoveryCode, otpauthUri, parseEncKey, TOTP_DIGITS, TOTP_ISSUER, TOTP_PERIOD_S,
} from './totp';

export type TwoFactorLabel = 'off' | 'pending_enrolment' | 'on';
export type PendingKind = 'two_factor' | 'enrol';

export interface TwoFactorState {
  required: boolean;
  enrolled: boolean;
  recovery_remaining: number;
}

export const labelOf = (s: TwoFactorState): TwoFactorLabel => (!s.required ? 'off' : s.enrolled ? 'on' : 'pending_enrolment');

export const PENDING_COOKIE = 'pmis_2fa';
export const PENDING_COOKIE_PATH = '/api/v1/auth/local/2fa';

export type CodeInput = { code: string } | { recovery_code: string };
export type CodeFailure = 'bad' | 'replay' | 'locked';
export type CodeOutcome = { ok: true; via: 'totp' | 'recovery'; step: number | null } | { ok: false; reason: CodeFailure; via: 'totp' | 'recovery' };

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Primitives of two-factor sign-in (ADR 0014): the encrypted secret, code checks, pending sign-in tokens. The database keeps the
 * counters, the replay guard and the lockout (auth_totp_*); this class never reads a recovery-code hash.
 * Every method that takes a user id runs inside a transaction that has app.user_id set to that user (the ambient `db.tx`).
 */
@Injectable()
export class TwoFactorService {
  private readonly key: Buffer;
  private clock: Clock = systemClock;

  constructor(
    private readonly db: DbService,
    private readonly syslog: SyslogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const key = parseEncKey(config.totpEncKey);
    if (!key) throw new Error('TOTP_ENC_KEY must be 32 bytes (64 hex characters or base64)');
    this.key = key;
  }

  /** Tests set a fake clock to get deterministic time steps. */
  setClock(clock: Clock): void {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  async state(userId: string): Promise<TwoFactorState> {
    const rows = await this.db.tx.$queryRaw<TwoFactorState[]>`SELECT required, enrolled, recovery_remaining FROM auth_totp_state(${userId}::uuid)`;
    return rows[0] ?? { required: false, enrolled: false, recovery_remaining: 0 };
  }

  // ------------------------------------------------------------------ pending sign-in token (cookie pmis_2fa)
  pendingTokenFrom(req: Request): string | undefined {
    const t = parseCookie(req.headers.cookie, PENDING_COOKIE);
    return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : undefined;
  }

  setPendingCookie(res: Response, token: string): void {
    res.cookie(PENDING_COOKIE, token, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'strict', path: PENDING_COOKIE_PATH, maxAge: 5 * 60 * 1000 });
  }

  clearPendingCookie(res: Response): void {
    res.clearCookie(PENDING_COOKIE, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'strict', path: PENDING_COOKIE_PATH });
  }

  /** Inside the sign-in transaction (app.user_id set, password just checked). Returns the cookie token and its end. */
  async createPending(userId: string, kind: PendingKind, ip: string | null): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const ipValue = ip && isIP(ip) ? ip : null;
    const rows = await this.db.tx.$queryRaw<{ until: Date }[]>(Prisma.sql`
      SELECT auth_pending_create(${userId}::uuid, ${sha256Hex(token)}, ${kind}, ${ipValue}::inet) AS until`);
    return { token, expiresAt: rows[0]!.until };
  }

  async loadPending(token: string): Promise<{ userId: string; kind: PendingKind; expiresAt: Date } | null> {
    const rows = await this.db.client.$queryRaw<{ user_id: string; kind: PendingKind; expires_at: Date }[]>`
      SELECT user_id::text AS user_id, kind, expires_at FROM auth_pending_load(${sha256Hex(token)})`;
    const r = rows[0];
    return r ? { userId: r.user_id, kind: r.kind, expiresAt: r.expires_at } : null;
  }

  async consumePending(token: string, userId: string): Promise<boolean> {
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT auth_pending_consume(${sha256Hex(token)}, ${userId}::uuid) AS ok`;
    return rows[0]?.ok === true;
  }

  // ------------------------------------------------------------------ code checks
  private async secrets(userId: string): Promise<{ secret_enc: string | null; pending_secret_enc: string | null; last_step: bigint | null; locked_until: Date | null } | undefined> {
    const rows = await this.db.tx.$queryRaw<{ secret_enc: string | null; pending_secret_enc: string | null; last_step: bigint | null; locked_until: Date | null }[]>`
      SELECT secret_enc, pending_secret_enc, last_step, locked_until FROM auth_totp_secret(${userId}::uuid)`;
    return rows[0];
  }

  /**
   * Checks a TOTP code or a recovery code of a user who is enrolled, and records the outcome (counter, replay guard, lock) in the
   * database. A wrong code, a replayed one and a locked account are outcomes, not exceptions.
   */
  async check(userId: string, input: CodeInput): Promise<CodeOutcome> {
    const via = 'recovery_code' in input ? 'recovery' : 'totp';
    const row = await this.secrets(userId);
    if (!row || !row.secret_enc) return { ok: false, reason: 'bad', via };
    if (row.locked_until && row.locked_until.getTime() > Date.now()) return { ok: false, reason: 'locked', via };

    if ('recovery_code' in input) {
      const norm = normaliseRecoveryCode(input.recovery_code);
      if (!norm) {
        await this.db.tx.$queryRaw`SELECT auth_totp_result(${userId}::uuid, false, NULL::bigint) AS r`;
        return { ok: false, reason: 'bad', via };
      }
      const r = await this.db.tx.$queryRaw<{ r: string }[]>`SELECT auth_totp_use_recovery(${userId}::uuid, ${hashRecoveryCode(this.key, norm)}) AS r`;
      return r[0]?.r === 'ok' ? { ok: true, via, step: null } : { ok: false, reason: r[0]?.r === 'locked' ? 'locked' : 'bad', via };
    }

    const secret = decryptSecret(this.key, userId, row.secret_enc);
    const step = matchStep(secret, input.code, this.now());
    const r = await this.db.tx.$queryRaw<{ r: string }[]>`SELECT auth_totp_result(${userId}::uuid, ${step !== null}::boolean, ${step}::bigint) AS r`;
    const out = r[0]?.r;
    if (out === 'ok') return { ok: true, via, step };
    return { ok: false, reason: out === 'replay' ? 'replay' : out === 'locked' ? 'locked' : 'bad', via };
  }

  /** The first code of an enrolment, against the pending secret. A wrong one counts toward the lock. Returns the matched step. */
  async checkPendingSecret(userId: string, code: string): Promise<{ ok: true; step: number } | { ok: false; reason: CodeFailure }> {
    const row = await this.secrets(userId);
    if (!row || !row.pending_secret_enc) return { ok: false, reason: 'bad' };
    if (row.locked_until && row.locked_until.getTime() > Date.now()) return { ok: false, reason: 'locked' };
    const step = matchStep(decryptSecret(this.key, userId, row.pending_secret_enc), code, this.now());
    if (step === null) {
      const r = await this.db.tx.$queryRaw<{ r: string }[]>`SELECT auth_totp_result(${userId}::uuid, false, NULL::bigint) AS r`;
      return { ok: false, reason: r[0]?.r === 'locked' ? 'locked' : 'bad' };
    }
    return { ok: true, step };
  }

  // ------------------------------------------------------------------ enrolment
  /** A new secret for the QR code, stored encrypted as the pending secret. The clear secret leaves only in this answer. */
  async beginEnrol(userId: string, account: string): Promise<{ secret: string; otpauth_uri: string }> {
    const raw = generateSecret();
    await this.db.tx.$executeRaw`SELECT auth_totp_begin_enrol(${userId}::uuid, ${encryptSecret(this.key, userId, raw)})`;
    const secret = base32Encode(raw);
    return { secret, otpauth_uri: otpauthUri(secret, account) };
  }

  /** Moves the pending secret to the active one and stores new recovery codes. Returns the codes (shown once). */
  async confirmEnrol(userId: string, step: number): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const hashes = codes.map((c) => hashRecoveryCode(this.key, c.replace('-', '')));
    await this.db.tx.$executeRaw`SELECT auth_totp_confirm_enrol(${userId}::uuid, ${step}::bigint, ${hashes}::text[])`;
    return codes;
  }

  async regenerateRecovery(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const hashes = codes.map((c) => hashRecoveryCode(this.key, c.replace('-', '')));
    await this.db.tx.$executeRaw`SELECT auth_totp_regenerate_recovery(${userId}::uuid, ${hashes}::text[])`;
    return codes;
  }

  // ------------------------------------------------------------------ outcomes
  async logFailure(userId: string, reason: CodeFailure, via: string, ip: string | null, purpose: string, requestId?: string): Promise<void> {
    await this.syslog.write('warn', 'local_two_factor_failed', { reason, via, purpose, ip }, userId, requestId);
  }

  problem(reason: CodeFailure, commit: boolean): ProblemException {
    if (reason === 'locked') {
      return new ProblemException(429, 'account_locked', { detail: 'Too many wrong codes. The account is locked for a while.', headers: { 'Retry-After': '900' }, commit });
    }
    return new ProblemException(401, 'invalid_code', {
      detail: reason === 'replay' ? 'This code was already used. Wait for the next code and try again.' : 'The code is not correct.',
      commit,
    });
  }
}

export const TWO_FACTOR_PARAMS = { issuer: TOTP_ISSUER, digits: TOTP_DIGITS, period: TOTP_PERIOD_S, algorithm: 'SHA1' } as const;
