import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const code = z.string().trim().min(1).max(60);
const rule = z.object({
  key: code,
  enabled: z.boolean(),
  target_register: code,
  output: code,
  source_register: code,
  source: code,
  link_field: code.nullable(),
}).strict();
const putSchema = z.object({ reason: z.string().trim().min(3).max(1000), rules: z.array(rule).max(60) }).strict();

interface CfgJson {
  rules: unknown[];
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  registers: { register_key: string; fields: { code: string; label_en: string; label_ar: string | null }[] }[];
}

/**
 * Migration 0363: the cross-register derive rules (setting derive.rules). Reads need the Settings screen (admin.settings view); the write goes through
 * admin_save_derive_rules (System Admin or a delegation of admin.settings edit for all regions, reason, If-Match, validated, audited). The values themselves are
 * read by derive_values() inside the register reads; this service only edits the rules.
 */
@Injectable()
export class DeriveRulesService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: CfgJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { rules: j.rules, registers: j.registers, version: j.version, updated_at: j.updated_at, updated_by };
  }

  /** GET /settings/derive-rules */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'admin.settings');
    const r = await this.db.tx.$queryRaw<{ j: CfgJson }[]>`SELECT derive_rules_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/derive-rules */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('admin.settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: CfgJson }[]>(Prisma.sql`
      SELECT admin_save_derive_rules(${JSON.stringify({ rules: b.rules })}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
