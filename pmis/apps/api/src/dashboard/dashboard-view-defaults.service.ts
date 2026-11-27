import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { StepUpService } from "../auth/step-up.service";
import { parseIfMatch } from "../common/etag";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";

const putBody = z
  .object({
    export_format: z.enum(["xlsx", "csv"]),
    collapse: z.enum(["open", "closed"]),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export interface DashboardViewDefaultsDto {
  export_format: "xlsx" | "csv";
  collapse: "open" | "closed";
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Dashboard: the server-wide view defaults (migration 0510, contract 0.15.208, setting dashboard.view_defaults): the default export
 * format and the default collapse state of the dashboard sections. Every signed-in user reads it; a user's own remembered choice overrides it.
 * Changing it needs a System Admin or an all-regions delegate of settings edit, a reason, a step-up and If-Match; the database checks the right
 * again, the version, and writes the audit row.
 */
@Injectable()
export class DashboardViewDefaultsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  private async one(sql: Prisma.Sql): Promise<DashboardViewDefaultsDto> {
    const rows = await this.db.tx.$queryRaw<{ r: DashboardViewDefaultsDto }[]>(sql);
    return rows[0]!.r;
  }

  /** GET /settings/dashboard-view-defaults */
  get(): Promise<DashboardViewDefaultsDto> {
    return this.one(Prisma.sql`SELECT dashboard_view_defaults_state() AS r`);
  }

  /** PUT /settings/dashboard-view-defaults */
  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<DashboardViewDefaultsDto> {
    const b = parse(putBody, raw);
    await this.access.requireAdmin("settings", "edit");
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(
      Prisma.sql`SELECT admin_set_dashboard_view_defaults(${b.export_format}::text, ${b.collapse}::text, ${b.reason}::text, ${etag}::int) AS r`,
    );
  }
}
