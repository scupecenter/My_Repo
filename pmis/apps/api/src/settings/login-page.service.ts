import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { RateLimiter } from '../auth/rate-limiter';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

/** The system version shown to signed-in users (the post-login splash and the settings screen). Keep in sync with contracts/openapi.yaml info.version. */
export const SYSTEM_VERSION = '0.15.97';

/** A support link under the sign-in form (0185). http(s) or mailto only; the label shows in both languages. */
const supportLink = z.object({
  label_en: z.string().trim().min(1).max(60),
  label_ar: z.string().trim().max(60).default(''),
  url: z.string().trim().min(1).max(300).regex(/^(https?:\/\/|mailto:)/i, 'http(s) or mailto only'),
}).strict();

const putBody = z.object({
  announcement_en: z.string().trim().max(280),
  announcement_ar: z.string().trim().max(280),
  announcement_kind: z.enum(['info', 'maintenance']),
  animation: z.boolean(),
  default_locale: z.enum(['en', 'ar']).nullable(),
  support_links: z.array(supportLink).max(5),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export type SupportLink = z.infer<typeof supportLink>;

export interface LoginPageDto {
  announcement_en: string;
  announcement_ar: string;
  announcement_kind: 'info' | 'maintenance';
  animation: boolean;
  default_locale: 'en' | 'ar' | null;
  support_links: SupportLink[];
  server_version: string;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

/** The public door (0185): ONLY what the signed-out pages render. No version, no audit data, nothing about users. */
export interface LoginPagePublicDto {
  announcement: { en: string; ar: string; kind: 'info' | 'maintenance' } | null;
  animation: boolean;
  default_locale: 'en' | 'ar' | null;
  support_links: SupportLink[];
}

const PUBLIC_LIMIT_PER_IP = 120;
const PUBLIC_WINDOW_MS = 60_000;

/**
 * Settings, Screens, Login page (owner request 2026-11-26, migration 0185, contract 0.15.97): the sign-in page announcement,
 * background animation, default language and support links (setting ui.login_page). Every signed-in user reads the state
 * (the post-login splash shows the version from it); changing it needs a System Admin or a delegate of `settings` edit for
 * all regions, a reason, a step-up and If-Match; the database checks the right again, the version, and writes the audit row
 * (login_page_update, before and after). The public read answers only what the sign-in page shows, rate limited per address.
 */
@Injectable()
export class LoginPageService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly limiter: RateLimiter,
  ) {}

  private async one(sql: Prisma.Sql): Promise<LoginPageDto> {
    const rows = await this.db.tx.$queryRaw<{ r: Omit<LoginPageDto, 'server_version'> }[]>(sql);
    return { ...rows[0]!.r, server_version: SYSTEM_VERSION };
  }

  /** GET /settings/login-page */
  get(): Promise<LoginPageDto> {
    return this.one(Prisma.sql`SELECT login_page_state() AS r`);
  }

  /** PUT /settings/login-page */
  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<LoginPageDto> {
    const { reason, ...body } = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_login_page(${JSON.stringify(body)}::jsonb, ${reason}::text, ${etag}::int) AS r`);
  }

  /** GET /settings/login-page/public (no session): only what the sign-in page renders. */
  async publicConfig(ip: string | null): Promise<LoginPagePublicDto> {
    const wait = this.limiter.hit(`login-page:ip:${ip ?? 'unknown'}`, PUBLIC_LIMIT_PER_IP, PUBLIC_WINDOW_MS);
    if (wait) throw problems.rateLimited(wait);
    const rows = await this.db.tx.$queryRaw<{ r: LoginPagePublicDto }[]>(Prisma.sql`SELECT login_page_public() AS r`);
    return rows[0]!.r;
  }
}
