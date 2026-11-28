import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { ForecastMethodService } from "./forecast-method.service";

/** The method of the dashboard forecast (contract tag `settings`, 0.15.474, phase 5). */
@Controller("settings/dashboard/forecast-method")
export class ForecastMethodController {
  constructor(private readonly svc: ForecastMethodService) {}

  @Get()
  async get(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.get(auth);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put()
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
