import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { DashboardViewDefaultsDto, DashboardViewDefaultsService } from "./dashboard-view-defaults.service";

/** Contract `settings` (0.15.208, migration 0510): GET and PUT /settings/dashboard-view-defaults. */
@Controller("settings/dashboard-view-defaults")
export class DashboardViewDefaultsController {
  constructor(private readonly svc: DashboardViewDefaultsService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<DashboardViewDefaultsDto> {
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
  ): Promise<DashboardViewDefaultsDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
