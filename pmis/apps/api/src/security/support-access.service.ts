import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { DelegationDto, DelegationsService } from '../delegations/delegations.service';
import { parseIfMatch } from '../common/etag';
import { problems, ProblemException } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { grantsFromRights } from '../permissions/catalogue';

/** The delegable rights a support grant may carry (a subset of the catalogue; the database checks the grants again in support_access_check_grant). */
export const SUPPORT_RIGHTS = ['templates.edit', 'fields.edit', 'documents.edit', 'warehouse.items.edit'] as const;
/** A support grant is recognised by this reason prefix (the check functions in migration 0291 require it). */
export const SUPPORT_PREFIX = '[support-access] ';
const GRANTS_PER_MINUTE = 10;

const reason = z.string().trim().min(3).max(900);
const putBody = z.object({ enabled: z.boolean(), max_hours: z.number().int().min(1).max(168), default_hours: z.number().int().min(1).max(168), reason }).strict();
const grantBody = z.object({
  to_user_id: z.guid(),
  rights: z.array(z.enum(SUPPORT_RIGHTS)).min(1).max(SUPPORT_RIGHTS.length),
  hours: z.number().int().min(1).max(168).optional(),
  reason,
}).strict();
const revokeBody = z.object({ reason }).strict();

export interface SupportAccessSettingDto {
  enabled: boolean; max_hours: number; default_hours: number; modules: string[];
  updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; version: number; can_edit: boolean;
}

/**
 * Support access (migration 0291, setting security.support_access): a System Admin lets a named user help with configuration for a short time. It is an
 * ordinary delegation (idm_delegate: time window, revoke, audit) with limits: off by default, a mandatory expiry (at most max_hours), no re-delegation, only the
 * allowlisted rights, never the user who grants. Nothing widens unless an admin grants it; it ends by itself at valid_to.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly delegations: DelegationsService,
    private readonly limiter: RateLimiter,
  ) {}

  async getSetting(): Promise<SupportAccessSettingDto> {
    const rows = await this.db.tx.$queryRaw<{ r: SupportAccessSettingDto }[]>(Prisma.sql`SELECT support_access_state() AS r`);
    return rows[0]!.r;
  }

  async setSetting(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<SupportAccessSettingDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ r: SupportAccessSettingDto }[]>(Prisma.sql`SELECT admin_set_support_access(${b.enabled}::boolean, ${b.max_hours}::int,
      ${b.default_hours}::int, ${b.reason}::text, ${etag}::int) AS r`);
    return rows[0]!.r;
  }

  /** GET /support-access: every support grant, newest first, with its state (active, expired, revoked). System Admin only. */
  async list(): Promise<{ items: DelegationDto[] }> {
    await this.getSetting(); // refuses a caller who is not a System Admin (403 action_forbidden)
    const ids = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT d.id::text AS id FROM delegations d
      WHERE d.reason LIKE ${SUPPORT_PREFIX + '%'} ORDER BY d.created_at DESC, d.id::text DESC LIMIT 200`);
    return { items: await this.delegations.dtos(ids.map((r) => r.id)) };
  }

  /** POST /support-access: grant (step-up, reason, rate limited). The expiry is now + hours (default_hours when omitted). */
  async grant(auth: AuthContext, raw: unknown): Promise<DelegationDto> {
    const b = parse(grantBody, raw);
    const wait = this.limiter.hit(`support-access:${auth.user.id}`, GRANTS_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    const hours = b.hours ?? (await this.getSetting()).default_hours;
    const grants = grantsFromRights(b.rights);
    await this.db.tx.$executeRaw(Prisma.sql`SELECT support_access_check_grant(${b.to_user_id}::uuid, ${JSON.stringify(grants)}::jsonb, ${hours}::int)`);
    const validFrom = new Date();
    const validTo = new Date(validFrom.getTime() + hours * 3_600_000);
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT idm_delegate('user'::"DelegationTarget", ${b.to_user_id}::uuid, NULL::uuid, NULL::uuid,
      false::boolean, ${JSON.stringify(grants)}::jsonb, true::boolean, ARRAY[]::int[], ${validFrom}::timestamptz, ${validTo}::timestamptz, false::boolean, NULL::uuid,
      ${SUPPORT_PREFIX + b.reason}::text)::text AS id`);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return (await this.delegations.dtos([rows[0]!.id]))[0]!;
  }

  async revoke(auth: AuthContext, id: string, raw: unknown): Promise<DelegationDto> {
    const b = parse(revokeBody, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.stepUp.require(auth);
    await this.revokeOne(id, b.reason);
    return (await this.delegations.dtos([id]))[0]!;
  }

  /** POST /support-access/revoke-all: ends every support grant that is still in force. Returns how many. */
  async revokeAll(auth: AuthContext, raw: unknown): Promise<{ revoked: number }> {
    const b = parse(revokeBody, raw);
    await this.stepUp.require(auth);
    await this.getSetting();
    const ids = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT d.id::text AS id FROM delegations d
      WHERE d.reason LIKE ${SUPPORT_PREFIX + '%'} AND NOT d.revoked AND (d.valid_to IS NULL OR d.valid_to > now())`);
    for (const r of ids) await this.revokeOne(r.id, b.reason);
    return { revoked: ids.length };
  }

  private async revokeOne(id: string, why: string): Promise<void> {
    await this.db.tx.$executeRaw(Prisma.sql`SELECT support_access_check_revoke(${id}::uuid)`);
    const cur = await this.db.tx.delegation.findUnique({ where: { id }, select: { revoked: true } });
    if (cur?.revoked) throw new ProblemException(409, 'invalid_transition', { detail: 'The support grant is already revoked.' });
    await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_revoke_delegation(${id}::uuid, ${SUPPORT_PREFIX + why}::text)`);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  }
}
