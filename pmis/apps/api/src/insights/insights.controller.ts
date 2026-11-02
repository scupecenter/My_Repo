import { Controller, Get, Param, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { InsightsService } from './insights.service';

@Controller()
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

  @Get('tasks/:id/time-in-state')
  timeInState(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.taskTimeInState(auth, id);
  }

  @Get('tasks/:id/blocked-by')
  blockedBy(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.blockedBy(auth, id);
  }

  @Get('reports/time-in-state')
  report(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.timeInStateReport(auth, q);
  }

  @Get('reports/workload')
  workload(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.workload(auth, q);
  }
}
