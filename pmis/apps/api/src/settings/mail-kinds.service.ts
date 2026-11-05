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

const reason = z.string().trim().min(3).max(1000);
// The shape is checked here; the catalogue, the reserved kinds and the duplicates are checked by the database (admin_save_mail_kinds), which answers field errors per index.
const putSchema = z.object({ reason, kinds: z.array(z.string().max(60)).max(100) }).strict();

interface KindsJson {
  kinds: string[];
  unknown_kinds: string[];
  catalogue: { kind: string; recommended: boolean }[];
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Q441 (migration 0072, contract 0.14.2): the notification kinds that are also sent by mail (setting `mail.notification_kinds`). System Admin only, for the reading
 * and for the writing; the write needs a reason, step-up and If-Match, refuses unknown and reserved kinds, and is audited (admin_save_mail_kinds).
 */
@Injectable()
export class MailKindsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async dto(j: KindsJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { kinds: j.kinds, unknown_kinds: j.unknown_kinds, catalogue: j.catalogue, version: j.version, updated_at: j.updated_at, updated_by };
  }

  private async requireSystemAdmin(): Promise<void> {
    if (!(await this.access.isSystemAdmin())) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin sets the mail notification kinds.' });
  }

  /** GET /settings/mail-notification-kinds */
  async get() {
    await this.requireSystemAdmin();
    const r = await this.db.tx.$queryRaw<{ j: KindsJson }[]>(Prisma.sql`SELECT mail_kinds_json() AS j`);
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/mail-notification-kinds */
  async put(auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.requireSystemAdmin();
    await this.stepUp.require(auth);
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: KindsJson }[]>(Prisma.sql`
      SELECT admin_save_mail_kinds(${JSON.stringify(b.kinds)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
