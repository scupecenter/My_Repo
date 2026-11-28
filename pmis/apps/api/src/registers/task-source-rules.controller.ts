import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { TaskSourceRulesService } from './task-source-rules.service';

/** Automation item 4 (migration 0770): the task source rules of the registers, in Settings. */
@Controller()
export class TaskSourceRulesController {
  constructor(private readonly svc: TaskSourceRulesService) {}

  @Get('settings/task-source-rules')
  async list(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.list(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('settings/task-source-rules')
  async save(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.save(ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }
}
