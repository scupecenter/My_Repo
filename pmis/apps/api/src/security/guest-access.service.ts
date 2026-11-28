import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { UserStateService } from '../auth/user-state.service';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { UsersService } from '../users/users.service';

const GUESTS_PER_MINUTE = 10;
const reason = z.string().trim().min(3).max(900);
const putBody = z.object({ enabled: z.boolean(), max_days: z.number().int().min(1).max(365), default_days: z.number().int().min(1).max(365), reason }).strict();
const createBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  display_name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).optional(),
  regions: z.array(z.number().int().min(1)).min(1).max(100),
  modules: z.array(z.string().regex(/^[a-z_]{1,40}$/)).min(1).max(40),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  days: z.number().int().min(1).max(365).optional(),
  temporary_password: z.string().max(1024).optional(),
  reason,
}).strict();
const expiryBody = z.object({ expires_at: z.iso.datetime({ offset: true }), reason }).strict();
const endBody = z.object({ reason }).strict();

export interface GuestAccessSettingDto {
  enabled: boolean; max_days: number; default_days: number; modules: string[];
  updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; version: number; can_edit: boolean;
}
export interface GuestDto {
  user_id: string; display_name: string; email: string; note: string | null; expires_at: string; created_at: string;
  created_by: { id: string; display_name: string; employee_id: string | null } | null; ended_at: string | null; end_reason: string | null;
  state: 'active' | 'expired' | 'ended'; regions: number[]; modules: string[];
}

/**
 * Guest access (migration 0731, setting security.guest_access): a System Admin creates a view-only account with an end date. The account is an ordinary local
 * user with one ordinary assignment (role GUEST, profile guest_view); the database guards keep it that way, and the session guard (auth/guest-routes.ts)
 * keeps it read-only. Off by default; every door needs a System Admin, a reason and a fresh step-up.
 */
@Injectable()
export class GuestAccessService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly users: UsersService,
    private readonly states: UserStateService,
    private readonly limiter: RateLimiter,
  ) {}

  async getSetting(): Promise<GuestAccessSettingDto> {
    const rows = await this.db.tx.$queryRaw<{ r: GuestAccessSettingDto }[]>(Prisma.sql`SELECT guest_access_state() AS r`);
    return rows[0]!.r;
  }

  async setSetting(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<GuestAccessSettingDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ r: GuestAccessSettingDto }[]>(Prisma.sql`SELECT admin_set_guest_access(${b.enabled}::boolean, ${b.max_days}::int,
      ${b.default_days}::int, ${b.reason}::text, ${etag}::int) AS r`);
    return rows[0]!.r;
  }

  async list(): Promise<{ items: GuestDto[] }> {
    const rows = await this.db.tx.$queryRaw<{ r: { items: GuestDto[] } }[]>(Prisma.sql`SELECT guest_access_list() AS r`);
    return rows[0]!.r;
  }

  /** POST /guests: creates the local account (temporary password returned once) and makes it a guest in the same transaction. */
  async create(auth: AuthContext, raw: unknown): Promise<{ guest: GuestDto; temporary_password: string }> {
    const b = parse(createBody, raw);
    const wait = this.limiter.hit(`guest-access:${auth.user.id}`, GUESTS_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    const cfg = await this.getSetting(); // refuses a caller who is not a System Admin
    const expires = b.expires_at ? new Date(b.expires_at) : new Date(Date.now() + (b.days ?? cfg.default_days) * 86_400_000);
    // The same checks run again in admin_create_guest (switch on, end date within max_days, allow-listed modules). Check the switch first so a refused request creates no account.
    if (!cfg.enabled) {
      await this.db.tx.$executeRaw(Prisma.sql`SELECT admin_create_guest(NULL::uuid, ${expires}::timestamptz, ARRAY[]::int[], ARRAY[]::text[], NULL::text, ${b.reason}::text)`);
    }
    const created = await this.users.create({ email: b.email, display_name: b.display_name, temporary_password: b.temporary_password, reason: `[guest] ${b.reason}` });
    const rows = await this.db.tx.$queryRaw<{ r: GuestDto }[]>(Prisma.sql`SELECT admin_create_guest(${created.user.id}::uuid, ${expires}::timestamptz,
      ${b.regions}::int[], ${b.modules}::text[], ${b.note ?? null}::text, ${b.reason}::text) AS r`);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(created.user.id);
    return { guest: rows[0]!.r, temporary_password: created.temporary_password };
  }

  async extend(auth: AuthContext, id: string, raw: unknown): Promise<GuestDto> {
    const b = parse(expiryBody, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ r: GuestDto }[]>(Prisma.sql`SELECT admin_extend_guest(${id}::uuid, ${new Date(b.expires_at)}::timestamptz, ${b.reason}::text) AS r`);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(id);
    return rows[0]!.r;
  }

  async end(auth: AuthContext, id: string, raw: unknown): Promise<GuestDto> {
    const b = parse(endBody, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ r: GuestDto }[]>(Prisma.sql`SELECT admin_end_guest(${id}::uuid, ${b.reason}::text) AS r`);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    this.states.invalidate(id);
    return rows[0]!.r;
  }
}
