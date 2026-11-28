import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';
import { ReportsService } from './reports.service';

/** Report Center (contract 0.15.598): the ready report library and a run. Reads only, through the register screens' own read path. */
@Controller()
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('reports/library')
  library() {
    return this.svc.library();
  }

  @Post('reports/:key/run')
  run(@Auth() auth: AuthContext, @Param('key') key: string, @Body() body: unknown) {
    return this.svc.run(auth, key, body);
  }
}
