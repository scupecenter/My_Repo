import { Controller, Get, Query } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { mapDbError } from "../common/db-errors";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({ from: day.optional(), to: day.optional() }).strict();

/**
 * Warehouse stock card of the dashboard (contract tag `dashboard`, 0.15.593): per item group the quantities received, issued and returned in a period and the
 * stock on hand and available today. Needs dashboard.view and warehouse.view; the issues and returns of sites are limited to the caller's warehouse regions.
 */
@Controller("dashboard")
export class WarehouseStockCardController {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  @Get("warehouse-stock")
  async summary(@Auth() auth: AuthContext, @Query() raw: unknown) {
    await this.access.requireModuleView(auth, "dashboard");
    const regs = await this.access.requireRegions("warehouse", "view");
    const q = parse(querySchema, raw);
    try {
      const r = await this.db.tx.$queryRaw<{ r: Record<string, unknown> }[]>(
        Prisma.sql`SELECT wh_stock_summary(${q.from ?? null}::date, ${q.to ?? null}::date, ${regs}::int[]) AS r`,
      );
      return r[0]!.r;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }
}
