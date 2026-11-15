import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { DashboardSettingsService } from "./dashboard-settings.service";

/** The global dashboard settings (contract tag `settings`, 0.15.24, F20). */
@Controller("settings")
export class DashboardSettingsController {
  constructor(private readonly svc: DashboardSettingsService) {}

  @Get("dashboard")
  async get(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.get(auth);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put("dashboard")
  async put(
    @Auth() auth: AuthContext,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.put(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
