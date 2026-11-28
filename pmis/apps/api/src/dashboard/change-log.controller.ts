import { Controller, Get, Query } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { ChangeLogService } from "./change-log.service";

/** The change log of the Dashboard settings and the Goals settings (contract tag `settings`, 0.15.433, settings review gap 6). Read only. */
@Controller("settings/change-log")
export class ChangeLogController {
  constructor(private readonly svc: ChangeLogService) {}

  @Get()
  get(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.get(auth, q);
  }
}
