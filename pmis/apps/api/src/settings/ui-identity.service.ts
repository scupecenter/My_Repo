import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { problems } from '../common/problem';
import { DbService } from '../db/db.service';
import { uiPrefsSchema, UiPrefs } from './ui-prefs';

/** The UI designs (owner decision 2026-11-19, migration 0130). `current` is today's look and the default. */
export const UI_BRANDS = ['current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara'] as const;
export type UiBrand = (typeof UI_BRANDS)[number];

const putBody = z.object({
  default_brand: z.enum(UI_BRANDS),
  allow_user_choice: z.boolean(),
  /** 0241: the organization appearance defaults; omitted keeps the current ones. */
  defaults: uiPrefsSchema.optional(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

/** 0243: an identity image (ui_assets). The bytes are served by GET /ui/assets/:key; this is the metadata. */
export interface UiAssetDto {
  key: string;
  mime: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp';
  enabled: boolean;
  version: number;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
}

const logoEnabledBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export const UI_LOGO_MAX_BYTES = 262144;

export interface UiIdentityDto {
  default_brand: UiBrand;
  allow_user_choice: boolean;
  /** 0241: the organization appearance defaults (users without a personal choice see these). */
  defaults: UiPrefs;
  /** 0241: the dimensions and their allowed values (ui_pref_options), so the client builds the pickers from the database. */
  pref_options: Record<string, string[]>;
  brands: UiBrand[];
  /** 0243: the workspace logo (ui_asset_state); null when none was uploaded. */
  logo: UiAssetDto | null;
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
    // Omitted defaults keep the current ones (read through the same state door the GET uses).
    const defaults = b.defaults ?? (await this.get()).defaults;
    return this.one(Prisma.sql`SELECT admin_set_ui_identity(${b.default_brand}::text, ${b.allow_user_choice}::boolean, ${JSON.stringify(defaults)}::jsonb, ${b.reason}::text, ${etag}::int) AS r`);
  }

  private async asset(sql: Prisma.Sql): Promise<UiAssetDto> {
    const rows = await this.db.tx.$queryRaw<{ r: UiAssetDto | null }[]>(sql);
    return rows[0]!.r!;
  }

  /** PUT /settings/identity/logo (0243): upload the workspace logo; an upload always enables it. */
  async putLogo(auth: AuthContext, ifMatch: string | undefined, file: { mimetype: string; buffer: Buffer } | undefined, reason: unknown): Promise<UiAssetDto> {
    if (!file || !file.buffer?.length) throw problems.validation([{ path: '/file', code: 'required', message: 'Choose an image file.' }]);
    const r = z.string().trim().min(3).max(1000).safeParse(reason);
    if (!r.success) throw problems.validation([{ path: '/reason', code: 'invalid', message: 'A reason of 3+ characters is required.' }]);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.asset(Prisma.sql`SELECT admin_put_ui_asset('logo', ${file.mimetype}::text, ${file.buffer}::bytea, ${r.data}::text, ${etag}::int) AS r`);
  }

  /** PATCH /settings/identity/logo (0243): show or hide the logo (hide never delete). */
  async setLogoEnabled(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<UiAssetDto> {
    const b = parse(logoEnabledBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.asset(Prisma.sql`SELECT admin_set_ui_asset_enabled('logo', ${b.enabled}::boolean, ${b.reason}::text, ${etag}::int) AS r`);
  }

  /** GET /ui/assets/:key (0243): the bytes of an enabled identity image. */
  async getAsset(key: string): Promise<{ mime: string; bytes: Buffer; version: number }> {
    const rows = await this.db.tx.$queryRaw<{ mime: string; bytes: Buffer; version: number }[]>`SELECT mime, bytes, version FROM ui_asset_get(${key}::text)`;
    if (!rows[0]) throw problems.notFound();
    return rows[0];
  }
}
