import { Body, Controller, Get, Headers, Param, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { SiteHealthService } from "./site-health.service";

/** Site health score (contract tag `dashboard`, 0.15.591). */
@Controller()
export class SiteHealthController {
  constructor(private readonly svc: SiteHealthService) {}

  @Get("dashboard/site-health")
  list(@Auth() auth: AuthContext, @Query() q: unknown) {
    return this.svc.list(auth, q);
  }

  @Get("dashboard/site-health/:site_id")
  detail(@Auth() auth: AuthContext, @Param("site_id") siteId: string) {
    return this.svc.detail(auth, siteId);
  }

  @Get("settings/dashboard/site-health-weights")
  async getWeights(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.getWeights(auth);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put("settings/dashboard/site-health-weights")
  async putWeights(@Auth() auth: AuthContext, @Headers("if-match") ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.putWeights(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }
}
