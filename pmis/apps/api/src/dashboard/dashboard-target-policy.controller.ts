import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { DashboardTargetPolicyDto, DashboardTargetPolicyService } from "./dashboard-target-policy.service";

/** Contract `settings` (0.15.367, migration 0524): GET and PUT /settings/dashboard-target-policy. */
@Controller("settings/dashboard-target-policy")
export class DashboardTargetPolicyController {
  constructor(private readonly svc: DashboardTargetPolicyService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<DashboardTargetPolicyDto> {
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
  ): Promise<DashboardTargetPolicyDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
