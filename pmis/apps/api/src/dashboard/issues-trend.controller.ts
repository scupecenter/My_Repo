import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import { Auth } from "../auth/decorators";
import type { AuthContext } from "../auth/auth.types";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";

const querySchema = z.object({ weeks: z.coerce.number().int().min(4).max(52).default(12) }).strict();

/** Weekly trend of issues opened against closed (contract tag `dashboard`, 0.15.592). Needs dashboard.view; the issues are those of the caller's issues regions. */
@Controller("dashboard")
export class IssuesTrendController {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  @Get("issues-trend")
  async trend(@Auth() auth: AuthContext, @Query() raw: unknown) {
    await this.access.requireModuleView(auth, "dashboard");
    const q = parse(querySchema, raw);
    const scope = await this.access.regions("issues", "view");
    if (Array.isArray(scope) && scope.length === 0) return { weeks: q.weeks, as_of: null, available: false, items: [] };
    const r = await this.db.tx.$queryRaw<{ r: Record<string, unknown> }[]>(Prisma.sql`SELECT issues_weekly_trend(${scope}::int[], ${q.weeks}::int) AS r`);
    return { available: true, ...r[0]!.r };
  }
}
