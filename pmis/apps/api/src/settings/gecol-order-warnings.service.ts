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
const putRegSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  enabled: z.boolean(),
  chains: z.array(z.array(code).min(2).max(20)).max(10),
  billing_after: code.nullable(),
  billing_field: code.nullable(),
}).strict();
const regKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/);

interface CfgJson {
  register_key?: string;
  billing_field?: string | null;
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

  private async regDto(j: CfgJson) {
    const base = await this.dto(j);
    return { register_key: j.register_key as string, ...base, billing_field: j.billing_field ?? null };
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

  /** GET /settings/registers/{key}/order-warnings (M1, 0.15.464): the order warnings of any register; GECOL reads its old setting. */
  async getFor(auth: AuthContext, key: string) {
    await this.access.requireModuleView(auth, 'admin.settings');
    const k = parse(regKey, key);
    const r = await this.db.tx.$queryRaw<{ j: CfgJson }[]>`SELECT register_order_warnings_json(${k}::text) AS j`;
    return this.regDto(r[0]!.j);
  }

  /** PUT /settings/registers/{key}/order-warnings: the same writer for every register (reason, If-Match, audited in the database). */
  async putFor(_auth: AuthContext, key: string, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('admin.settings', 'edit');
    const k = parse(regKey, key);
    const version = parseIfMatch(ifMatch);
    const b = parse(putRegSchema, raw);
    const config = { enabled: b.enabled, chains: b.chains, billing_after: b.billing_after, billing_field: b.billing_field };
    const r = await this.db.tx.$queryRaw<{ j: CfgJson }[]>(Prisma.sql`
      SELECT admin_save_register_order_warnings(${k}::text, ${JSON.stringify(config)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.regDto(r[0]!.j);
  }

  /** GET /settings/register-counts (M1): read only counts of every register, the latest version of each logical record. */
  async counts(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'admin.settings');
    const rows = await this.db.tx.$queryRaw<{ register_key: string; state: string | null; n: number; versions: number }[]>`
      WITH l AS (SELECT DISTINCT ON (entity_id) entity_id, register_key, state FROM register_records ORDER BY entity_id, version_no DESC),
           v AS (SELECT register_key, count(*)::int AS versions FROM register_records GROUP BY register_key),
           c AS (SELECT register_key, state, count(*)::int AS n FROM l GROUP BY register_key, state)
      SELECT k.register_key, c.state, coalesce(c.n, 0)::int AS n, coalesce(v.versions, 0)::int AS versions
      FROM (SELECT DISTINCT register_key FROM register_fields) k LEFT JOIN c ON c.register_key = k.register_key LEFT JOIN v ON v.register_key = k.register_key
      ORDER BY k.register_key, c.state`;
    const by = new Map<string, { register_key: string; total: number; versions: number; by_state: { state: string; count: number }[] }>();
    for (const r of rows) {
      const e = by.get(r.register_key) ?? { register_key: r.register_key, total: 0, versions: r.versions, by_state: [] };
      if (r.state) { e.by_state.push({ state: r.state, count: r.n }); e.total += r.n; }
      by.set(r.register_key, e);
    }
    return { as_of: new Date().toISOString(), registers: [...by.values()] };
  }
}
