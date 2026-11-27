import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

type Json = Record<string, unknown>;

const reason = z.string().trim().min(3).max(500);
const PARAM_KEYS = ['ref_date', 'region_id', 'cluster_code', 'scenario', 'stream', 'view', 'exclude_overrides'] as const;
const createBody = z
  .object({
    label: z.string().trim().max(120).optional(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    days: z.number().int().min(1).max(365).optional(),
    reason,
  })
  .strict();
const revokeBody = z.object({ reason }).strict();

/**
 * Dashboard share links (owner decision 2026-11-26 00:51, migration 0546): a durable, revocable link to a read-only
 * dashboard view. The link is an envelope for the dashboard query only; opening it needs a session and the data comes
 * from the normal GET /dashboard of the opener, so role and region visibility are always the opener's own. Every write
 * and every open goes through a definer door that checks the right and audits.
 */
@Injectable()
export class DashboardSharesService {
  constructor(private readonly db: DbService) {}

  private async door(sql: Prisma.Sql): Promise<Json> {
    await this.db.tx.$executeRaw`SAVEPOINT dash_share`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Json | null }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT dash_share`;
      return rows[0]?.r ?? {};
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT dash_share`;
      throw p;
    }
  }

  /** The caller's links; a System Admin sees every link (the door scopes by app_actor). */
  async list(): Promise<Json> {
    const rows = await this.db.tx.$queryRaw<Json[]>(Prisma.sql`
      SELECT s.id, s.label, s.params, s.created_at, s.expires_at, s.revoked_at, s.open_count, s.last_opened_at,
             u.display_name AS created_by_name,
             (s.created_by = app_actor()) AS mine
        FROM dashboard_share_links s JOIN users u ON u.id = s.created_by
       WHERE s.created_by = app_actor() OR app_actor_is_system_admin()
       ORDER BY s.created_at DESC LIMIT 200`);
    return { items: rows };
  }

  async create(auth: AuthContext, raw: unknown): Promise<Json> {
    const b = parse(createBody, raw);
    // only the GET /dashboard parameters ride a link; everything is stringified for the URL of the shared view
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.params)) {
      if (!(PARAM_KEYS as readonly string[]).includes(k)) throw problems.validation([{ path: `/params/${k}`, code: 'invalid', message: 'Only the dashboard query parameters can be shared.' }]);
      params[k] = String(v);
    }
    const token = randomBytes(24).toString('base64url'); // 32 characters, URL-safe
    const payload = { token, label: b.label ?? '', params, days: b.days ?? 30 };
    const r = await this.door(Prisma.sql`SELECT dashboard_share_create(${JSON.stringify(payload)}::jsonb, ${b.reason}::text) AS r`);
    return { ...r, path: `/dashboard/shared/${token}` };
  }

  async revoke(auth: AuthContext, id: string, raw: unknown): Promise<Json> {
    const b = parse(revokeBody, raw);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw problems.notFound();
    return this.door(Prisma.sql`SELECT dashboard_share_revoke(${id}::uuid, ${b.reason}::text) AS r`);
  }

  /** Opening a link: the envelope (label + query) for the shared view; the data itself is the opener's GET /dashboard. */
  async resolve(auth: AuthContext, token: string): Promise<Json> {
    if (token.length < 20 || token.length > 64 || !/^[\w-]+$/.test(token)) throw problems.notFound();
    return this.door(Prisma.sql`SELECT dashboard_share_resolve(${token}::text) AS r`);
  }
}
