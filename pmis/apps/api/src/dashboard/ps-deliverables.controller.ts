import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { PsDeliverablesService } from "./ps-deliverables.service";

/** Which Project Status items read the Deliverables register, and in which mode (contract tag `settings`, 0.15.470, F4 follow-up). */
@Controller("settings/dashboard/ps-deliverables")
export class PsDeliverablesController {
  constructor(private readonly svc: PsDeliverablesService) {}

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
