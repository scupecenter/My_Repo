import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const code = z.string().trim().min(1).max(60);
const putSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  enabled: z.boolean(),
  chains: z.array(z.array(code).min(2).max(20)).max(10),
  billing_after: code.nullable(),
}).strict();

interface CfgJson {
  enabled: boolean;
  chains: string[][];
  billing_after: string | null;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  fields: { code: string; label_en: string; label_ar: string | null }[];
}

/**
 * Q151 (migration 0063): the order warnings of the GECOL register. Reads need the Settings screen (admin.settings view); the write goes through
 * admin_save_gecol_order_warnings (System Admin or a delegation of admin.settings edit for all regions, reason, If-Match, audited).
 */
@Injectable()
export class GecolOrderWarningsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: CfgJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { enabled: j.enabled, chains: j.chains, billing_after: j.billing_after ?? null, fields: j.fields, version: j.version, updated_at: j.updated_at, updated_by };
  }

  /** GET /settings/gecol-order-warnings */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'admin.settings');
    const r = await this.db.tx.$queryRaw<{ j: CfgJson }[]>`SELECT gecol_order_warnings_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/gecol-order-warnings */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('admin.settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const config = { enabled: b.enabled, chains: b.chains, billing_after: b.billing_after };
    const r = await this.db.tx.$queryRaw<{ j: CfgJson }[]>(Prisma.sql`
      SELECT admin_save_gecol_order_warnings(${JSON.stringify(config)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
