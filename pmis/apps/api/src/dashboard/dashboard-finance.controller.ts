import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { DashboardFinanceReadersDto, DashboardFinanceService } from "./dashboard-finance.service";

/** Contract `settings` (0.15.206, migration 0307): GET and PUT /settings/dashboard-finance-readers. */
@Controller("settings/dashboard-finance-readers")
export class DashboardFinanceController {
  constructor(private readonly svc: DashboardFinanceService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<DashboardFinanceReadersDto> {
    const r = await this.svc.get();
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put()
  async set(
    @Auth() auth: AuthContext,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DashboardFinanceReadersDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
