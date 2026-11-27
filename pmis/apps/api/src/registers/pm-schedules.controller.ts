import { Body, Controller, Get, Headers, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { PmSchedulesService } from "./pm-schedules.service";

/** Recurring preventive-maintenance schedules that create drafts only (contract tag `settings`, 0.15.161). */
@Controller()
export class PmSchedulesController {
  constructor(private readonly svc: PmSchedulesService) {}

  @Get("settings/pm-schedules")
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get(auth);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put("settings/pm-schedules")
  async put(@Auth() auth: AuthContext, @Headers("if-match") ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(auth, ifMatch, body);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Post("pm-schedules/:id/generate")
  generate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.svc.generate(auth, id);
  }
}
