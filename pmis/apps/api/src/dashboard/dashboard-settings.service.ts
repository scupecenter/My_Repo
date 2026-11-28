import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import {
  dashboardSettingsPutSchema,
  healthBandsPutSchema,
} from "./dashboard-settings.schema";

interface SettingsJson {
  version: number;
  targets: { sites_per_batch: number | null; monthly_on_air: number | null };
  thresholds: Record<string, { green: number; amber: number }>;
  tabs: Record<string, { order: string[]; hidden: string[] }>;
  stale_idle_days: number;
  updated_at: string | null;
  updated_by: string | null;
  catalogue: unknown;
}

interface HealthBandsJson {
  green: number;
  amber: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * F20 (contract 0.15.24): the global dashboard settings (targets, KPI thresholds, cards per tab). Reads need dashboard.view, so every dashboard reader
 * gets the thresholds. The write goes through admin_save_dashboard_settings (admin.settings edit for all regions, reason, If-Match, audited); the
 * database checks the validation rules again, so a delegate gets exactly what was delegated.
 */
@Injectable()
export class DashboardSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async dto(j: SettingsJson) {
    let updated_by: {
      id: string;
      display_name: string;
      employee_id: string | null;
    } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<
        { display_name: string; employee_id: string | null }[]
      >`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = {
        id: j.updated_by,
        display_name: u[0]?.display_name ?? "",
        employee_id: u[0]?.employee_id?.trim() ?? null,
      };
    }
    return {
      version: j.version,
      targets: j.targets,
      thresholds: j.thresholds,
      tabs: j.tabs,
      stale_idle_days: j.stale_idle_days,
      catalogue: j.catalogue,
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/dashboard */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: SettingsJson }[]
    >`SELECT dashboard_settings_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/dashboard */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(dashboardSettingsPutSchema, raw);
    const config = {
      targets: b.targets,
      thresholds: b.thresholds,
      tabs: b.tabs,
      // absent = the stored value (the database keeps it)
      ...(b.stale_idle_days !== undefined
        ? { stale_idle_days: b.stale_idle_days }
        : {}),
    };
    const r = await this.db.tx.$queryRaw<{ j: SettingsJson }[]>(Prisma.sql`
      SELECT admin_save_dashboard_settings(${JSON.stringify(config)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }

  private async bandsDto(j: HealthBandsJson) {
    let updated_by: {
      id: string;
      display_name: string;
      employee_id: string | null;
    } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<
        { display_name: string; employee_id: string | null }[]
      >`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = {
        id: j.updated_by,
        display_name: u[0]?.display_name ?? "",
        employee_id: u[0]?.employee_id?.trim() ?? null,
      };
    }
    return {
      version: j.version,
      green: j.green,
      amber: j.amber,
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/dashboard/health-bands (0.15.435) */
  async getHealthBands(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: HealthBandsJson }[]
    >`SELECT health_bands_json() AS j`;
    return this.bandsDto(r[0]!.j);
  }

  /** PUT /settings/dashboard/health-bands (0.15.435) */
  async putHealthBands(
    _auth: AuthContext,
    ifMatch: string | undefined,
    raw: unknown,
  ) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(healthBandsPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: HealthBandsJson }[]>(Prisma.sql`
      SELECT admin_save_health_bands(${b.green}::int, ${b.amber}::int, ${b.reason}::text, ${version}::int) AS j`);
    return this.bandsDto(r[0]!.j);
  }
}
