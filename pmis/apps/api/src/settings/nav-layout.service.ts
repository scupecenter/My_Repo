import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

// The shape of the tree is checked by the database (admin_set_nav_layout, field errors under /layout); here only the envelope.
const putSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  layout: z.union([z.null(), z.record(z.string(), z.unknown())]),
}).strict();

interface NavLayoutJson {
  layout: unknown;
  is_default: boolean;
  catalogue: string[];
  updated_at: string | null;
  updated_by: string | null;
  version: number;
  can_edit: boolean;
}

/**
 * The shared layout of the side menu (migration 0081, contract 0.15.1): `nav.layout`. Read by every signed-in user; changed by a System Admin or a delegate of
 * `settings` edit for all regions, with a reason and If-Match, validated and audited by the database (admin_set_nav_layout: nav_layout_update / nav_layout_reset).
 */
@Injectable()
export class NavLayoutService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: NavLayoutJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { layout: j.layout ?? null, is_default: j.is_default, catalogue: j.catalogue, updated_at: j.updated_at, updated_by, version: j.version, can_edit: j.can_edit };
  }

  /** GET /settings/nav-layout */
  async get() {
    const r = await this.db.tx.$queryRaw<{ j: NavLayoutJson }[]>(Prisma.sql`SELECT nav_layout_json() AS j`);
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/nav-layout (layout null: back to the default of the code) */
  async put(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const layout = b.layout === null ? null : JSON.stringify(b.layout);
    const r = await this.db.tx.$queryRaw<{ j: NavLayoutJson }[]>(Prisma.sql`SELECT admin_set_nav_layout(${layout}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
