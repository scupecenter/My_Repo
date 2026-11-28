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
    manual_override: z.boolean(),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export interface DashboardTargetPolicyDto {
  manual_override: boolean;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

/**
 * Settings, Dashboard: the target policy (migration 0524, contract 0.15.367, setting dashboard.target_policy). Off by default: the dashboard targets are
 * derived from the scope. On: the typed numbers of Settings > Dashboard apply where set (an exception). Every signed-in user reads it. Changing it needs a
 * System Admin or an all-regions delegate of settings edit, a reason, a step-up and If-Match; the database checks the right again and writes the audit row.
 */
@Injectable()
export class DashboardTargetPolicyService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  private async one(sql: Prisma.Sql): Promise<DashboardTargetPolicyDto> {
    const rows = await this.db.tx.$queryRaw<{ r: DashboardTargetPolicyDto }[]>(sql);
    return rows[0]!.r;
  }

  /** GET /settings/dashboard-target-policy */
  get(): Promise<DashboardTargetPolicyDto> {
    return this.one(Prisma.sql`SELECT dashboard_target_policy_state() AS r`);
  }

  /** PUT /settings/dashboard-target-policy */
  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<DashboardTargetPolicyDto> {
    const b = parse(putBody, raw);
    await this.access.requireAdmin("settings", "edit");
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(
      Prisma.sql`SELECT admin_set_dashboard_target_policy(${b.manual_override}::boolean, ${b.reason}::text, ${etag}::int) AS r`,
    );
  }
}
