import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putSchema = z.object({ reason: z.string().trim().min(3).max(1000), enabled: z.boolean(), days: z.number().int().min(1).max(365) }).strict();

interface NoticeJson {
  enabled: boolean;
  days: number;
  default_days: number;
  min: number;
  max: number;
  updated_at: string | null;
  updated_by: string | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Imports > Template change notice (migration 0367, contract 0.15.203): `templates.change_notice` (P3, migration 0367): whether the notice of a new template version is written, and for how many days.
 * Read by every signed-in user; changed by a System Admin or a delegate of `settings` edit for all regions, with a reason and If-Match, audited by the database
 * (admin_set_imports_async_rows, the rule of the calendar confirmation of 0072).
 */
@Injectable()
export class TemplateNoticeSettingsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: NoticeJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>(Prisma.sql`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`);
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { enabled: j.enabled, days: j.days, default_days: j.default_days, min: j.min, max: j.max, updated_at: j.updated_at, updated_by, version: j.version, can_edit: j.can_edit };
  }

  /** GET /settings/imports */
  async get() {
    const r = await this.db.tx.$queryRaw<{ j: NoticeJson }[]>(Prisma.sql`SELECT template_change_notice_json() AS j`);
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/imports */
  async put(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: NoticeJson }[]>(Prisma.sql`SELECT admin_set_template_change_notice(${b.enabled}::boolean, ${b.days}::int, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
