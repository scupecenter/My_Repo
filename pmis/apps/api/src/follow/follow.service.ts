import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { problems } from '../common/problem';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

export interface FollowDto {
  id: string;
  entity_type: 'site' | 'register_record';
  entity_id: string;
  register_key: string | null;
  site_id: string | null;
  label?: string;
  created_at: string;
}

/** X2: follow a site or a register record. The database checks that the caller can read it; nothing here widens access. */
@Injectable()
export class FollowService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  /** The module of the register (404 for an unknown register, 403 module_forbidden when the caller cannot use it). */
  private async registerModule(auth: AuthContext, key: string): Promise<void> {
    const rows = await this.db.tx.$queryRaw<{ m: string | null }[]>(Prisma.sql`SELECT reg_module(${key}::text) AS m`);
    const mod = rows[0]?.m;
    if (!mod) throw problems.notFound('This register does not exist.');
    await this.access.requireModuleView(auth, mod);
  }

  private async run<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  async followSite(auth: AuthContext, id: string): Promise<FollowDto> {
    await this.access.requireRegions('sites', 'view');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run<FollowDto>(Prisma.sql`SELECT x_follow('site', ${id}::uuid, NULL) AS r`);
  }

  /** Stopping needs no read right: it removes only the caller's own watch, also one the caller can no longer read (a region or module taken away). */
  async unfollowSite(_auth: AuthContext, id: string): Promise<void> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.run<boolean>(Prisma.sql`SELECT x_unfollow('site', ${id}::uuid, NULL) AS r`);
  }

  async followRecord(auth: AuthContext, key: string, id: string): Promise<FollowDto> {
    await this.registerModule(auth, key);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run<FollowDto>(Prisma.sql`SELECT x_follow('register_record', ${id}::uuid, ${key}::text) AS r`);
  }

  async unfollowRecord(_auth: AuthContext, key: string, id: string): Promise<void> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.run<boolean>(Prisma.sql`SELECT x_unfollow('register_record', ${id}::uuid, ${key}::text) AS r`);
  }

  /** What I follow, limited to what I can still read (region security on the tables, then the register's module regions). */
  async mine(auth: AuthContext): Promise<{ items: FollowDto[] }> {
    const rows = await this.db.tx.$queryRaw<(FollowDto & { is_global: boolean | null; region_id: number | null })[]>(Prisma.sql`
      SELECT w.id::text AS id, w.entity_type, w.entity_id::text AS entity_id, w.register_key, w.site_id::text AS site_id, to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        CASE WHEN w.entity_type = 'site' THEN s.site_code || ' ' || s.name ELSE coalesce(rs.site_code || ' / ', '') || d.name_en || ' v' || r.version_no END AS label,
        r.is_global, coalesce(s.region_id, r.region_id) AS region_id
      FROM watches w
      LEFT JOIN sites s ON w.entity_type = 'site' AND s.id = w.entity_id
      LEFT JOIN LATERAL (SELECT x.* FROM register_records x WHERE w.entity_type = 'register_record' AND x.entity_id = w.entity_id ORDER BY x.version_no DESC LIMIT 1) r ON true
      LEFT JOIN register_definitions d ON d.register_key = r.register_key
      LEFT JOIN sites rs ON rs.id = r.site_id
      WHERE w.user_id = ${auth.user.id}::uuid AND (s.id IS NOT NULL OR r.id IS NOT NULL)
      ORDER BY w.created_at DESC, w.id`);
    const sitesRegions = await this.access.regions('sites', 'view');
    const cache = new Map<string, number[] | null>();
    const items: FollowDto[] = [];
    for (const r of rows) {
      let regs: number[] | null;
      if (r.entity_type === 'site') regs = sitesRegions;
      else {
        if (!cache.has(r.register_key as string)) {
          const m = await this.db.tx.$queryRaw<{ m: string | null }[]>(Prisma.sql`SELECT reg_module(${r.register_key}::text) AS m`);
          cache.set(r.register_key as string, m[0]?.m ? await this.access.regions(m[0].m, 'view') : []);
        }
        regs = cache.get(r.register_key as string) ?? [];
      }
      if (regs !== null && (regs.length === 0 || !(r.is_global || (r.region_id !== null && regs.includes(r.region_id))))) continue;
      items.push({ id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, register_key: r.register_key, site_id: r.site_id, label: r.label, created_at: r.created_at });
    }
    return { items };
  }
}
