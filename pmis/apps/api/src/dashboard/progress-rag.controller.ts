import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { etagHeader } from "../common/etag";
import { ProgressRagService } from "./progress-rag.service";

/** The green and amber thresholds of the progress figures (contract tag `settings`, 0.15.432, settings review gap 5). */
@Controller("settings/dashboard/progress-rag")
export class ProgressRagController {
  constructor(private readonly svc: ProgressRagService) {}

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
