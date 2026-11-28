import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putSchema = z.object({ reason: z.string().trim().min(3).max(1000), enabled: z.boolean() }).strict();

interface PartialCreditJson {
  enabled: boolean;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Migration 0543: partial credit for in-progress tasks (setting progress.partial_credit, off by default). A task that is applicable but not yet approved earns
 * current_level/levels_required of its item fraction in the project-status calculation. System Admin only; the write needs a reason and If-Match and is audited.
 */
@Injectable()
export class PartialCreditService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: PartialCreditJson | null) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j?.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { enabled: j?.enabled ?? false, version: j?.version ?? 0, updated_at: j?.updated_at ?? null, updated_by };
  }

  private async requireSystemAdmin(): Promise<void> {
    if (!(await this.access.isSystemAdmin())) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin sets partial credit.' });
  }

  /** GET /settings/partial-credit */
  async get() {
    await this.requireSystemAdmin();
    const r = await this.db.tx.$queryRaw<{ j: PartialCreditJson | null }[]>(Prisma.sql`SELECT progress_partial_credit_json() AS j`);
    return this.dto(r[0]?.j ?? null);
  }

  /** PUT /settings/partial-credit */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.requireSystemAdmin();
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: PartialCreditJson }[]>(Prisma.sql`
      SELECT admin_save_progress_partial_credit(${b.enabled}::boolean, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
