import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter';
import type { AuthContext } from '../auth/auth.types';
import { parseCookie } from '../auth/session.service';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { MailService } from '../mail/mail.service';

/** The cookie that names this browser (random, 32 bytes; only its SHA-256 is stored, next to the account). */
export const DEVICE_COOKIE = 'pmis_dev';
const DEVICE_COOKIE_PATH = '/api/v1/auth/local';
const DEVICE_COOKIE_MS = 400 * 24 * 3_600_000;
const BYPASS_PER_MINUTE = 10;
const SETTING_PER_MINUTE = 10;

const reason = z.string().trim().min(3).max(900);
const putBody = z.object({ enabled: z.boolean(), code_minutes: z.number().int().min(5).max(30), include_admins: z.boolean(), reason }).strict();
const bypassBody = z.object({ user_id: z.guid(), minutes: z.number().int().min(1).max(60).optional(), reason }).strict();
export const deviceCodeBody = z.object({ code: z.string().trim().regex(/^[0-9]{6}$/) }).strict();

export interface NewDeviceSettingDto {
  enabled: boolean; code_minutes: number; include_admins: boolean; mail_ready: boolean;
  updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; version: number; can_edit: boolean;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
/** What is stored for a browser: never the cookie value itself. */
export const deviceHash = (id: string): string => sha256Hex(`device:${id}`);
/** What is stored for a code: bound to its pending sign-in, so a code cannot be tried against another one. */
export const codeHash = (tokenHash: string, code: string): string => sha256Hex(`device-code:${tokenHash}:${code}`);
export const tokenHashOf = (token: string): string => sha256Hex(token);

export type DeviceGate =
  | { kind: 'pass'; via: string }
  | { kind: 'challenge'; token: string; expiresAt: Date }
  | { kind: 'limited' };

/**
 * The new-device email code (migration 0292, setting security.new_device_code). OFF by default. When it is on, a password-only sign-in from a browser the account has
 * not signed in from needs a 6-digit code mailed to the account's own address. The database enforces it in auth_session_create (a one-minute pass is needed).
 * Never applies to: two-factor accounts, break-glass, System Admins (unless included), accounts without email. If the mail cannot be queued, the sign-in goes
 * through and the System Log says so, so nobody is locked out. A System Admin can also let one account in once (bypass) or turn the feature off.
 */
@Injectable()
export class NewDeviceService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly limiter: RateLimiter,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ admin side
  async getSetting(): Promise<NewDeviceSettingDto> {
    const rows = await this.db.tx.$queryRaw<{ r: Omit<NewDeviceSettingDto, 'mail_ready'> }[]>(Prisma.sql`SELECT new_device_code_state() AS r`);
    return { ...rows[0]!.r, mail_ready: this.mail.enabled };
  }

  async setSetting(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<NewDeviceSettingDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    const wait = this.limiter.hit(`new-device-setting:${auth.user.id}`, SETTING_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    if (b.enabled && !this.mail.enabled) {
      throw new ProblemException(409, 'invalid_transition', { detail: 'Set up the mail server first: the code is sent by email.' });
    }
    const rows = await this.db.tx.$queryRaw<{ r: Omit<NewDeviceSettingDto, 'mail_ready'> }[]>(Prisma.sql`SELECT admin_set_new_device_code(${b.enabled}::boolean,
      ${b.code_minutes}::int, ${b.include_admins}::boolean, ${b.reason}::text, ${etag}::int) AS r`);
    return { ...rows[0]!.r, mail_ready: this.mail.enabled };
  }

  /** POST /settings/new-device-code/bypass: one account may sign in once from any browser for a few minutes (recovery path). */
  async bypass(auth: AuthContext, raw: unknown): Promise<{ until: string }> {
    const b = parse(bypassBody, raw);
    const wait = this.limiter.hit(`new-device-bypass:${auth.user.id}`, BYPASS_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ until: Date }[]>(Prisma.sql`SELECT admin_new_device_bypass(${b.user_id}::uuid, ${b.minutes ?? 30}::int, ${b.reason}::text) AS until`);
    return { until: rows[0]!.until.toISOString() };
  }

  // ------------------------------------------------------------------ sign-in side
  deviceFrom(req: Request): string | undefined {
    const t = parseCookie(req.headers.cookie, DEVICE_COOKIE);
    return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : undefined;
  }

  setDeviceCookie(res: Response, id: string): void {
    res.cookie(DEVICE_COOKIE, id, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'strict', path: DEVICE_COOKIE_PATH, maxAge: DEVICE_COOKIE_MS });
  }

