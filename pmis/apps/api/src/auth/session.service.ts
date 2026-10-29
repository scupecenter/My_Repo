import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import type { AuthMethod, SessionRow, UserRow, UserStatus } from './auth.types';

export const COOKIE_NAME = 'pmis_session';
export const IDLE_HOURS = 8;
export const ABSOLUTE_HOURS = 12;

interface LoadedRow {
  id: string;
  auth_method: AuthMethod;
  csrf_token: string;
  created_at: Date;
  last_activity_at: Date;
  expires_at: Date;
  stepup_at: Date | null;
  db_now: Date;
  valid: boolean;
  user_id: string;
  user_status: UserStatus;
  email: string;
  display_name: string;
  employee_id: string | null;
  phone: string | null;
  locale: string;
  theme: string;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Sessions in user_sessions (ADR 0012 section 4). The cookie holds a random 32-byte token; only its SHA-256 is stored.
 * Idle limit 8 h (sliding), absolute limit 12 h; revoking sets revoked_at, rows are never deleted.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, method: AuthMethod, ip: string | null, userAgent: string | undefined): Promise<{ token: string; csrf: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const ipValue = ip && isIP(ip) ? ip : null;
    const ua = userAgent ? userAgent.slice(0, 400) : null;
    // auth_session_create (migration 0014) checks the account and the recent password check, and sets the 12-hour limit.
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT auth_session_create(${userId}::uuid, ${sha256Hex(token)}, ${method}::"AuthMethod", ${csrf}, ${ipValue}::inet, ${ua})::text AS id`);
    return { token, csrf, id: rows[0]!.id };
  }

  /** Finds the live session behind a cookie token, with its user. Null when unknown, revoked or past a limit. */
  async load(token: string): Promise<{ session: SessionRow; user: UserRow } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const rows = await this.db.client.$queryRaw<LoadedRow[]>(Prisma.sql`
      SELECT s.id::text AS id, s.auth_method::text AS auth_method, s.csrf_token, s.created_at, s.last_activity_at, s.expires_at,
             s.stepup_at, now() AS db_now,
             (s.revoked_at IS NULL AND s.expires_at > now() AND s.last_activity_at > now() - make_interval(hours => ${IDLE_HOURS}::int)) AS valid,
             u.id::text AS user_id, u.status::text AS user_status, u.email, u.display_name, u.employee_id, u.phone, u.locale, u.theme
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${sha256Hex(token)}`);
    const r = rows[0];
    if (!r || !r.valid) return null;
    return {
      session: {
        id: r.id, authMethod: r.auth_method, csrfToken: r.csrf_token, createdAt: r.created_at, lastActivityAt: r.last_activity_at,
        expiresAt: r.expires_at, stepupAt: r.stepup_at, dbNow: r.db_now,
      },
      user: {
        id: r.user_id, email: r.email, displayName: r.display_name, employeeId: r.employee_id?.trim() || null, phone: r.phone,
        status: r.user_status, locale: r.locale, theme: r.theme,
      },
    };
  }

  /** Real user activity slides the idle window. Timer polling (X-PMIS-Live: 1) never calls this. */
  async touch(id: string): Promise<void> {
    await this.db.client.$executeRaw`UPDATE user_sessions SET last_activity_at = now() WHERE id = ${id}::uuid AND revoked_at IS NULL`;
  }

  async markStepUp(id: string): Promise<Date> {
    const rows = await this.db.tx.$queryRaw<{ stepup_at: Date }[]>`UPDATE user_sessions SET stepup_at = now() WHERE id = ${id}::uuid RETURNING stepup_at`;
    return rows[0]!.stepup_at;
  }

  async revoke(id: string, by: string | null, reason: string): Promise<void> {
    await this.db.tx.$executeRaw`UPDATE user_sessions SET revoked_at = now(), revoked_by = ${by}::uuid, revoke_reason = ${reason}
      WHERE id = ${id}::uuid AND revoked_at IS NULL`;
  }

  /** Ends the user's other sessions (password change). Returns how many ended. */
  async revokeOthers(userId: string, keepId: string, by: string | null, reason: string): Promise<number> {
    return this.db.tx.$executeRaw`UPDATE user_sessions SET revoked_at = now(), revoked_by = ${by}::uuid, revoke_reason = ${reason}
      WHERE user_id = ${userId}::uuid AND id <> ${keepId}::uuid AND revoked_at IS NULL`;
  }

  async revokeAll(userId: string, by: string | null, reason: string): Promise<number> {
    return this.db.tx.$executeRaw`UPDATE user_sessions SET revoked_at = now(), revoked_by = ${by}::uuid, revoke_reason = ${reason}
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`;
  }

  csrfOk(session: SessionRow, req: Request): boolean {
    const sent = req.header('x-csrf-token');
    return !!sent && safeEqual(sent, session.csrfToken);
  }

  setCookie(res: Response, token: string): void {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: '/api',
      maxAge: ABSOLUTE_HOURS * 3600 * 1000,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'strict', path: '/api' });
  }
}
