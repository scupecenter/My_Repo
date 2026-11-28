import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { InsightsService } from "./insights.service";

@Controller()
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

  @Get("tasks/:id/time-in-state")
  timeInState(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.svc.taskTimeInState(auth, id);
  }

  @Get("tasks/:id/blocked-by")
  blockedBy(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.svc.blockedBy(auth, id);
  }

  @Get("reports/time-in-state")
  report(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.timeInStateReport(auth, q);
  }

  @Get("registers/:key/records/:id/time-in-state")
  recordTimeInState(
    @Auth() auth: AuthContext,
    @Param("key") key: string,
    @Param("id") id: string,
  ) {
    return this.svc.recordTimeInState(auth, key, id);
  }

  @Get("reports/state-durations")
  stateDurations(
    @Auth() auth: AuthContext,
    @Query() q: Record<string, unknown>,
  ) {
    return this.svc.stateDurationsReport(auth, q);
  }

  @Get("reports/workload")
  workload(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.workload(auth, q);
  }

  @Get("plan-freezes")
  planFreezes() {
    return this.svc.planFreezes();
  }

  @Post("plan-freezes")
  @HttpCode(201)
  createPlanFreeze(@Body() body: unknown) {
    return this.svc.createPlanFreeze(body);
  }

  @Delete("plan-freezes/:id")
  @HttpCode(204)
  async hidePlanFreeze(@Param("id") id: string): Promise<void> {
    await this.svc.hidePlanFreeze(id);
  }

  @Get("plan-freezes/:id/report")
  planFreezeReport(@Param("id") id: string, @Query() q: Record<string, unknown>) {
    return this.svc.planFreezeReport(id, q);
  }
}