  newDeviceId(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Inside the sign-in transaction, right after the password was accepted for an account without two-factor. Feature off or not applicable: a pass is not needed
   * and nothing happens. Known browser or bypass: a one-minute pass is left. Otherwise a code is made and mailed.
   */
  async gate(userId: string, deviceId: string, ip: string | null, mailText: (code: string, minutes: number) => string): Promise<DeviceGate> {
    const dh = deviceHash(deviceId);
    const rows = await this.db.tx.$queryRaw<{ r: string }[]>(Prisma.sql`SELECT auth_device_check(${userId}::uuid, ${dh}::text, ${this.mail.enabled}::boolean) AS r`);
    const r = rows[0]!.r;
    if (r !== 'challenge') return { kind: 'pass', via: r };
    const token = randomBytes(32).toString('base64url');
    const tokenHash = tokenHashOf(token);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ipValue = ip && isIP(ip) ? ip : null;
    const made = await this.db.tx.$queryRaw<{ until: Date | null }[]>(Prisma.sql`SELECT auth_device_challenge_create(${userId}::uuid, ${tokenHash}::text,
      ${codeHash(tokenHash, code)}::text, ${dh}::text, ${ipValue}::inet) AS until`);
    const until = made[0]!.until;
    if (!until) return { kind: 'limited' };
    const minutes = Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
    await this.db.tx.$executeRaw`SAVEPOINT pmis_device_mail`;
    let queued = false;
    try {
      const id = await this.mail.sendToUser(userId, {
        kind: 'identity.new_device_code',
        subject: 'GSDN Workspace: your sign-in code',
        text: mailText(code, minutes),
        sensitive: true,
      });
      queued = id !== null;
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT pmis_device_mail`;
    } catch {
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT pmis_device_mail`;
    }
    if (!queued) {
      await this.db.tx.$executeRaw(Prisma.sql`SELECT auth_device_mail_failed(${userId}::uuid)`);
      return { kind: 'pass', via: 'no_mail' };
    }
    return { kind: 'challenge', token, expiresAt: until };
  }

  async loadChallenge(token: string | undefined): Promise<{ userId: string } | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const rows = await this.db.client.$queryRaw<{ user_id: string }[]>(Prisma.sql`SELECT user_id::text AS user_id FROM auth_device_challenge_load(${tokenHashOf(token)}::text)`);
    return rows[0] ? { userId: rows[0].user_id } : null;
  }

  /** Inside a transaction whose signed context names the user. ok | bad | locked | expired. */
  async verify(userId: string, token: string, code: string, ip: string | null): Promise<'ok' | 'bad' | 'locked' | 'expired'> {
    const th = tokenHashOf(token);
    const ipValue = ip && isIP(ip) ? ip : null;
    const rows = await this.db.tx.$queryRaw<{ r: 'ok' | 'bad' | 'locked' | 'expired' }[]>(Prisma.sql`SELECT auth_device_challenge_verify(${userId}::uuid, ${th}::text,
      ${codeHash(th, code)}::text, ${ipValue}::inet) AS r`);
    return rows[0]!.r;
  }
}

export const newDeviceMailText = (code: string, minutes: number): string =>
  `Someone signed in to your GSDN Workspace account from a browser it has not seen before.\n\nYour sign-in code is: ${code}\n\nIt works once and expires in ${minutes} minutes. `
  + 'If this was not you, do not share the code and tell a System Admin: your password may be known to someone else.';
