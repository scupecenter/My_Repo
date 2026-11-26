import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { GoalsService } from "./goals.service";

/** Goals with automatic progress (contract tag `settings`, 0.15.99). */
@Controller()
export class GoalsController {
  constructor(private readonly svc: GoalsService) {}

  @Get("settings/goals")
  async get(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.get(auth);
    res.setHeader("ETag", etagHeader(r.version));
    return r;
  }

  @Put("settings/goals")
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

  @Get("goals/progress")
  progress(@Auth() auth: AuthContext) {
    return this.svc.progress(auth);
  }
}
