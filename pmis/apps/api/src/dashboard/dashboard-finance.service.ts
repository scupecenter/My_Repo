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
    enabled: z.boolean(),
    role_codes: z.array(z.string().min(1).max(60)).max(60),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export interface DashboardFinanceReadersDto {
  enabled: boolean;
  role_codes: string[];
  roles: { code: string; name_en: string; name_ar: string | null }[];
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Dashboard: who sees the restricted financial summary card (migration 0307, contract 0.15.206, setting
 * dashboard.finance_readers). Every signed-in user reads it. Changing it needs a System Admin or an all-regions delegate of
 * settings edit, a reason, a step-up and If-Match; the database checks the right again, the version, and writes the audit row.
 */
@Injectable()
export class DashboardFinanceService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  private async one(sql: Prisma.Sql): Promise<DashboardFinanceReadersDto> {
    const rows = await this.db.tx.$queryRaw<{ r: DashboardFinanceReadersDto }[]>(sql);
    return rows[0]!.r;
  }

  /** GET /settings/dashboard-finance-readers */
  get(): Promise<DashboardFinanceReadersDto> {
    return this.one(Prisma.sql`SELECT dashboard_finance_readers_state() AS r`);
  }

  /** PUT /settings/dashboard-finance-readers */
  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<DashboardFinanceReadersDto> {
    const b = parse(putBody, raw);
    await this.access.requireAdmin("settings", "edit");
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(
      Prisma.sql`SELECT admin_set_dashboard_finance_readers(${b.enabled}::boolean, ${b.role_codes}::text[], ${b.reason}::text, ${etag}::int) AS r`,
    );
  }
}
