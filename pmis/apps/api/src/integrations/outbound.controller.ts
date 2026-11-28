import { Body, Controller, Get, Headers, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { OutboundService } from "./outbound.service";

/** Outbound notifications, admin Settings > Integrations (contract tag `settings`, 0.15.475, D8). */
@Controller("settings/integrations/outbound")
export class OutboundController {
  constructor(private readonly svc: OutboundService) {}

  @Get()
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.overview(auth);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put("enabled")
  async enabled(@Auth() auth: AuthContext, @Headers("if-match") ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.setEnabled(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Post("destinations")
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.svc.saveDestination(auth, undefined, body);
  }

  @Put("destinations/:id")
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.saveDestination(auth, id, body);
  }

  @Post("destinations/:id/archive")
  archive(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.archive(auth, id, body);
  }

  @Get("deliveries")
  deliveries(@Auth() auth: AuthContext) {
    return this.svc.deliveries(auth);
  }
}
