import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const mode = z.enum(['first', 'last']);
const putSchema = z.object({ reason: z.string().trim().min(3).max(1000), default: mode, registers: z.record(z.string().min(1).max(60), mode) }).strict();

interface PolicyJson {
  default: 'first' | 'last';
  registers: Record<string, 'first' | 'last'>;
  updated_at: string | null;
  updated_by: string | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Data > Imports > Duplicate rows in a file (migration 0432): `imports.duplicate_rows`. For a record that is in an upload file twice: "first" (the first row wins, as before) or "last"
 * (the later row wins, the earlier is set aside, listed in the review and the error report, never lost). A default for every register and an override per register.
 * Read by every signed-in user; changed by a System Admin or a delegate of `settings` edit for all regions, with a reason and If-Match, audited by the database.
 */
@Injectable()
export class DuplicateRowsSettingsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: PolicyJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { default: j.default, registers: j.registers, updated_at: j.updated_at, updated_by, version: j.version, can_edit: j.can_edit };
  }

  /** GET /settings/duplicate-rows */
  async get() {
    const r = await this.db.tx.$queryRaw<{ j: PolicyJson }[]>(Prisma.sql`SELECT imp_duplicate_policy_json() AS j`);
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/duplicate-rows */
  async put(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: PolicyJson }[]>(Prisma.sql`SELECT admin_set_imp_duplicate_policy(${b.default}::text, ${JSON.stringify(b.registers)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
