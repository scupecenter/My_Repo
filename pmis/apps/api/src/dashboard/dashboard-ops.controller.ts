import { Controller, Get, Header, Query } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { DashboardOpsService } from "./dashboard-ops.service";

/** The follow-up sections of the dashboard (contract tag `dashboard`, 0.15.96). */
@Controller()
export class DashboardOpsController {
  constructor(private readonly ops: DashboardOpsService) {}

  /** 0.15.96: procurement and materials (open PR/PO aging, receive rate, shortage per contractor). */
  @Get("dashboard/ops")
  @Header("Cache-Control", "no-store")
  dashboardOps(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.ops.get(auth, q);
  }
}
