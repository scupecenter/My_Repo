import { Controller, Get, Param, Query } from "@nestjs/common";
import { StageTimesService } from "./stage-times.service";

/** Time in stage (contract tag `insights`, 0.15.482). The session guard is global; the database checks the right and the regions. */
@Controller()
export class StageTimesController {
  constructor(private readonly svc: StageTimesService) {}

  @Get("sites/:siteId/stage-times")
  site(@Param("siteId") siteId: string) {
    return this.svc.site(siteId);
  }

  @Get("reports/stage-times")
  report(@Query() q: Record<string, unknown>) {
    return this.svc.report(q);
  }

  @Get("reports/site-compare")
  compare(@Query() q: Record<string, unknown>) {
    return this.svc.compare(q);
  }
}
