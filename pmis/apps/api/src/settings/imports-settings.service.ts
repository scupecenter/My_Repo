import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putSchema = z.object({ reason: z.string().trim().min(3).max(1000), async_rows: z.number().int().min(10).max(500) }).strict();

const policySchema = z.object({ reason: z.string().trim().min(3).max(1000), policy: z.enum(['enforce', 'accept_incomplete']) }).strict();

interface PolicyJson {
  policy: 'enforce' | 'accept_incomplete';
  default_policy: string;
  policies: string[];
  updated_at: string | null;
  updated_by: string | null;
  version: number;
  can_edit: boolean;
}

interface ImportsJson {
  async_rows: number;
  default_async_rows: number;
  min: number;
  max: number;
  updated_at: string | null;
  updated_by: string | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Imports (migration 0075, contract 0.14.6): `imports.async_rows`, the number of rows above which a send or a decision of a batch runs in the background.
 * Read by every signed-in user; changed by a System Admin or a delegate of `settings` edit for all regions, with a reason and If-Match, audited by the database
 * (admin_set_imports_async_rows, the rule of the calendar confirmation of 0072).
 */
@Injectable()
export class ImportsSettingsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async who(id: string | null) {
    if (!id) return null;
    const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${id}::uuid`);
    return { id, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
  }

  private async policyDto(j: PolicyJson) {
    return { policy: j.policy, default_policy: j.default_policy, policies: j.policies, updated_at: j.updated_at, updated_by: await this.who(j.updated_by), version: j.version, can_edit: j.can_edit };
  }

  /** GET /settings/imports/upload-policy */
  async getPolicy() {
    const r = await this.db.tx.$queryRaw<{ j: PolicyJson }[]>(Prisma.sql`SELECT imports_upload_policy_json() AS j`);
    return this.policyDto(r[0]!.j);
  }

  /** PUT /settings/imports/upload-policy (D49 part 3, migration 0492) */
  async putPolicy(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(policySchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: PolicyJson }[]>(Prisma.sql`SELECT admin_set_imports_upload_policy(${b.policy}::text, ${b.reason}::text, ${version}::int) AS j`);
    return this.policyDto(r[0]!.j);
  }

  private async dto(j: ImportsJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { async_rows: j.async_rows, default_async_rows: j.default_async_rows, min: j.min, max: j.max, updated_at: j.updated_at, updated_by, version: j.version, can_edit: j.can_edit };
  }

  /** GET /settings/imports */
  async get() {
    const r = await this.db.tx.$queryRaw<{ j: ImportsJson }[]>(Prisma.sql`SELECT imports_async_json() AS j`);
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/imports */
  async put(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: ImportsJson }[]>(Prisma.sql`SELECT admin_set_imports_async_rows(${b.async_rows}::int, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
