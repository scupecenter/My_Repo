import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import { forecastWindowPutSchema } from "./forecast-window.schema";

interface WeeksJson {
  weeks: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Settings review gap 4 (contract 0.15.431): the number of weeks the dashboard forecast averages the weekly gain over (setting dashboard.forecast_window_weeks, 2 to 12,
 * default 4). Reads need dashboard.view. The write goes through admin_save_forecast_window (admin.settings edit for all regions, reason, If-Match, audited).
 * The forecast is computed when the card is drawn; no forecast and no snapshot is stored or rewritten.
 */
@Injectable()
export class ForecastWindowService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async dto(j: WeeksJson) {
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
      weeks: j.weeks,
      updated_at: j.updated_at,
      updated_by,
    };
  }

  /** GET /settings/dashboard/forecast-window */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.db.tx.$queryRaw<
      { j: WeeksJson }[]
    >`SELECT forecast_window_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/dashboard/forecast-window */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin("admin.settings", "edit");
    const version = parseIfMatch(ifMatch);
    const b = parse(forecastWindowPutSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: WeeksJson }[]>(Prisma.sql`
      SELECT admin_save_forecast_window(${b.weeks}::int, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
