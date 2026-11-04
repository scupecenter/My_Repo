import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DelayPeriodsService } from './delay-periods.service';

/** Delay attribution periods of a task (contract tag `dashboard`, 0.11.0, owner answer Q122; proposals and decisions 0.12.7, Q182). */
@Controller('tasks/:task_id/delay-periods')
export class DelayPeriodsController {
  constructor(private readonly periods: DelayPeriodsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Param('task_id') taskId: string) {
    return this.periods.list(auth, taskId);
  }

  @Post()
  @HttpCode(201)
  add(@Auth() auth: AuthContext, @Param('task_id') taskId: string, @Body() body: unknown) {
    return this.periods.add(auth, taskId, body);
  }

  @Post(':period_id/decision')
  @HttpCode(200)
  decide(@Auth() auth: AuthContext, @Param('task_id') taskId: string, @Param('period_id') periodId: string, @Body() body: unknown) {
    return this.periods.decide(auth, taskId, periodId, body);
  }

  @Post(':period_id/void')
  @HttpCode(200)
  void(@Auth() auth: AuthContext, @Param('task_id') taskId: string, @Param('period_id') periodId: string, @Body() body: unknown) {
    return this.periods.void(auth, taskId, periodId, body);
  }
}
