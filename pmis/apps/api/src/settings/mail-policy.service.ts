import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const kindCfg = z.object({ enabled: z.boolean(), mode: z.enum(['inherit', 'internal_only', 'internal_external']) }).strict();
// the shape is checked here; the kinds, the domains and the modes are checked again by the database (admin_save_mail_policy) with field errors
const putSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  enabled: z.boolean(),
  mode: z.enum(['internal_only', 'internal_external']),
  internal_domains: z.array(z.string().trim().toLowerCase().max(253)).max(50),
  kinds: z.record(z.string().max(60), kindCfg),
}).strict();

interface PolicyJson {
  enabled: boolean;
  mode: string;
  internal_domains: string[];
  kinds: Record<string, unknown>;
  catalogue: { kind: string; recommended: boolean }[];
  block_public_sharing: boolean;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Migration 0364: the mail policy (setting mail.policy). System Admin only, like the mail kinds; the write needs a reason, step-up and If-Match, and is audited
 * (admin_save_mail_policy). The check itself runs in mail_enqueue_internal, the one door of every mail.
 */
@Injectable()
export class MailPolicyService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async dto(j: PolicyJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { enabled: j.enabled, mode: j.mode, internal_domains: j.internal_domains, kinds: j.kinds, catalogue: j.catalogue, block_public_sharing: j.block_public_sharing, version: j.version, updated_at: j.updated_at, updated_by };
  }

  private async requireSystemAdmin(): Promise<void> {
    if (!(await this.access.isSystemAdmin())) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin sets the mail policy.' });
  }

  /** GET /settings/mail-policy */
  async get() {
    await this.requireSystemAdmin();
    const r = await this.db.tx.$queryRaw<{ j: PolicyJson }[]>(Prisma.sql`SELECT mail_policy_json() AS j`);
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/mail-policy */
  async put(auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.requireSystemAdmin();
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const cfg = { enabled: b.enabled, mode: b.mode, internal_domains: b.internal_domains, kinds: b.kinds };
    const r = await this.db.tx.$queryRaw<{ j: PolicyJson }[]>(Prisma.sql`
      SELECT admin_save_mail_policy(${JSON.stringify(cfg)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
