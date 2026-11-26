import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

/** The UI designs (owner decision 2026-11-19, migration 0130). `current` is today's look and the default. */
export const UI_BRANDS = ['current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara'] as const;
export type UiBrand = (typeof UI_BRANDS)[number];

const putBody = z.object({
  default_brand: z.enum(UI_BRANDS),
  allow_user_choice: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface UiIdentityDto {
  default_brand: UiBrand;
  allow_user_choice: boolean;
  brands: UiBrand[];
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Identity & themes (migration 0130, contract 0.15.41): the organization default design and whether users may choose their own (setting `ui.identity`).
 * Every signed-in user reads it (it drives the UI). Changing it needs a System Admin or a delegate of `settings` edit for all regions, a reason, a step-up and
 * If-Match; the database checks the right again, the version, and writes the audit row (ui_identity_update, before and after).
 */
@Injectable()
export class UiIdentityService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<UiIdentityDto> {
    const rows = await this.db.tx.$queryRaw<{ r: UiIdentityDto }[]>(sql);
    return rows[0]!.r;
  }

  /** GET /settings/identity */
  get(): Promise<UiIdentityDto> {
    return this.one(Prisma.sql`SELECT ui_identity_state() AS r`);
  }

  /** PUT /settings/identity */
  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<UiIdentityDto> {
    const b = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_ui_identity(${b.default_brand}::text, ${b.allow_user_choice}::boolean, ${b.reason}::text, ${etag}::int) AS r`);
  }
}
